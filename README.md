# Pocket Archive

Pocket Archive 是給 iPhone／iOS Safari、主畫面 Web App 與 Windows 瀏覽器使用的 local-first 私人收藏收件匣。可保存一般網址、YouTube、Instagram／Threads／X 等社群連結及原始圖片；支援批次收件、分類、搜尋、完整備份，以及不接 AI API 的 Codex 按需批次整理。v2.2 可用同來源 Cloudflare Worker 安全保存 Google 長期授權並自動恢復工作階段；未部署後端或暫時離線時，既有本機功能仍完整可用。

視覺維持既定 Minimal & Modern、Butter Yellow `#FFF2C9` × Periwinkle `#CBD7EF` 與 A3 實心書籤 Icon。

## v2.3 更新

- 卡片完整呈現圖片，原圖檢視器直接讀 IndexedDB Blob；支援縮放、觸控拖移、鍵盤、原檔下載與 HEIC 解碼失敗說明。
- 同一 iPhone 捷徑可逐張傳送原始圖片；分享上限 4 MiB／張，本機選圖 25 MB。私有 Drive 暫存與 D1 狀態機詳見 [CAPTURE-IMAGES.md](./CAPTURE-IMAGES.md)。
- AI-Inbox 送出後由 App 先驗證原檔 metadata／SHA-256，再產生含檔案 ID 與雜湊的批次專用 Codex 指令（v2.3.1）；Codex 原檔寫回仍須驗證，結果由人勾選套用。
- 最後一次實機驗收：[UAT-V2.3.md](./UAT-V2.3.md)。

## 功能

- 單筆或每行一筆批次加入 HTTP(S) 網址；匯入前分列有效、重複與無效項目。URL 去除常見追蹤參數但保留原始輸入。
- 圖片拖放或檔案／照片選取：JPEG、PNG、WebP、GIF、HEIC/HEIF，每張最多 25 MB；檢查 MIME、檔案簽章與 SHA-256 重複內容。
- 收件匣／已整理／封存、類型、獨立分類、多標籤、星號、搜尋、排序、單筆及多筆編輯。
- IndexedDB 保存紀錄和 Blob；v1 `localStorage` 只複製遷移，絕不自動刪除舊資料。容量或權限失敗時，資料庫交易會回滾並提示備份。
- 無附件下載版本化 JSON；有附件下載 ZIP。還原前驗證 schema、大小、ZIP 路徑、附件 MIME／簽章／雜湊、ID 衝突，並先預覽合併結果。
- 人工觸發 Codex 整理：本機檔案流程或使用者明確按下的 Drive AI-Inbox 流程 → 逐項差異預覽 → 勾選套用 → 單次復原。App 不含 AI API，也不會在未連結／未送出工作前上傳 AI 批次。
- 選用 Google Drive：同來源 Worker 採 Authorization Code + PKCE、最小 `drive.file`、加密 Refresh Token 與 HttpOnly Session；App 開啟時自動恢復並補傳。GitHub Pages 保留 v2.1 的短效 token 相容模式。
- 雲端完整備份保留 1–30 份歷史，寫入後回讀 SHA-256；可選 PBKDF2 + AES-256-GCM 用戶端加密，還原仍先預覽。
- 跨裝置同步使用每裝置 journal、向量時鐘、delete tombstone 與可選版本的衝突面板，不以最後寫入者整庫覆蓋。
- v2.1.3 會合併由同一份 ZIP 建立的相同因果版本；tombstone 只在能證明並行 upsert 是被刪除的同一內容時自動收斂，真正的刪除／編輯仍交由使用者選擇，且已被較新版本取代的舊衝突不再可重新發布。
- Drive AI-Inbox/AI-Results：App 預建結果占位檔，Codex Cloud 以同一 file ID 寫回，解決不同 OAuth Client 的 `drive.file` 存取邊界。
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

### Google Drive 連線、備份與同步

正式 v2.2 先依 [CLOUDFLARE-SETUP.md](./CLOUDFLARE-SETUP.md) 建立同來源 Worker、D1 與 OAuth callback。Client Secret 只放 Worker Secret，不得貼入 App 或 Git。架構與限制見 [ARCHITECTURE-V2.2.md](./ARCHITECTURE-V2.2.md)。

