// Shared by scripts/delivery-gate.mjs (writes the stamp after a full pass) and
// scripts/hooks/require-verify.mjs (checks it before git push / gh pr create).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const git = (args, env) => execFileSync('git', args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

// Tree hash of the working directory content (respects .gitignore), so that a
// commit of exactly this content can be matched later.
export function workingTreeHash() {
  const dir = mkdtempSync(join(tmpdir(), 'pa-gate-'));
  const env = { ...process.env, GIT_INDEX_FILE: join(dir, 'index') };
  try {
    git(['read-tree', 'HEAD'], env);
    git(['add', '-A'], env);
    return git(['write-tree'], env);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

export const headTreeHash = () => git(['rev-parse', 'HEAD^{tree}']);
const stampPath = () => git(['rev-parse', '--git-path', 'pa-delivery-verified']);
export function writeVerifiedStamp() { writeFileSync(stampPath(), `${workingTreeHash()}\n`); }
export function readVerifiedStamp() { try { return readFileSync(stampPath(), 'utf8').trim(); } catch { return ''; } }
