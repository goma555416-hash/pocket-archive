import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const existingPath = fileURLToPath(new URL('../.dev.vars.preflight-test', import.meta.url));
const validator = fileURLToPath(new URL('../scripts/validate-static-assets.mjs', import.meta.url));
const originalContent = 'Existing non-secret collision fixture; the validator must preserve this content.\n';

test('Static Assets validator preserves a pre-existing colliding file when setup fails', async () => {
  let fixtureCreated = false;
  try {
    await writeFile(existingPath, originalContent, { flag: 'wx' });
    fixtureCreated = true;
    const result = spawnSync(process.execPath, [validator], {
      cwd: root,
      encoding: 'utf8',
      timeout: 10_000
    });
    assert.notEqual(result.status, 0, 'validator must fail instead of overwriting an existing test path');
    assert.match(`${result.stdout}\n${result.stderr}`, /refusing to overwrite existing test path/);
    assert.equal(await readFile(existingPath, 'utf8'), originalContent, 'pre-existing file must not be deleted or changed');
  } finally {
    if (fixtureCreated) await rm(existingPath, { force: true });
  }
});
