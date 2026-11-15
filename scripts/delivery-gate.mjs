#!/usr/bin/env node
// Delivery gate: runs every automated check and states which delivery level
// was actually reached. A skipped or unexecuted check never counts as passed.
//   npm run verify
// Levels:
//   BLOCKED      已知存在阻斷性問題（有測試失敗）
//   PARTIAL      僅通過單元／整合測試（核心流程或瀏覽器 E2E 未執行）
//   AUTOMATED    已通過完整自動驗收（仍需列出尚未真實操作驗證的項目）
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { writeVerifiedStamp } from './hooks/verified-tree.mjs';

// Things no automated check here can prove; always reported, never "passed".
const NOT_AUTOMATED = [
  '真實 Claude 雲端任務（claude.ai routine）實際觸發與分類判斷（自動測試的分類是固定規則模擬，不代表 Claude 的判斷）',
  'iPhone Safari／主畫面 App 實機操作',
  '正式 Cloudflare Worker 是否已部署為目前版本（合併後需 npx wrangler deploy）'
];

function runStep(name, args, env = {}) {
  return new Promise(resolve => {
    const started = Date.now(); let output = '';
    const child = spawn(process.execPath, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.on('close', code => {
      const count = label => Number(new RegExp(`^ℹ ${label} (\\d+)`, 'm').exec(output)?.[1] || 0);
      resolve({ name, code, output, seconds: Math.round((Date.now() - started) / 1000), pass: count('pass'), fail: count('fail'), skipped: count('skipped') + count('todo') });
    });
  });
}

const testFiles = readdirSync('tests').filter(name => name.endsWith('.test.mjs')).map(name => `tests/${name}`);
const steps = [
  await runStep('單元／整合測試', ['--test', ...testFiles.filter(f => !f.endsWith('cloud-flow.test.mjs'))]),
  await runStep('核心流程：雲端整理管線（模擬沙盒代理；分類為固定規則模擬）', ['--test', 'tests/cloud-flow.test.mjs'], { PA_REQUIRE_FLOW: '1' }),
  await runStep('靜態資源檢查', ['scripts/validate-static-assets.mjs']),
  await runStep('瀏覽器 E2E（App 實際操作）', ['tests/e2e.mjs'])
];

let blocked = false; let partial = false;
for (const step of steps) {
  const failed = step.code !== 0 || step.fail > 0;
  const skipped = !failed && step.skipped > 0;
  blocked ||= failed; partial ||= skipped;
  const mark = failed ? '✗ 失敗' : skipped ? `△ 有 ${step.skipped} 項未執行` : '✓ 通過';
  process.stdout.write(`${mark}  ${step.name}（${step.seconds}s${step.pass ? `，${step.pass} 項` : ''}）\n`);
  if (failed) process.stdout.write(`${step.output.split('\n').filter(line => /✖|Error|錯誤|失敗|not ok/.test(line)).slice(0, 12).join('\n')}\n`);
}

const level = blocked ? 'BLOCKED：已知存在阻斷性問題，不得標記為完成'
  : partial ? 'PARTIAL：僅通過單元／整合測試，有項目未執行，不得宣稱完整驗收'
  : 'AUTOMATED：已通過完整自動驗收';
process.stdout.write(`\n交付狀態：${level}\n尚未完成真實操作驗證（需人工或部署後確認）：\n${NOT_AUTOMATED.map(item => `  - ${item}`).join('\n')}\n`);
if (!blocked && !partial) {
  // Lets the Claude Code push/PR hook confirm this exact content was verified.
  try { writeVerifiedStamp(); } catch { /* not a git checkout */ }
}
process.exitCode = blocked || partial ? 1 : 0;