- iPhone 與 Windows 必須使用同一 Client ID、同一 Google 帳號。
- iPhone 開啟「Drive 同步」後，若按鈕顯示「正在準備 Google 登入…」，請等待它恢復成「連結 Google Drive」再直接點一下；App 會在點擊事件內立即開啟 Google 授權視窗。
- Worker 模式會以安全 Session 自動恢復；Access Token 不交給瀏覽器。Session 或 Google grant 失效時才要求重新登入，本機資料不受影響。
- 連結後資料變更會延遲備份與同步；回到前景或網路恢復會補傳。App 關閉期間不宣稱能在 iOS 背景運作。
- 同時修改不會靜默覆蓋；「Drive 同步」的衝突區可選擇保留版本。
- iPhone 的通知會避開底部導覽與安全區；Dialog 開啟時通知仍在 top layer 顯示，且不會取得焦點或阻擋點擊。
- 加密密碼不保存也無法復原；需要 Codex/跨裝置讀取的 Sync 與 AI 交換資料不使用備份加密。

完整技術與威脅邊界見 [DRIVE-ARCHITECTURE.md](./DRIVE-ARCHITECTURE.md)。

### Codex 批次整理

1. 可先勾選要整理的卡片；未勾選時使用全部待整理項目。
2. 已連結 Drive 時，按「送到 Drive AI-Inbox」，再按「一鍵複製 Codex 指令」貼到有 Drive 原檔下載／更新能力的 Codex。指令指定此批 export_id、必讀儲存庫規則與禁止 Notion；選對工作區不代表已授權 Drive。 Codex 依 [CODEX-DRIVE-WORKFLOW.md](./CODEX-DRIVE-WORKFLOW.md) 原檔覆寫結果占位檔。
3. 未連結 Drive 時，展開「離線／手動檔案流程」下載 JSON/ZIP，搭配 [CODEX-ORGANIZE-PROMPT.md](./CODEX-ORGANIZE-PROMPT.md) 使用本機 Codex CLI。
4. 可先驗證：

   ```bash
   node scripts/validate-organized.mjs organized.json pocket-archive-inbox-YYYY-MM-DD.json
   ```

5. Drive 流程按「檢查 Drive 整理結果」；檔案流程則匯入 `organized.json`。兩者都先逐筆檢查再套用，只更新分類、合併標籤、保存 AI 摘要，不改原始網址、備註或附件，並可復原最近一次套用。

匿名範例在 `examples/`。完整規則見 [AI-BATCH-SPEC.md](./AI-BATCH-SPEC.md)。

## iPhone 使用

正式使用需 HTTPS。部署 v2.2 Worker 後可建立只有 `capture:create` 權限的捷徑憑證，完成「分享 → 存到 Pocket Archive → 已送入佇列」；App 下次開啟會冪等合併、確認工作並接續 Drive 同步。逐步設定與錯誤處理見 [IOS-SHORTCUT.md](./IOS-SHORTCUT.md)。純 GitHub Pages 回滾模式仍使用「複製 → 開啟 App → 讀取剪貼簿」。

## 部署

正式 v2.2 使用 Cloudflare Worker + Static Assets + D1；帳號設定見 [CLOUDFLARE-SETUP.md](./CLOUDFLARE-SETUP.md)。`.github/workflows/pages.yml` 保留 GitHub Pages 舊 origin 與回滾入口，本專案不會自行切換正式部署。跨 origin 流程見 [MIGRATION-ROLLBACK.md](./MIGRATION-ROLLBACK.md)。

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

- 未連結 Drive 時，收藏和圖片只存在目前來源的 IndexedDB；連結後只同步至使用者授權的 Google Drive，沒有 Pocket Archive 自有後端或遙測。瀏覽器資料仍可能因清除網站資料、裝置損壞、私密瀏覽或儲存壓力遺失，務必保留歷史備份。
- 匯出檔可能含私人網址、備註、token 或原始圖片。不要提交 Git、issue 或公開聊天室；優先使用本機 Codex CLI。
- Instagram、Threads、X 等平台可能需要登入或禁止跨來源讀取。本版可靠保存 URL，不承諾擷取貼文正文。
- HEIC/HEIF 可原樣保存與備份，但部分 Windows 瀏覽器可能無法產生縮圖；檔案仍保留。
- iOS Safari 與加入主畫面的 Web App 可能使用不同儲存容器。固定使用同一入口並定期備份。
- Android 專屬 Web Share Target、付費 AI API、原生 iOS App，以及 App 關閉後的全天候背景同步不在本版範圍。

實作完成度與真實測試紀錄見 [VALIDATION.md](./VALIDATION.md)。
