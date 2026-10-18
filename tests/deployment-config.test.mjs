import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { PocketBackendClient } from '../backend.mjs';

const root = new URL('../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, root), 'utf8');
}

test('production Worker config keeps same-origin assets, API routing, and D1 binding', async () => {
  const config = JSON.parse(await read('wrangler.jsonc'));
  assert.equal(config.name, 'pocket-archive');
  assert.equal(config.main, 'worker/src/index.mjs');
  assert.deepEqual(config.assets, {
    directory: '.',
    binding: 'ASSETS',
    run_worker_first: ['/api/*']
  });
  assert.deepEqual(config.d1_databases, [{
    binding: 'DB',
    database_name: 'pocket-archive',
    database_id: '8db0c270-eae9-4da2-9347-e0ae5219ca8f',
    migrations_dir: 'worker/migrations'
  }]);

  const origin = new URL(config.vars.APP_ORIGIN);
  assert.equal(origin.href, 'https://pocket-archive.goma555416.workers.dev/');
  assert.equal(origin.protocol, 'https:');
  assert.equal(origin.pathname, '/');
});

test('production deployment includes the complete ordered D1 migration set', async () => {
  const migrationDirectory = new URL('worker/migrations/', root);
  const migrations = (await readdir(migrationDirectory)).filter(name => name.endsWith('.sql')).sort();
  assert.deepEqual(migrations, [
    '0001_auth.sql',
    '0002_capture.sql',
    '0003_owner_session_security.sql'
  ]);
  for (const migration of migrations) {
    const sql = await read(`worker/migrations/${migration}`);
    assert.match(sql, /PRAGMA foreign_keys = ON;/);
  }
});

test('OAuth callback, frontend API, manifest, and Service Worker remain same-origin', async () => {
  const [worker, backend, serviceWorker, manifestText] = await Promise.all([
    read('worker/src/index.mjs'),
    read('backend.mjs'),
    read('sw.js'),
    read('manifest.webmanifest')
  ]);
  assert.match(worker, /expectedOrigin\(request, env\)\}\/api\/auth\/callback/);
  assert.match(backend, /this\.location\.assign\(`\/api\/auth\/start/);
  assert.match(backend, /this\.request\('\/api\/session'/);
  assert.match(serviceWorker, /event\.request\.url\)\.origin !== self\.location\.origin/);
  assert.match(serviceWorker, /pathname\.includes\('\/api\/'\)/);
  const manifest = JSON.parse(manifestText);
  assert.equal(manifest.start_url, './');
  assert.equal(manifest.scope, './');
});

test('legacy GitHub Pages remains deployable and falls back when no Worker API exists', async () => {
  const workflow = await read('.github/workflows/pages.yml');
  assert.match(workflow, /push:\s*\n\s*branches: \[main\]/);
  assert.match(workflow, /uses: actions\/upload-pages-artifact@v3/);
  assert.doesNotMatch(workflow, /wrangler deploy(?! --dry-run)/);

  const client = new PocketBackendClient({
    fetchImpl: async () => new Response('<!doctype html><title>Not Found</title>', {
      status: 404,
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    })
  });
  assert.deepEqual(await client.detectSession(), { available: false, session: null });
});
