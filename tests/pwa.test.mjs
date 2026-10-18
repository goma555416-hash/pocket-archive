import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';

test('PWA manifest 是有效 JSON、維持品牌且不含 Android Share Target', async () => {
  const manifest = JSON.parse(await readFile(new URL('../manifest.webmanifest', import.meta.url), 'utf8'));
  assert.equal(manifest.short_name, 'Pocket Archive');
  assert.equal(manifest.display, 'standalone');
  assert.equal('share_target' in manifest, false);
  assert.equal(manifest.icons.some(icon => icon.sizes === '192x192'), true);
  assert.equal(manifest.icons.some(icon => icon.sizes === '512x512'), true);
});

test('Service Worker 離線清單中的本機資源都存在', async () => {
  const source = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
  const list = source.match(/const RESOURCES = \[(.*?)\];/s)?.[1] || '';
  const resources = [...list.matchAll(/'\.\/(.*?)'/g)].map(match => match[1] || 'index.html');
  assert.ok(resources.includes('db.mjs'));
  assert.ok(resources.includes('archive.mjs'));
  assert.ok(resources.includes('drive.mjs'));
  assert.ok(resources.includes('sync.mjs'));
  assert.ok(resources.includes('cloud.mjs'));
  await Promise.all(resources.filter(Boolean).map(file => access(resolve(new URL('..', import.meta.url).pathname, file))));
});

test('A3 icon 所有宣告尺寸檔案存在', async () => {
  await Promise.all(['icon.svg', 'icon-180.png', 'icon-192.png', 'icon-512.png', 'icon-1024.png'].map(file => access(new URL(`../icons/${file}`, import.meta.url))));
});
