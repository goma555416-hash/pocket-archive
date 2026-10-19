# Pocket Archive v2.3 — Issue #10 驗證（2026-10-19）

基線 `main`：`2c2982504b09ce704916e9bb516ddbb12e0d744d`（以 GitHub connector 確認與本機相同）。全部資料為合成／匿名 fixture，未存取 Notion、真實 Drive／D1、Cloudflare Secret 或部署。

## 本機已執行

- 基線 `npm test`：12 個測試檔通過，語法檢查通過。
- v2.3 `npm test`：13 個測試檔通過，含新增模組語法檢查。
- `node --test --test-isolation=none tests/*.test.mjs`：72 cases，72 pass、0 fail、0 skip（Node 24.19.0；含 SQLite 真實 SQL 整合）。
- `npm run test:security`：4 個測試檔通過；新增捷徑圖片、格式、完整性、配額、租約版本與清理失敗測試。
- `node scripts/validate-organized.mjs examples/organized-example.json examples/inbox-example.json`：2 筆匿名結果通過。
- `git diff --check` 通過。

新增測試涵蓋原始 bytes／檔名／MIME／SHA-256、JPEG/PNG/WebP/GIF/HEIC/HEIF、4 MiB 邊界、逐張多圖、防重、未知長度串流超額、錯誤簽章、無讀取／Drive 權限、跨 Session／過期／舊租約版本、Drive 中斷／已寫入但回應遺失／回讀損毀／共享資料夾拒收、日配額／總量／並行限制、孤兒 ID 清理與撤權失敗保留配額、App 驗證後才 commit/ack、lost ack receipt 冪等、AI 精確批次與原占位檔 fail closed／完整 item ID。

## 本機環境限制與 CI

- `npm run test:e2e` 基線嘗試：本機 socket 不允許，HTTP server 無法啟動（EPERM），因此不是產品 E2E 失敗證據。
- `npm run test:assets`：同樣因 `listen EPERM 127.0.0.1` 未能執行實際 HTTP 檢查。
- `npm ci`：沙箱網路 `connect EPERM`；擴充權限的自動核准服務多次回覆模型容量不足／逾時，沒有核准執行。
- `npx --offline wrangler deploy --dry-run`：ENOTCACHED，Wrangler 未安裝，沒有部署。
- PR CI 已補上安全測試與 Google Chrome E2E，保留實際 Static Assets 與 Wrangler dry-run；CI 實際結果將在 PR 更新。

E2E 已擴充直幅完整 contain、原始尺寸、放大、ESC、焦點還原、Object URL 清理、真實 IndexedDB 收件 receipt／附件原子交易，並保留既有 ZIP、AI、390px、離線／Service Worker 回歸。可執行腳本不代表已通過，請以本次 CI 結果為準。

## 仍需本人最後驗收

真實 iPhone Safari／主畫面 PWA、Apple Shortcuts 分享原檔行為、Google Drive grant/配額與 Windows 實機均未宣稱通過。合併後核准一次 migration 0004／部署與 cron、更新原捷徑，再執行 [UAT-V2.3.md](./UAT-V2.3.md)（10–15 分鐘）。不改 Secret、OAuth callback、Client 或金鑰。完整限制、安全／成本與回滾見 [CAPTURE-IMAGES.md](./CAPTURE-IMAGES.md)。

---

# Pocket Archive v2.2 — 驗證紀錄（2026-10-18）

## Cloudflare 正式環境部署前設定

`codex/v2.2-cloudflare-preflight` 以已合併 PR #6、#7、#8 的 `main`（`d12d9c7`）為基礎，實際執行：

```bash
NPM_CONFIG_CACHE=/tmp/pocket-archive-npm-cache npm ci
npm test
npm run test:security
npm run test:assets
npm run test:e2e
node --test tests/deployment-config.test.mjs
XDG_CONFIG_HOME=<temporary-directory>/config npx wrangler d1 migrations apply pocket-archive --local --persist-to <temporary-directory>/d1
XDG_CONFIG_HOME=<temporary-directory>/config npx wrangler deploy --dry-run --outdir <temporary-directory>/worker-build
```

