# v2.3.5：社群公開影片資訊讀取（PR 驗收）

## 範圍／證據

這一階段只支援 **YouTube 影片、Shorts／Live** 及 **TikTok 的公開影片頁**，經使用者在「新增／編輯收藏」表單點按「讀取公開影片資訊／網站標題」後嘗試取得公開 oEmbed 的 **標題、作者與安全的縮圖網址**。來源為平台官方 oEmbed，伺服器回覆的 `evidence` 固定為 `provider-oembed`，`contentRead=false`，不宣稱已看過影片、下載影像、逐字稿或完整描述。

平台被阻擋、影片下架、地區限制、不公開、工作階段過期、網路故障時，只顯示讀取失敗，不阻止使用者手動保存連結。Instagram、Threads、X、Pinterest 等社群連結**沒有啟動「猜測內容」的爬蟲**；保留原本可手動填寫與 Codex 的「資料不足」行為。

## 流程與邊界

1. `social-metadata.mjs`：純函式提取 provider / 影片 ID（只允許真正的 HTTPS YouTube、TikTok 影片頁，去除追蹤參數）；只向固定官方 oEmbed URL 發送 HTTPS GET，禁止 Redirect、憑證／Cookie、任意代理轉址。
2. `POST /api/social/metadata`：沿用 Pocket Archive Owner Session + 同來源 CSRF，既有 D1 `security_rate_limits` 限制每個來源 IP 10 分鐘內 30 次；不需要新 D1 migration、Token 或 API key。只回傳限長文字與允許網域內的公開縮圖，不回傳 HTML／描述內容，也不寫入 D1 或 Google Drive。
3. `backend.mjs`：只對同來源後端傳送 JSON body（網址不放 URL query、Referer 或日誌）。Worker 最多接收 4 KiB 請求；上游 6 秒逾時、最多 64 KiB 回應，且要求 JSON 與正確 `provider_name`。
4. `app.js`：同一個編輯視窗按鈕，成功只更新畫面中標題與（若安全）縮圖欄位；作者顯示於表單提示，不主動改寫備註、標籤、使用者已確認類型。儲存仍需使用者主動按「儲存收藏」。若編輯視窗已更換、關閉或網址改變，過期回應略過。
5. 登入與否不影響原本的本機收藏、備份、離線 PWA、iPhone 捷徑及 Codex JSON 格式；不將私人原文帶入外部第三方 metadata 呼叫。未連結 Worker 的靜態模式維持舊的 CORS 嘗試，但不保證網站允許讀取。

## 測試／驗收

- [ ] CI：新純模組 URL allowlist、provider HTML/錯誤處理、64 KiB 上限、Worker Owner session / CSRF / 限流；npm test/security
- [ ] CI：Static Assets 新模組可供 PWA/瀏覽器下載，Worker dry-run，Chromium E2E，離線快取 v2.3.5
- [ ] iPhone PWA 已登入；使用公開 YouTube/Shorts 匿名影片網址按讀取，顯示標題和作者；不主動新增標籤、不改備註，保存後能在 Windows 同步
- [ ] TikTok 公開影片能讀則顯示可靠標題；若平台不允許，顯示失敗且仍能保存原網址
- [ ] Threads/Instagram/X 仍可儲存網址，標示待確認，不假裝已擷取貼文全文
- [ ] 讀取期間改變輸入網址、關閉編輯視窗，不將舊回覆寫入新資料
- [ ] 不登入時仍能編輯／保存；讀取受保護服務時會顯示登入要求
- [ ] 原圖收藏、備份還原、Codex 整理、Google Drive 同步回歸正常

## 明確未完成

跨平台貼文正文擷取、Threads/Instagram 授權、X 付費 API、TikTok/YouTube 逐字稿或動態內容讀取，全部不在 v2.3.5。需另開規格並依法合規、按需授權。優先後續探索 iOS 分享文字（由本人分享）作為 AI 分析的可驗證來源，依照原有隱私邊界處理。

參考：
- https://oembed.org/providers/youtube
- https://developers.tiktok.com/docs/en/embed-videos
- https://developers.facebook.com/docs/features-reference/meta-oembed-read/
- https://developers.google.com/youtube/v3/docs/videos/list
