// Test the real Cloudflare workerd Request runtime through Wrangler's
// Miniflare v5. All provider responses are synthetic, with no external IO.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';

const fixturePath = fileURLToPath(new URL('../tests/social-workerd-fixture.mjs', import.meta.url));
const sourcePath = fileURLToPath(new URL('../social-metadata.mjs', import.meta.url));
const mf = new Miniflare({
  workers: [{
    config: {
      name: 'social-runtime-fixture',
      compatibilityDate: '2026-10-17',
      manifest: {
        mainModule: 'tests/social-workerd-fixture.mjs',
        modules: {
          'tests/social-workerd-fixture.mjs': {
            type: 'esm', contents: await readFile(fixturePath, 'utf8')
          },
          'social-metadata.mjs': {
            type: 'esm', contents: await readFile(sourcePath, 'utf8')
          }
        }
      }
    }
  }]
});

try {
  const success = await mf.dispatchFetch('http://localhost/');
  assert.equal(success.status, 200, await success.clone().text());
  const data = await success.json();
  assert.equal(data.ok, true);
  assert.equal(data.metadata.title, 'Synthetic Video');
  assert.equal(data.metadata.contentRead, false);

  const redirected = await mf.dispatchFetch('http://localhost/redirect');
  assert.equal(redirected.status, 502, await redirected.clone().text());
  const blocked = await redirected.json();
  assert.equal(blocked.code, 'social_redirect_rejected');

  process.stdout.write('Cloudflare workerd social metadata: valid RequestInit + 302 redirect block passed.\n');
} finally {
  await mf.dispose();
}
