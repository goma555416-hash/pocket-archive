import test from 'node:test';
import assert from 'node:assert/strict';
import { findChromium } from './helpers/chromium.mjs';

function availableOnly(...installed) {
  return async path => { if (!installed.includes(path)) throw new Error('not installed'); };
}

test('CHROMIUM_PATH 優先且保留 Windows 空白、中文路徑，不經 shell', async () => {
  const path = 'C:\\Users\\測試 使用者\\瀏覽器\\chrome.exe';
  assert.equal(await findChromium({ platform: 'win32', env: { CHROMIUM_PATH: path, ProgramFiles: 'C:\\Program Files' }, accessible: availableOnly(path) }), path);
});

test('明確指定無效瀏覽器時提示修正，不悄悄改用其他安裝', async () => {
  const attempted = [];
  await assert.rejects(findChromium({ platform: 'win32', env: { CHROMIUM_PATH: 'C:\\missing.exe', ProgramFiles: 'C:\\Program Files' }, accessible: async path => { attempted.push(path); throw new Error('missing'); } }), /CHROMIUM_PATH/);
  assert.deepEqual(attempted, ['C:\\missing.exe']);
});

for (const [label, env, installed] of [
  ['Windows 系統 Chrome', { ProgramFiles: 'C:\\Program Files' }, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'],
  ['Windows 32 位 Edge', { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)' }, 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'],
  ['Windows 個人 Chrome', { LOCALAPPDATA: 'C:\\Users\\測試 使用者\\AppData\\Local' }, 'C:\\Users\\測試 使用者\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe'],
  ['Windows 大寫環境變數', { PROGRAMFILES: 'D:\\Program Files' }, 'D:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe']
]) test(`${label} 可被自動找到（模擬安裝）`, async () => {
  assert.equal(await findChromium({ platform: 'win32', env, accessible: availableOnly(installed) }), installed);
});

test('Linux 保留 Chromium 自動尋找與 CI 的 CHROMIUM_PATH', async () => {
  assert.equal(await findChromium({ platform: 'linux', env: {}, accessible: availableOnly('/usr/bin/chromium') }), '/usr/bin/chromium');
  assert.equal(await findChromium({ platform: 'linux', env: { CHROMIUM_PATH: '/usr/bin/google-chrome' }, accessible: availableOnly('/usr/bin/google-chrome') }), '/usr/bin/google-chrome');
});

test('沒有已安裝瀏覽器時提供可操作的提示', async () => {
  await assert.rejects(findChromium({ platform: 'win32', env: {}, accessible: availableOnly() }), /安裝瀏覽器.*CHROMIUM_PATH/);
});