- `npm ci` 完成。第一次使用預設 npm cache 時因本環境不可寫入 `/home/agent/.npm` 而失敗；改用獨立 `/tmp` cache 後同一 lockfile 安裝成功，屬執行環境限制，不是 dependency integrity 或產品錯誤。
- Node：12 個測試檔、共 62 個 `test()` case 全數通過，並包含所有 JavaScript `node --check`。其中 4 個部署設定 case 鎖定正式 workers.dev origin、D1 UUID、Static Assets / `/api/*` routing、三個 migration、OAuth callback、Manifest、Service Worker API bypass，以及 GitHub Pages 無 Worker API 時的相容回退；另驗證 Static Assets 測試遇到預存同名檔時會拒絕覆寫，失敗清理也不會刪除或改寫原檔。
- 安全測試：2 個測試檔、共 9 個 `test()` case 全數通過。
- Static Assets：以 15 個不含真實機密的暫存哨兵檔驗證 `.dev.vars*`、`.env*`、私有目錄、備份／遷移 ZIP／JSON、AI 結果、key、SQLite 與 log 檔同時被 Git 與 Wrangler 排除；本機 Wrangler 對全部私有路徑回覆 `404`，11 個 HTML／CSS／JavaScript／Service Worker／Manifest／icon／公開哨兵檔正常回覆 `200`。CI 也會執行同一驗證。
- Chromium E2E：既有 v1 migration、新增／批次／圖片、搜尋、備份、跨 origin migration ZIP、Codex、Drive fallback、OAuth popup、IndexedDB 原子回滾、390px、Toast 與離線全部通過。
- D1：在全新的本機 state 依序套用 `0001_auth.sql`、`0002_capture.sql`、`0003_owner_session_security.sql`，各 migration 成功；沒有使用 `--remote`。
- Worker：Wrangler `4.151.1` dry-run 成功，bundle 68.16 KiB（gzip 16.15 KiB），辨識 `DB`、`ASSETS`、正式 `APP_ORIGIN` 與既有非敏感變數；沒有執行正式 deploy。
- 本次沒有登入 Cloudflare、操作遠端 D1、設定或產生私人 Secret、存取 Google Drive、部署／重新導向 GitHub Pages、遷移 IndexedDB 或真實資料。

## v2.2 自動化結果

實際執行：

```bash
npm test
npm run test:e2e
XDG_CONFIG_HOME=/tmp/pocket-archive-config npx wrangler d1 migrations apply pocket-archive --local
XDG_CONFIG_HOME=/tmp/pocket-archive-config npx wrangler deploy --dry-run
```

- Node：10 個測試檔、57 個 `test()` case 通過。涵蓋 OAuth code/PKCE/OIDC、唯一擁有者、加密 Token 與金鑰輪替、Session rotation/CSRF/replay/revoke、後端 Drive adapter、快捷憑證／限流／冪等／雙裝置 lease、穩定 queue job ID、遷移 manifest／AI metadata；原有 archive、IndexedDB、URL、Drive、sync/tombstone、PWA 回歸全部保留。另執行 `npm run test:security` 通過。
- Chromium E2E：既有 v1 migration、新增／批次／圖片、搜尋、備份、Codex、Drive fallback、OAuth popup、IndexedDB 原子回滾、390px、Toast 與離線全部通過；新增跨 origin 遷移 ZIP 的附件、`migration.json`、匯出、驗證與冪等匯入也通過。
- Wrangler：在全新的本機 D1 state 依序成功套用 `0001_auth.sql`、`0002_capture.sql`、`0003_owner_session_security.sql`；Worker + Static Assets dry-run bundle 成功（68.16 KiB / gzip 16.15 KiB）。
- 測試只使用 `example.com/.org/.net`、生成式 OAuth RSA key、記憶體 SQLite/D1 adapter 與匿名 8-byte PNG signature，不存取私人 Google Drive 或收藏。

## 尚未驗證／不可虛報

- 未取得 Cloudflare 帳號、D1、正式 Secrets 或 Google Client Secret，因此沒有公開部署、沒有正式 OAuth callback，也沒有操作私人 Drive。
- 本環境沒有 WebKit／真 iPhone；Apple Share Sheet、Shortcuts 的實際動作名稱、PWA cookie 持久性與 standalone UI 仍需實機驗收。
- 沒有宣稱 Google External/Production、品牌驗證或 `drive.file` 既有資料夾相容性已在帳號端完成；必須沿用 project/client 後以匿名資料驗證。
- Google、Cloudflare、Apple 官方網站在本環境回 403；Cloudflare 限制以其官方 GitHub docs 來源核對，Google/Apple 保留官方 URL 與帳號端複核項目。

## 合併前安全補修

PR #6 基礎分支已新增並通過以下自動化情境：

