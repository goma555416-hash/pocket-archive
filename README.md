# Pocket Archive

Pocket Archive 是給 iPhone／iOS Safari、主畫面 Web App 與 Windows 瀏覽器使用的 local-first 私人收藏收件匣。可保存一般網址、YouTube、Instagram／Threads／X 等社群連結及原始圖片；支援批次收件、分類、搜尋、完整備份，以及不接 AI API 的人工 Codex 批次整理流程。

視覺維持既定 Minimal & Modern、Butter Yellow `#FFF2C9` × Periwinkle `#CBD7EF` 與 A3 實心書籤 Icon。

## 功能

- 單筆或每行一筆批次加入 HTTP(S) 網址；匯入前分列有效、重複與無效項目。URL 去除常見追蹤參數但保留原始輸入。
- 圖片拖放或檔案／照片選取：JPEG、PNG、WebP、GIF、HEIC/HEIF，每張最多 25 MB；檢查 MIME、檔案簽章與 SHA-256 重複內容。
- 收件匣／已整理／封存、類型、獨立分類、多標籤、星號、搜尋、排序、單筆及多筆編輯。
- IndexedDB 保存紀錄和 Blob；v1 `localStorage` 只複製遷移，絕不自動刪除舊資料。容量或權限失敗時，資料庫交易會回滾並提示備份。
- 無附件下載版本化 JSON；有附件下載 ZIP。還原前驗證 schema、大小、ZIP 路徑、附件 MIME／簽章／雜湊、ID 衝突，並先預覽合併結果。
- 人工觸發 Codex 整理：匯出 inbox JSON/ZIP → 本機 Codex CLI（或使用者明確選擇的 Codex Cloud）→ 匯入 `organized.json` → 逐項差異預覽 → 勾選套用 → 單次復原。App 不含 AI API，也不會自動上傳。
- PWA 離線啟動、版本化 Service Worker、iPhone 小畫面與 Windows 鍵盤操作（`N` 新增、`/` 搜尋）。

第三方頁面標題／預覽只在使用者按「嘗試讀取」且網站允許 CORS 時讀取；失敗仍可完整保存網址。App 不繞過登入、CAPTCHA 或社群平台限制。

## 本機啟動

請勿以 `file://` 雙擊 HTML。進入專案根目錄後：

```bash
python -m http.server 5173
```

再開啟 `http://localhost:5173`。資料屬於「瀏覽器設定檔 + 網站來源」：`localhost`、`127.0.0.1` 與部署後的 HTTPS 網址互不共用，搬移時使用完整備份。

## 常用操作

### 收集與整理

1. 「單筆收藏」保存一個網址；「批次網址」貼入多行後先看預覽；「圖片」可拖曳或選取多張。
2. 新收藏預設進入收件匣。卡片可標星、編輯、標記已整理或封存。
3. 勾選卡片後可批次改狀態、星號、分類及附加標籤。

### 完整備份與 iPhone ↔ Windows 手動轉移

1. 打開「備份／還原」→「下載完整備份」。含圖片時一定會得到 ZIP，請勿只留下其中的 `backup.json`。
2. 把檔案存到使用者控制的 Files／iCloud Drive／USB 或其他私人傳輸位置。
3. 在另一台裝置的 Pocket Archive 打開「備份／還原」→ 選擇檔案 → 檢查新增、重複、衝突預覽 → 確認。

這是可攜檔案的手動轉移，不是背景即時同步；合併不會覆寫或刪除既有資料。自動同步需要帳號、驗證與安全後端，本版未啟用。

### Codex 人工批次整理

1. 可先勾選要整理的卡片；未勾選時使用全部待整理項目。
2. 「Codex 整理」→「匯出待整理批次」。含圖片時得到 ZIP。
3. 把檔案與 [CODEX-ORGANIZE-PROMPT.md](./CODEX-ORGANIZE-PROMPT.md) 交給本機 Codex CLI。只有在你接受資料進入雲端時才明確上傳 Codex Cloud。
4. 可先驗證：

   ```bash
   node scripts/validate-organized.mjs organized.json pocket-archive-inbox-YYYY-MM-DD.json
   ```

5. 回到 App 匯入 `organized.json`，檢查每筆建議並勾選套用。套用只更新分類、合併標籤、保存 AI 摘要；不改原始網址、備註或附件。可在備份視窗復原最近一次套用。

匿名範例在 `examples/`。完整規則見 [AI-BATCH-SPEC.md](./AI-BATCH-SPEC.md)。

## iPhone 使用

正式使用需 HTTPS。Safari 開啟部署網址 → 分享 →「加入主畫面」。安全分享捷徑採「分享內容 → 複製到剪貼簿 → 開啟 Pocket Archive → 點讀取剪貼簿 → 預覽確認」，不把私人網址放在 GET query；逐步設定與錯誤處理見 [IOS-SHORTCUT.md](./IOS-SHORTCUT.md)。純靜態網站無法從其他 App 背景直接寫入 Safari/PWA 的 IndexedDB。

## 部署

`.github/workflows/pages.yml` 提供 GitHub Pages 靜態部署工作流程，但本專案不會自行公開部署。開啟 Pages 前請確認可接受公開網站，且儲存庫不含備份、圖片、token 或私人資料。詳見 [DEPLOYMENT.md](./DEPLOYMENT.md)。

## 測試

需要 Node.js 20+ 與 Chromium（完整 E2E）：

```bash
npm test
npm run test:e2e
# 或一次執行
npm run test:all
```

`npm test` 執行純函式、schema、安全、ZIP 往返與語法檢查；E2E 使用獨立臨時 Chromium profile，測試 v1 遷移、單筆、批次、圖片、搜尋、備份匯入、Codex 預覽/套用/復原、390px viewport 與離線啟動。測試不會讀取真實收藏。

## 隱私、資料安全與限制

- 收藏和圖片只存在目前來源的 IndexedDB；沒有帳號、後端或遙測。瀏覽器資料仍可能因清除網站資料、裝置損壞、私密瀏覽或儲存壓力遺失，務必定期下載 ZIP/JSON。
- 匯出檔可能含私人網址、備註、token 或原始圖片。不要提交 Git、issue 或公開聊天室；優先使用本機 Codex CLI。
- Instagram、Threads、X 等平台可能需要登入或禁止跨來源讀取。本版可靠保存 URL，不承諾擷取貼文正文。
- HEIC/HEIF 可原樣保存與備份，但部分 Windows 瀏覽器可能無法產生縮圖；檔案仍保留。
- iOS Safari 與加入主畫面的 Web App 可能使用不同儲存容器。固定使用同一入口並定期備份。
- Android 專屬 Web Share Target、付費 AI API、原生 iOS App與背景同步不在本版範圍。

實作完成度與真實測試紀錄見 [VALIDATION.md](./VALIDATION.md)。
