# v2.3.6 社群網址讀取錯誤分流修補與 UAT

## 為什麼要修
v2.3.5 `app.js fetchTitle()` 使用 `if (social && state.backendAvailable)` 決定是否呼叫官方 oEmbed。即使使用者輸入支援的 YouTube URL，只要進入編輯時後端暫時不可用，這個判斷就會落入瀏覽器直接 fetch 外部 HTML 的舊流程；CORS 失敗提示無法說明真正的問題。對於已知但尚未支援的 Threads/Instagram/X 也一樣。

## 修改契約
- **支援的影片**（YouTube watch / Shorts、TikTok 正式影片頁）：永遠不進入泛用網頁跨來源讀取流程；若登入或後端狀態未知，先重新確認 session；若無後端顯示服務不可用，若未登入顯示登入提示，若連線／官方 oEmbed 失敗顯示原始後端錯誤；使用者均可手動收藏。
- **已知但未支援的平台／路徑**（Instagram、Threads、X、YouTube 播放清單、TikTok 短網址等）：不假裝可以讀取貼文全文，也不退回非官方爬蟲；明確標示未支援，保留手動收藏。
- **一般網站**：維持舊版在允許 CORS 時解析 title/OG 資訊，失敗可手動收藏。
- 只更動 `app.js` 的動作分流、`social-metadata.mjs` 的純函式平台辨識、相關測試及 Service Worker/版本標記；不更改 Worker route、D1/OAuth/Drive/捷徑、已儲存收藏或人工標籤。

## 驗收
- [ ] GitHub CI 全綠（單元、安全、瀏覽器 E2E、Static Assets、Worker dry-run）。
- [ ] iPhone / Windows 顯示 V2.3.6；已登入的正式 Worker 上公開 YouTube watch 影片能取得 oEmbed 標題/作者（若上游可用）。
- [ ] 不登入或後端暫時不可用時，YouTube URL 顯示明確的登入／服務提示，**不出現舊 CORS 提示**。
- [ ] Threads/Instagram/X 網址，或 YouTube 播放清單、TikTok 短網址，顯示目前不支援公開資訊讀取，仍可人工保存。
- [ ] 一般網頁仍以原本的 CORS 邏輯讀取標題。
- [ ] 在同一編輯視窗更換 URL，不把先前來源的非同步回覆寫入新收藏。
- [ ] 原圖、ZIP 備份、同步、舊有標籤及人工分類不受影響。

這次修正改善的是路由與提示；是否能取得 YouTube/TikTok 官方資料，仍依來源服務是否實際提供及允許存取而定。正式 v2.3.5 仍維持不動，待 PR/CI 完成後才考慮下一次部署。
