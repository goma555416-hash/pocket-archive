import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rmdir, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const wrangler = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
const sentinel = 'Pocket Archive static asset exclusion test — not a real secret.\n';
const publicSentinel = 'asset-preflight-public.txt';
const privateSentinels = [
  '.dev.vars.preflight-test',
  '.env.preflight-test',
  'private-data/preflight-private.json',
  'exports/pocket-archive-backup-preflight.json',
  '.wrangler/preflight-private.json',
  'pocket-archive-backup-preflight.json',
  'pocket-archive-backup-preflight.zip',
  'pocket-archive-inbox-preflight.json',
  'pocket-archive-inbox-preflight.zip',
  'pocket-archive-migration-preflight.zip',
  'organized-preflight.json',
  'preflight-private.pem',
  'preflight-private.key',
  'preflight-local.sqlite',
  'preflight-debug.log',
  '.agents/skills/preflight-private.json'
];
const publicAssets = [
  'index.html',
  'styles.css',
  'theme.css',
  'app.js',
  'lib.mjs',
  'content-model.mjs',
  'content-evidence.mjs',
  'image-viewer.mjs',
  'ai-launch.mjs',
  'capture-client.mjs',
  'social-metadata.mjs',
  'sw.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  publicSentinel
];

async function exists(target) {
  try { await access(target); return true; } catch { return false; }
}

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function waitForServer(origin, child, logs) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Wrangler dev exited early (${child.exitCode})\n${logs()}`);
    try {
      const response = await fetch(`${origin}/index.html`);
      if (response.ok) return;
    } catch { /* server is still starting */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Wrangler dev did not become ready\n${logs()}`);
}

const createdDirectories = [];
const plannedFiles = [...privateSentinels, publicSentinel];
const createdFiles = [];
let child;
let temporaryConfig;

try {
  for (const relativePath of plannedFiles) {
    const absolutePath = path.join(root, relativePath);
    assert.equal(await exists(absolutePath), false, `refusing to overwrite existing test path: ${relativePath}`);
    const parent = path.dirname(absolutePath);
    if (!(await exists(parent))) {
      await mkdir(parent, { recursive: true });
      createdDirectories.push(parent);
    }
    await writeFile(absolutePath, sentinel, { flag: 'wx' });
    createdFiles.push(relativePath);
  }

  for (const relativePath of privateSentinels) {
    const result = spawnSync('git', ['check-ignore', '--quiet', '--', relativePath], { cwd: root });
    assert.equal(result.status, 0, `${relativePath} must be ignored by Git`);
  }
  assert.notEqual(spawnSync('git', ['check-ignore', '--quiet', '--', publicSentinel], { cwd: root }).status, 0, `${publicSentinel} must remain public`);

  temporaryConfig = await mkdtemp(path.join(os.tmpdir(), 'pocket-archive-assets-'));
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  let output = '';
  child = spawn(process.execPath, [wrangler, 'dev', '--local', '--ip', '127.0.0.1', '--port', String(port)], {
    cwd: root,
    env: { ...process.env, XDG_CONFIG_HOME: temporaryConfig, WRANGLER_SEND_METRICS: 'false' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const appendOutput = chunk => { output = `${output}${chunk}`.slice(-16_000); };
  child.stdout.on('data', appendOutput);
  child.stderr.on('data', appendOutput);
  await waitForServer(origin, child, () => output);

  for (const relativePath of publicAssets) {
    const response = await fetch(`${origin}/${relativePath}`);
    assert.equal(response.status, 200, `${relativePath} must remain deployable`);
  }
  assert.equal(await (await fetch(`${origin}/${publicSentinel}`)).text(), sentinel);

  for (const relativePath of [...privateSentinels, 'skills-lock.json', '.agents/skills/ui-ux-pro-max/data/ux-guidelines.csv']) {
    const response = await fetch(`${origin}/${relativePath}`);
    assert.equal(response.status, 404, `${relativePath} must be excluded from Static Assets`);
  }

  const config = JSON.parse(await readFile(path.join(root, 'wrangler.jsonc'), 'utf8'));
  assert.equal(config.assets.directory, '.', 'asset validation assumes the current repository-root assets directory');
  console.log(`Static Assets preflight passed: ${publicAssets.length} public files served; ${privateSentinels.length} private sentinels excluded.`);
} finally {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    const stopped = await Promise.race([
      new Promise(resolve => child.once('exit', () => resolve(true))),
      new Promise(resolve => setTimeout(() => resolve(false), 5_000))
    ]);
    if (!stopped && child.exitCode === null) child.kill('SIGKILL');
  }
  for (const relativePath of [...createdFiles].reverse()) await rm(path.join(root, relativePath), { force: true });
  for (const directory of createdDirectories.reverse()) {
    try { await rmdir(directory); } catch { /* preserve directories that are no longer empty */ }
  }
  if (temporaryConfig) await rm(temporaryConfig, { recursive: true, force: true });
}