- 正式設定缺少唯一擁有者時 fail closed，OAuth start 不建立 attempt；簽章有效但 `sub` 不符的帳號不建立 user、OAuth credential 或 Session，並 best-effort revoke 新取得的 Google token。
- 預設白名單擁有者可登入及重新登入；一次性 bootstrap grant 可原子綁定第一個已驗證 `sub`，之後拒絕另一帳號。
- OAuth start 每來源 IP / 10 分鐘限速，超限不再建立 OAuth attempt。
- 24 小時後第一個 Drive API 成功回應會帶新 Session Cookie；同一舊 Cookie 的併行請求取得同一新 ID；5 分鐘過渡期後 Drive 仍可用；PWA 重新開啟的 `/api/session` 可恢復登入。
- Drive upstream 錯誤回應仍帶輪替 Cookie；撤銷後的 Session 無法再使用，完整撤銷會刪除含 Refresh Token 密文的 OAuth credential row。
- Token encryption key v1 → v2 後，下一次成功 Drive 存取會重加密尚未到期的 Access Token 與既有 Refresh Token；移除 previous key 後仍可存取。
- Chromium 也明確驗證：靜態 GitHub Pages origin 沒有 Worker API 時，owner setup 保持隱藏、舊 GIS OAuth 設定與 v2.1.3 fallback 保持可用。

本分支實際結果：52 個 Node `test()` case 全數通過、所有 JavaScript 語法檢查通過、Chromium E2E 通過、D1 `0003_owner_session_security.sql` 本機成功套用（9 commands）、Worker bundle dry-run 成功（55.02 KiB / gzip 13.13 KiB）。初次 E2E / D1 指令在預設沙箱因禁止 localhost listen 而失敗；只開放受控網路能力後，以相同指令重跑通過，並非產品測試失敗。沒有部署正式 Worker、讀取私人 Drive、設定秘密或搬移真實資料。

PR #7 疊加後為 54 個 Node `test()` case：另驗證不同捷徑憑證對同一 canonical URL 回傳相同 queue job ID、IndexedDB 失敗後由另一裝置安全重領仍保留該 ID、queue job 轉成穩定收藏 ID、capture credential / claim / ack authenticated routes 皆傳遞 Session rotation Cookie，以及撤銷 Google grant 不會暗中撤銷獨立捷徑憑證。`npm run test:security` 與 Chromium E2E 亦通過。

---

# Pocket Archive v2.1.3 — 歷史驗證紀錄（2026-10-18）

## 自動化驗證

實際執行：

```bash
node scripts/validate-organized.mjs examples/organized-example.json examples/inbox-example.json
npm test
npm run test:e2e
```

結果：

- Codex 匿名範例 schema：2 筆通過。
- Node：6 個測試檔、45 個 `test()` case 通過。除原有 URL、圖片、IndexedDB migration、ZIP、AI schema、安全、OAuth、Drive 與 PWA 測試外，v2.1.3 新增 7 個雙裝置情境：ZIP 相同資料的因果合併、ZIP 後立即修改、Windows → iPhone 刪除、iPhone → Windows 刪除、離線刪除後恢復、並行編輯／刪除與決議收斂、舊衝突／舊 journal 不得復活 tombstone；另驗證 App 與 Service Worker 快取版本一致。
- 語法：`app.js`、`lib.mjs`、`db.mjs`、`archive.mjs`、`drive.mjs`、`crypto.mjs`、`sync.mjs`、`cloud.mjs`、`sw.js` 全部 `node --check` 通過。
- Chromium E2E：實際通過 v1 migration、單筆/批次/圖片、搜尋、備份匯入、Codex export/預覽/套用/復原、Drive 未授權不得顯示成功、雲端設定與加密 UI、OAuth 使用者手勢、原生 `window.fetch` 綁定、真實 IndexedDB 的收藏＋附件＋同步 metadata 原子回滾、表單與鍵盤操作、390×844 無水平溢出、Service Worker 離線重新載入，以及 Toast 在 modal top layer 顯示、連續通知重設計時、長訊息換行、完整隱藏、底部安全距離、`pointer-events: none` 與 reduced-motion。
- WebKit：環境未預裝；已實際嘗試 `playwright install webkit`，三個 Playwright CDN 均被執行環境網路政策以 HTTP 403 阻擋。因此沒有宣稱 WebKit 或 iPhone 實機通過，以下保留人工驗收清單。

測試資料只使用 `example.com/.org/.net` 與 8-byte 匿名 PNG signature，沒有讀取或上傳真實收藏。

## Google Drive / Codex 實際驗證

目前已授權的 Codex Google Drive 連接器於 2026-10-18 完成：

1. 上傳匿名 JSON。
2. raw fetch 回讀完整 bytes。
3. 以 update 原檔寫入新 JSON，確認 file ID 不變，再次 raw fetch 驗證新內容。
4. 上傳匿名 `pocket-archive-inbox` ZIP。
5. 以 raw stream 下載到工作區；`unzip -t` 通過，且 `inbox.json` schema/export_id 正確。
6. 永久刪除上述兩個、且只刪除本次建立的臨時驗證檔。

因此 Codex 連接器的 ZIP/JSON raw download 與同 file ID raw update 已實證，不只是搜尋能力。

