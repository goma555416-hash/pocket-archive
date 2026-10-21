import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { win32 } from 'node:path';

export async function findChromium({ platform = process.platform, env = process.env, accessible = path => access(path, constants.X_OK) } = {}) {
  const explicit = env.CHROMIUM_PATH?.trim();
  let candidates;
  if (explicit) candidates = [explicit];
  else if (platform === 'win32') {
    const roots = [env.ProgramFiles || env.PROGRAMFILES, env['ProgramFiles(x86)'] || env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean);
    candidates = roots.flatMap(root => [
      win32.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      win32.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
    ]);
  } else candidates = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/opt/google/chrome/chrome'];
  for (const path of [...new Set(candidates)]) {
    try { await accessible(path); return path; } catch { /* try the next installed browser */ }
  }
  throw new Error(explicit
    ? 'CHROMIUM_PATH 指向的瀏覽器不存在或無法執行；請指定 Chrome／Edge／Chromium 執行檔完整路徑（值不含額外引號）。'
    : '找不到 Chrome／Edge／Chromium；請安裝瀏覽器，或設定 CHROMIUM_PATH 為執行檔完整路徑。');
}
