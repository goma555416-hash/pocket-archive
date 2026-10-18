# Pocket Archive v2 — 驗證紀錄（2026-10-17）

## 自動化驗證

實際執行：

```bash
node scripts/validate-organized.mjs examples/organized-example.json examples/inbox-example.json
npm test
npm run test:e2e
```

結果：

- Codex 匿名範例 schema 驗證：2 筆通過。
- Node：3 個測試檔、25 個 test case 通過（URL／100 筆批次／圖片 metadata 與簽章／容量失敗提示／v1 遷移／JSON 與含圖片 ZIP 備份往返／衝突／AI schema 與復原／XSS／ZIP 路徑與 CRC／PWA manifest 和快取資源）。
- 語法：`app.js`、`lib.mjs`、`db.mjs`、`archive.mjs`、`sw.js` 全部 `node --check` 通過。
- Chromium E2E：使用獨立臨時設定檔，實際通過 v1 localStorage → IndexedDB 遷移、單筆新增、批次預覽/新增、圖片 hash/Blob 儲存、跨欄位搜尋、備份匯入預覽/合併、Codex `export_id`、結果預覽/套用/復原、按鈕名稱與表單標籤、`N`／`/` 鍵盤操作、390×844 viewport 無水平溢出及 Service Worker 離線重新載入。

測試資料全部為 `example.com/.org/.net` 匿名資料；沒有讀取、上傳或刪除真實收藏。

## 功能狀態

| 範圍 | 狀態 | 實作 |
| --- | --- | --- |
| 單筆／多筆網址、去重、來源、社群類型 | 完成 | `app.js`, `lib.mjs` |
| 圖片檔案、縮圖、metadata、SHA-256 去重 | 完成 | `app.js`, `db.mjs`, `lib.mjs` |
| IndexedDB 與 v1 保留式遷移 | 完成 | `db.mjs` |
| 狀態、分類、多標籤、星號、搜尋、排序、批次編輯 | 完成 | `app.js`, `index.html` |
| JSON／ZIP 完整備份、驗證、預覽與合併 | 完成 | `archive.mjs`, `app.js` |
| Codex 人工批次匯出／驗證／預覽／套用／復原 | 完成 | `app.js`, `lib.mjs`, `scripts/`, `CODEX-ORGANIZE-PROMPT.md` |
| iPhone 捷徑安全流程、手動跨裝置轉移 | 文件與 App 入口完成 | `IOS-SHORTCUT.md`, `README.md` |
| PWA 離線／更新、GitHub Pages workflow | 完成，未公開部署 | `sw.js`, `manifest.webmanifest`, `.github/workflows/pages.yml` |
| 自動跨裝置同步 | 非本次必達、未啟用 | 需要帳號、授權及安全後端 |

## 尚需使用者／實機驗證

- iPhone Safari 與主畫面 PWA 的 A3 Icon 裁切、照片／檔案選擇器、HEIC 實際縮圖、剪貼簿權限及離線冷啟動。
- Windows 實際瀏覽器的長時間使用、真實大圖儲存額度及下載位置。
- GitHub Pages 尚未啟用，因為公開部署需要儲存庫擁有者確認。啟用步驟在 `DEPLOYMENT.md`。

## 已知限制

- CORS、登入與平台政策可能阻止標題、預覽或社群正文讀取；App 仍保存 URL，不做繞過。
- Safari 儲存額度與清除政策由系統控制；`navigator.storage.persist()` 也可能被拒絕。完整 ZIP 是唯一可攜的附件備份。
- 純靜態 PWA 無背景同步，且 Safari 與主畫面 App 可能不是相同資料容器。
- HEIC/HEIF 原檔可保存，但縮圖解碼能力取決於瀏覽器／作業系統。
