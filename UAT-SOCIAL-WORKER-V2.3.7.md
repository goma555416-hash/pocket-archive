# v2.3.7 Cloudflare Worker oEmbed 相容性修復

## 正式環境症狀與根因

使用者在 v2.3.6 以 `https://www.youtube.com/watch?v=dQw4w9WgXcQ` 按「讀取公開影片資訊／網站標題」後，UI 顯示「公開來源暫時無法讀取；仍可收藏網址」。

原本 `social-metadata.mjs` 以 `fetch(url, { redirect: 'error' })` 讀取上游。Cloudflare Workers 的 RequestInit **不支援 `redirect: 'error'`**，會在建立 Request 時即拋 `TypeError`，被誤轉為 `social_unavailable`。這是確認存在的代碼/Runtime 相容性問題；修正後的真實 YouTube 可用性仍須在部署後實際驗收，不能把未曾到達的上游回應當成已成功測試。

Cloudflare 官方文件：https://developers.cloudflare.com/workers/runtime-apis/request/ （RequestInit redirect mode，僅支援 follow/manual，error 直接拋 TypeError）。

## 修正方式

- 將固定 YouTube/TikTok oEmbed 請求的 `redirect: 'error'` 改為 `redirect: 'manual'`。
- 針對任何 HTTP 300–399 回應回傳 `social_redirect_rejected`，**不追蹤 Location／不傳送新請求到其它網域**。
- 維持 HTTPS/provider/URL ID allowlist、匿名上游、登入+CSRF、D1 rate limit、6 秒 timeout、64KiB JSON 上限、無 HTML／全文／字幕儲存。
- `scripts/test-social-worker-runtime.mjs` 以 Wrangler 既有依賴的 Miniflare/Cloudflare workerd 實際執行 `social-metadata.mjs`，確認 RequestInit 建立成功、正常固定來源資訊被接收、302 被拒絕；完全合成資料，無外部網路或使用者收藏。
- 此 runtime 測試加入 GitHub Worker bundle CI job，避免 Node mock 通過而 Workers 環境必定失敗的回歸。

## 上線與驗收

1. CI `npm test`、`npm run test:worker-runtime`、`npm run test:assets`、Chromium E2E 與 Worker dry-run 皆需通過。
2. 使用新的乾淨 Git worktree 部署到已確認 Worker / APP_ORIGIN，版本畫面 `V2.3.7`。
3. 已登入 Pocket Archive，貼 `https://www.youtube.com/watch?v=dQw4w9WgXcQ`，按讀取；若 YouTube 服務提供 oEmbed，應取得標題／作者；若實際來源仍阻擋，要顯示該層原因而不是誤稱 CORS。
4. 嘗試有效公開 TikTok 連結及不可用/未支援社群連結；不能推斷已讀到影片內容或逐字稿。
5. 既有圖像收藏、iPhone 捷徑、Google Drive 同步、Codex 批次/AI-Inbox 規格與備份皆不變。**不得清除 D1／IndexedDB／Drive**。

這次只修讓公開影片 metadata 請求無法進入真實上游的 Worker 相容性問題。使用者的長期優先目標是 Codex 依實際取得的網頁／貼文／影片內容分類，已獨立列於 Issue #21；oEmbed 僅供標題/作者/縮圖，不能當成 AI 已理解影片的證據。
