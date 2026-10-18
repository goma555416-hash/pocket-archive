# Pocket Archive v2.1 — 驗證紀錄（2026-10-18）

## 自動化驗證

實際執行：

```bash
node scripts/validate-organized.mjs examples/organized-example.json examples/inbox-example.json
npm test
npm run test:e2e
```

結果：

- Codex 匿名範例 schema：2 筆通過。
- Node：5 個測試檔、37 個 `test()` case 通過。除原有 URL、圖片、IndexedDB migration、ZIP、AI schema、安全與 PWA 測試外，新增 OAuth token 失效/撤銷、Drive 401 與 503 retry、大檔 resumable upload、AES-GCM 往返/錯密碼/竄改、向量時鐘、刪除衝突、journal schema、備份回讀完整性/輪替、AI 占位檔、模擬 iPhone/Windows 雙向 journal + 圖片同步，以及收藏/附件同一 IndexedDB transaction 的成功、一般附件失敗與容量不足回滾。
- 語法：`app.js`、`lib.mjs`、`db.mjs`、`archive.mjs`、`drive.mjs`、`crypto.mjs`、`sync.mjs`、`cloud.mjs`、`sw.js` 全部 `node --check` 通過。
- Chromium E2E：實際通過 v1 migration、單筆/批次/圖片、搜尋、備份匯入、Codex export/預覽/套用/復原、Drive 未授權不得顯示成功、雲端設定與加密 UI、真實 IndexedDB 附件 DataCloneError 時整筆 transaction 回滾、表單標籤/按鈕名稱、鍵盤操作、390×844 無水平溢出，以及 Service Worker 離線重新載入。E2E 需要允許本機 loopback socket；預設受限 sandbox 會在 HTTP server bind 時失敗，取得該測試所需網路權限後通過。

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

尚未驗證的是 PWA OAuth：目前沒有儲存庫擁有者的 Google OAuth Web Client ID，也不能代替使用者完成 consent screen。PWA 登入、真實 `drive.file` 資料夾建立、兩部實機及 PWA→Codex 跨 OAuth Client 全流程均標示為 **待授權驗證**，不以 mock 測試宣稱正式成功。

## 功能狀態

| 範圍 | 狀態 | 實作 |
| --- | --- | --- |
| GIS OAuth、連結/重授權/撤銷、狀態 | 程式完成；待 Web Client 授權實測 | `drive.mjs`, `app.js`, `index.html` |
| Drive 工作區與最小 `drive.file` | 程式完成；待 PWA 帳號實測 | `drive.mjs`, `GOOGLE-DRIVE-SETUP.md` |
| 自動歷史備份、回讀 SHA-256、還原預覽 | 完成；真實 PWA 上傳待授權 | `cloud.mjs`, `crypto.mjs`, `app.js` |
| AES-256-GCM 用戶端加密 | 完成並通過錯密碼/竄改測試 | `crypto.mjs` |
| 雙向增量同步、附件、tombstone、衝突選擇 | 完成並通過雙裝置模擬；實機待驗 | `sync.mjs`, `cloud.mjs`, `app.js` |
| Drive AI-Inbox/AI-Results、去重、結果預覽/復原 | 完成；跨 OAuth Client 待 PWA 授權實測 | `cloud.mjs`, `CODEX-DRIVE-WORKFLOW.md` |
| Codex connector raw JSON/ZIP download/update | 實際通過 | 連接器驗證紀錄如上 |
| App 關閉後背景同步 | 不提供 | iOS PWA 無法可靠保證；只在開啟/前景/重連時補傳 |

## 已知限制

- Access Token 只存記憶體，因此每次新的 PWA 工作階段需使用者點擊連結；不保存 refresh token 是刻意的安全界線。
- 同步 journal/附件索引每次最多掃描 100 個檔案，足以涵蓋個人 iPhone/Windows 情境，不是大型團隊後端。
- 已刪除收藏的雲端附件不自動清除，以保護尚未同步的離線裝置；後續可加入有寬限期、先預覽的 orphan cleanup。
- 備份加密不套用到 Sync/AI 交換區；否則其他裝置與 Codex 無法在沒有密碼代理服務的前提下讀取。
- Google 官方文件主機在本執行環境回覆 403；官方來源 URL 與無法保存快照的限制已記錄於 `DRIVE-ARCHITECTURE.md`。