依使用者於 v2.1.2 修正任務提供的實測結果，Windows PWA OAuth、Drive 工作區與完整備份已驗收通過；本自動化環境未重做該帳號測試。iPhone Safari／主畫面 PWA 的 GIS popup 與後續同步仍標示為 **待實機驗證**，不以 Chromium 測試宣稱 iPhone 正式成功。

`DriveApi` 的預設瀏覽器 `fetch` 綁定已另以 Chromium 真實原生 API 回歸測試驗證，不需要 Token 或 Client Secret；此測試只向本機測試伺服器請求公開 manifest，不代表已完成 Google OAuth 帳號實機驗證。

## 功能狀態

| 範圍 | 狀態 | 實作 |
| --- | --- | --- |
| GIS OAuth、連結/重授權/撤銷、狀態 | Windows 由使用者驗收；iPhone popup 待實機複驗 | `drive.mjs`, `app.js`, `index.html` |
| Drive 工作區與最小 `drive.file` | Windows 由使用者驗收；iPhone 待實機複驗 | `drive.mjs`, `GOOGLE-DRIVE-SETUP.md` |
| 自動歷史備份、回讀 SHA-256、還原預覽 | 完成；真實 PWA 上傳待授權 | `cloud.mjs`, `crypto.mjs`, `app.js` |
| AES-256-GCM 用戶端加密 | 完成並通過錯密碼/竄改測試 | `crypto.mjs` |
| 雙向增量同步、附件、tombstone、衝突選擇 | 完成雙向刪除、離線、ZIP bootstrap、真衝突與舊 journal 回歸；實機待驗 | `sync.mjs`, `cloud.mjs`, `app.js`, `tests/sync-delete.test.mjs` |
| iPhone Toast 與 modal top layer | Chromium 390×844 通過；WebKit／實機待驗 | `app.js`, `styles.css`, `tests/e2e.mjs` |
| Drive AI-Inbox/AI-Results、去重、結果預覽/復原 | 完成；跨 OAuth Client 待 PWA 授權實測 | `cloud.mjs`, `CODEX-DRIVE-WORKFLOW.md` |
| Codex connector raw JSON/ZIP download/update | 實際通過 | 連接器驗證紀錄如上 |
| App 關閉後背景同步 | 不提供 | iOS PWA 無法可靠保證；只在開啟/前景/重連時補傳 |

## 已知限制

- Access Token 只存記憶體，因此每次新的 PWA 工作階段需使用者點擊連結；不保存 refresh token 是刻意的安全界線。
- GIS Token Model 官方只支援 dialog，沒有可直接切換的 redirect 模式。若特定 iOS standalone 版本即使直接點擊仍拒絕 popup，安全 redirect 備案需要獨立後端 Authorization Code flow，不能把 Client Secret 放進靜態 PWA。
- 同步 journal/附件索引每次最多掃描 100 個檔案，足以涵蓋個人 iPhone/Windows 情境，不是大型團隊後端。
- 已刪除收藏的雲端附件不自動清除，以保護尚未同步的離線裝置；後續可加入有寬限期、先預覽的 orphan cleanup。
- 備份加密不套用到 Sync/AI 交換區；否則其他裝置與 Codex 無法在沒有密碼代理服務的前提下讀取。
- Google 官方文件主機在本執行環境回覆 403；官方來源 URL 與無法保存快照的限制已記錄於 `DRIVE-ARCHITECTURE.md`。

## iPhone／Windows 最後實機驗收（約 10–15 分鐘）

1. 更新 PWA 後確認側欄顯示 v2.1.3；若仍是舊版，完整關閉再開啟一次讓新版 Service Worker 接管。
2. 兩端先以同一份匿名測試 ZIP 建立 3 筆收藏，各自連結 Drive 並同步；不應出現「內容完全相同」的衝突。
3. Windows 刪除第 1 筆並同步，再在 iPhone 同步；確認第 1 筆消失。第 2 筆反向由 iPhone 刪除後在 Windows 確認。
4. 讓 iPhone 暫時離線，在 Windows 刪除第 3 筆並同步；iPhone 恢復連線再同步後應消失，不能由舊 journal 復活。
5. 另建一筆：兩端同步後離線分岔，一端編輯、一端刪除；恢復同步時應顯示衝突，選擇其中一版並讓兩端各再同步一次，結果必須一致。
6. 在 Drive、備份與 Codex Dialog 內各觸發一則通知；確認通知清楚可見、不會搶焦點或擋住按鈕，連續觸發後以最後一次計時完整消失。
7. 在 iPhone 主畫面 PWA 旋轉或維持直向，觸發一則長通知；確認文字換行、不超出螢幕、不殘留，且不與底部導覽或 Home Indicator 重疊。
8. 若 iOS 已開啟「減少動態效果」，確認通知不播放位移動畫但仍正常顯示／消失。
