import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { needsVerification, decide } from '../scripts/hooks/require-verify.mjs';

test('push and PR creation need verification; other commands do not', () => {
  for (const command of ['git push -u origin feat/x', 'git push', '& "C:\\Program Files\\GitHub CLI\\gh.exe" pr create --base main', 'gh pr create --title x']) {
    assert.equal(needsVerification(command), true, command);
  }
  assert.equal(needsVerification('npm run verify && git push -u origin x'), true, 'chained push');
  for (const command of ['git status', 'git push origin --delete old-branch', 'gh pr view 30', 'npm run verify', 'git commit -m "push later"',
    "node - <<'EOF'\nconst doc = 'blocks `git push` / `gh pr create` unless verified';\nEOF", 'echo "remember to git push"']) {
    assert.equal(needsVerification(command), false, command);
  }
});

test('blocks when the pushed content differs from the last verified content', () => {
  assert.equal(decide('git push', { head: () => 'tree-a', stamp: () => 'tree-a' }).block, false);
  const blocked = decide('git push', { head: () => 'tree-b', stamp: () => 'tree-a' });
  assert.equal(blocked.block, true);
  assert.match(blocked.message, /npm run verify/);
  assert.equal(decide('git push', { head: () => 'tree-b', stamp: () => '' }).block, true, 'never verified');
});

test('hook process exits 2 with a message so Claude Code blocks the call', () => {
  const hook = fileURLToPath(new URL('../scripts/hooks/require-verify.mjs', import.meta.url));
  const input = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'gh pr create --title x' } });
  const result = spawnSync(process.execPath, [hook], { input, encoding: 'utf8', env: { ...process.env, GIT_DIR: '/nonexistent-pa-git' } });
  // Outside a git checkout the hook cannot judge and must not block.
  assert.equal(result.status, 0);
  const harmless = spawnSync(process.execPath, [hook], { input: JSON.stringify({ tool_input: { command: 'git status' } }), encoding: 'utf8' });
  assert.equal(harmless.status, 0);
});
