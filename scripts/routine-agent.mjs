#!/usr/bin/env node
// Helper for the Claude cloud routine (see CLAUDE-ROUTINE.md). Talks to the
// Pocket Archive Worker agent API.
//
// Credential: in the Claude cloud environment the agent token is a *network
// secret* (Bearer, host = the backend). Anthropic's agent proxy adds the
// Authorization header after the request leaves the VM, so the token is never
// visible here and this script sends no Authorization header of its own.
// PA_AGENT_TOKEN is only an optional fallback for local testing; it is never
// printed or written to disk. PA_BACKEND_ORIGIN optionally overrides the
// default backend.
//
//   node scripts/routine-agent.mjs job    <exportId> <attempt>
//   node scripts/routine-agent.mjs inbox  <exportId> <attempt> <outPath>
//   node scripts/routine-agent.mjs submit <exportId> <attempt> <organizedPath>
//   node scripts/routine-agent.mjs fail   <exportId> <attempt> <code> <message>
import { createHash } from 'node:crypto';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';

const EXPORT_ID = /^export-[A-Za-z0-9._:-]{1,110}$/;
export const DEFAULT_BACKEND_ORIGIN = 'https://pocket-archive.goma555416.workers.dev';
const STATUS_MARKER = '\n__PA_HTTP_STATUS__';

function line(stream, text) { stream.write(`${text}\n`); }

function proxyConfigured(env) { return Boolean(env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy); }

// Network secrets are attached by the sandbox's egress proxy. Node's built-in
// fetch ignores HTTPS_PROXY, so with a proxy configured we go through curl,
// which honours the proxy settings and the sandbox CA.
export function pickTransport(env) { return proxyConfigured(env) ? 'curl' : 'fetch'; }

export function curlArgs(url, init = {}) {
  const args = ['-sS', '-X', (init.method || 'GET').toUpperCase(), '-o', '-', '-w', `${STATUS_MARKER}%{http_code}`];
  for (const [name, value] of Object.entries(init.headers || {})) args.push('-H', `${name}: ${value}`);
  if (init.body !== undefined && init.body !== null) args.push('--data-binary', '@-');
  args.push(url);
  return args;
}

export function curlFetch(url, init = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('curl', curlArgs(url, init), { stdio: ['pipe', 'pipe', 'pipe'] });
    const out = []; const err = [];
    child.stdout.on('data', chunk => out.push(chunk));
    child.stderr.on('data', chunk => err.push(chunk));
    child.on('error', reject);
    child.on('close', code => {
      const buffer = Buffer.concat(out);
      const marker = buffer.lastIndexOf(Buffer.from(STATUS_MARKER));
      if (code !== 0 || marker < 0) { reject(new Error(`curl 失敗（${code}）：${Buffer.concat(err).toString().trim().slice(0, 200)}`)); return; }
      const status = Number(buffer.subarray(marker + STATUS_MARKER.length).toString().trim());
      resolvePromise(new Response(status === 204 ? null : buffer.subarray(0, marker), { status }));
    });
    if (init.body !== undefined && init.body !== null) child.stdin.end(init.body); else child.stdin.end();
  });
}

function backendOrigin(env) { return (env.PA_BACKEND_ORIGIN || DEFAULT_BACKEND_ORIGIN).replace(/\/+$/, ''); }

async function api(fetchImpl, env, path, init = {}) {
  const headers = { ...(init.headers || {}) };
  if (env.PA_AGENT_TOKEN) headers.Authorization = `Bearer ${env.PA_AGENT_TOKEN}`;
  return fetchImpl(`${backendOrigin(env)}${path}`, { ...init, headers });
}

async function errorText(response) {
  const data = await response.json().catch(() => ({}));
  return `${data?.error?.code || `http_${response.status}`}: ${data?.error?.message || '後端要求失敗'}`;
}

export async function runAgentCommand(argv, { env = process.env, fetchImpl, stdout = process.stdout, stderr = process.stderr } = {}) {
  const [command, exportId, attemptText, ...rest] = argv;
  if (!fetchImpl) fetchImpl = pickTransport(env) === 'curl' ? curlFetch : fetch;
  const baseErrorText = errorText;
  // On auth failures, add safe diagnostics (never values) to help setup.
  const errorTextWithHints = async response => {
    const text = await baseErrorText(response);
    return response.status === 401 ? `${text}（transport=${pickTransport(env)}, proxy_env=${proxyConfigured(env) ? 'yes' : 'no'}）` : text;
  };
  try {
    if (!/^https:\/\//.test(backendOrigin(env))) { line(stderr, 'PA_BACKEND_ORIGIN 必須是 https:// 網址'); return 2; }
    if (!['job', 'inbox', 'submit', 'fail'].includes(command)) { line(stderr, '用法：job|inbox|submit|fail <exportId> <attempt> ...'); return 2; }
    if (!EXPORT_ID.test(exportId || '')) { line(stderr, 'exportId 無效'); return 2; }
    const attempt = Number(attemptText);
    if (!Number.isInteger(attempt) || attempt < 1) { line(stderr, 'attempt 必須是正整數'); return 2; }
    const base = `/api/ai/agent/jobs/${encodeURIComponent(exportId)}`;
    const query = `?attempt=${attempt}`;

    if (command === 'job') {
      const response = await api(fetchImpl, env, `${base}${query}`);
      if (!response.ok) { line(stderr, await errorTextWithHints(response)); return 1; }
      line(stdout, JSON.stringify((await response.json()).job, null, 2));
      return 0;
    }
    if (command === 'inbox') {
      const [outPath] = rest;
      if (!outPath) { line(stderr, '需要輸出路徑'); return 2; }
      const info = await api(fetchImpl, env, `${base}${query}`);
      if (!info.ok) { line(stderr, await errorTextWithHints(info)); return 1; }
      const expected = (await info.json()).job?.inboxSha256;
      const response = await api(fetchImpl, env, `${base}/inbox${query}`);
      if (!response.ok) { line(stderr, await errorTextWithHints(response)); return 1; }
      const bytes = Buffer.from(await response.arrayBuffer());
      await writeFile(outPath, bytes);
      const actual = createHash('sha256').update(bytes).digest('hex');
      if (!expected || actual !== expected) {
        await rm(outPath, { force: true });
        line(stderr, 'inbox SHA-256 與 App 登記的不符；已刪除下載檔，請回報 fail');
        return 1;
      }
      line(stdout, `已下載 inbox（${bytes.length} bytes，SHA-256 相符）`);
      return 0;
    }
    if (command === 'submit') {
      const [organizedPath] = rest;
      if (!organizedPath) { line(stderr, '需要 organized.json 路徑'); return 2; }
      const body = await readFile(organizedPath, 'utf8');
      const response = await api(fetchImpl, env, `${base}/result${query}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body });
      if (!response.ok) { line(stderr, await errorTextWithHints(response)); return 1; }
      const data = await response.json();
      line(stdout, `已交回結果，工作狀態：${data.job?.status}`);
      return 0;
    }
    const [code, ...message] = rest;
    const response = await api(fetchImpl, env, `${base}/fail${query}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: code || 'agent_reported', message: message.join(' ').slice(0, 300) }) });
    if (!response.ok) { line(stderr, await errorTextWithHints(response)); return 1; }
    line(stdout, '已回報失敗');
    return 0;
  } catch (error) {
    line(stderr, `執行失敗：${error.message}`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = await runAgentCommand(process.argv.slice(2));
}
