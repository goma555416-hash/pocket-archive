// Runs in Cloudflare's actual workerd runtime (via Wrangler's Miniflare),
// not Node's Fetch polyfill. Uses only synthetic metadata: no outbound network.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { Miniflare } from 'miniflare';

const root = fileURLToPath(new URL('../', import.meta.url));
const sourcePath = join(root, 'social-metadata.mjs');
const fixturePath = join(root, '__social_worker_runtime_fixture__.mjs');
const fixture = `
import { fetchSocialMediaMetadata } from './social-metadata.mjs';

export default {
  async fetch(request) {
    const shouldRedirect = new URL(request.url).pathname === '/redirect';
    const syntheticFetch = async (endpoint, options) => {
      // This is the genuine Cloudflare workerd Request constructor. It threw
      // TypeError for redirect:'error' in v2.3.6 before outbound HTTP occurred.
      const constructed = new Request(endpoint, options);
      if (constructed.redirect !== 'manual') {
        throw new Error('Expected manual redirect behavior');
      }
      if (new URL(constructed.url).origin !== 'https://www.youtube.com') {
        throw new Error('Unexpected upstream host');
      }
      if (shouldRedirect) {
        return new Response(null, { status: 302,
          headers: { Location: 'https://untrusted.example/redirect' } });
      }
      return Response.json({
        provider_name: 'YouTube', title: 'Synthetic Video',
        author_name: 'Fixture Author',
        thumbnail_url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg'
      });
    };
    try {
      const metadata = await fetchSocialMediaMetadata(
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        { fetchImpl: syntheticFetch }
      );
      return Response.json({ ok: true, metadata });
    } catch (error) {
      return Response.json({ ok: false, code: error.code || '',
        message: error.message }, { status: Number(error.status || 500) });
    }
  }
};
`;

// Miniflare v5 (as installed transitively by Wrangler v4.151+) requires
// the per-Worker module and compatibility options nested in "workers".
const mf = new Miniflare({
  workers: [{
    config: {
      name: 'social-runtime-fixture',
      compatibilityDate: '2026-10-17',
      modulesRoot: root,
      modules: [
        { type: 'ESModule', path: fixturePath, contents: fixture },
        { type: 'ESModule', path: sourcePath, contents: await readFile(sourcePath, 'utf8') }
      ]
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

  process.stdout.write('Cloudflare workerd social metadata: valid RequestInit + 302 redirect block passed.\\n');
} finally {
  await mf.dispose();
}
