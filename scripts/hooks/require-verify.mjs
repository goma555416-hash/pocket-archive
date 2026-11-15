#!/usr/bin/env node
// Claude Code PreToolUse hook (see .claude/settings.json). Blocks `git push`
// and `gh pr create` unless the committed content (HEAD tree) is exactly what
// last passed `npm run verify` with level AUTOMATED. Exit code 2 = block; the
// message goes back to Claude. Pushes that only delete a branch are allowed.
import { headTreeHash, readVerifiedStamp } from './verified-tree.mjs';

// Only an actual command counts: each line / chained segment is checked from
// its start, so the words appearing inside a heredoc, string or doc text do not.
export function needsVerification(command) {
  const segments = String(command || '').split(/\r?\n|&&|\|\||;|\|/);
  return segments.some(raw => {
    const segment = raw.trim().replace(/^&\s*/, '');
    if (/^git\s+(?:-C\s+\S+\s+)?push\b/.test(segment)) return !/--delete\b|\s:\S/.test(segment);
    return /^(?:"[^"]*gh(?:\.exe)?"|'[^']*gh(?:\.exe)?'|\S*gh(?:\.exe)?)\s+pr\s+create\b/.test(segment);
  });
}

export function decide(command, { head = headTreeHash, stamp = readVerifiedStamp } = {}) {
  if (!needsVerification(command)) return { block: false };
  let current = '';
  try { current = head(); } catch { return { block: false }; }
  if (current && current === stamp()) return { block: false };
  return {
    block: true,
    message: '交付門檻：目前要推送的內容尚未通過 `npm run verify`（或驗證後又有變更）。' +
      '請先執行 `npm run verify`，看到「交付狀態：AUTOMATED」且工作目錄內容與要推送的 commit 一致後再推送；' +
      '若有失敗，修正並重測，不要略過。'
  };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  let input = '';
  process.stdin.on('data', chunk => { input += chunk; });
  process.stdin.on('end', () => {
    let command = '';
    try { command = JSON.parse(input)?.tool_input?.command || ''; } catch { /* not a tool call */ }
    const result = decide(command);
    if (result.block) { process.stderr.write(`${result.message}\n`); process.exit(2); }
  });
}
