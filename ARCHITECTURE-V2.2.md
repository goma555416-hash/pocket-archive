# Pocket Archive v2.2 架構決策

日期：2026-10-18。正式切換前，v2.1.3 GitHub Pages 與既有 IndexedDB 必須保持可用。

## 決策

採用 **Cloudflare Worker + Static Assets + D1**，讓 PWA 與 `/api/*` 位於同一 HTTPS origin。收藏及附件仍以 IndexedDB 為主；D1 只保存帳號、加密 OAuth 憑證、工作階段與小型收件工作，不保存完整收藏庫。Drive 備份、journal、附件與 AI 交換格式保持 v2.1.3 相容。

```text
iPhone / Windows
  ├─ / 靜態 PWA → IndexedDB（主要資料、離線可用）
  └─ /api/* → Worker
       ├─ D1（Session、加密 Refresh Token、快捷收件工作）
       └─ Google OAuth / Drive API（Worker 代理，不把 Token 交給瀏覽器）
```

Static Assets 命中時不執行 Worker；只有 `/api/*` 使用 Worker。Drive 檔案 request/response 採串流，不在 Worker 或 D1 保存 ZIP／圖片內容。單檔仍受 Cloudflare 帳戶 100 MB request body 上限；App 既有限制為每張圖片 25 MB。

## OAuth 與持續登入

- 後端是單一擁有者服務：以簽章驗證後的 Google `sub` 比對 `OWNER_GOOGLE_SUB`，或用 10 分鐘一次性 bootstrap grant 首次原子綁定 D1。未設定即 fail closed；未授權 callback 在建立 user、credential、Session 前終止，並 best-effort 撤銷剛取得的 Google token。
- `/api/auth/start` 在寫入 OAuth attempt 前先確認 owner policy，並以來源 IP 做 D1 固定視窗限速；這降低單一來源濫用，正式公開 origin 仍應配合 Cloudflare 邊緣限速。
- 使用 Google Web Server Authorization Code flow、`state`、PKCE S256、OIDC `nonce`。
- 回呼以 Google JWKS 驗證 ID Token 的 RS256 簽章、issuer、audience、時間、nonce、`email_verified`。
- Scope 保持 `openid email profile` + `drive.file`；不升級整個 Drive。
- Client Secret 只放 Worker Secret。Refresh Token 與短效 Access Token以 AES-256-GCM 加密後放 D1；瀏覽器只取得不透明 Session cookie。
- Refresh Token rotation 時，以同一更新路徑保存 Google 新回傳的 token；`invalid_grant` 會標記 `reauth_required`，不會刪除 IndexedDB。
- Session cookie 為 `Secure; HttpOnly; SameSite=Lax; Path=/`。預設 idle 14 天、absolute 30 天、每 24 小時 rotation，前一 ID 只保留 5 分鐘併發寬限。所有 authenticated route（含 Drive proxy 與錯誤回應）都傳遞新 Cookie；併行舊 Cookie 請求會從加密保存的當前 rotation token 收斂到同一 ID。資料庫更新要求 Session 尚未撤銷，因此輪替不會復活撤銷的工作階段。
- 寫入 API 要求同來源、`Sec-Fetch-Site` 檢查與 double-submit CSRF token。OAuth attempt 10 分鐘到期且只能使用一次。
- UI 可登出目前裝置、撤銷指定裝置或撤銷 Google grant 與全部工作階段。完整撤銷會刪除 OAuth credential row，因此 Refresh Token 密文不會留在 D1；獨立的捷徑憑證需由快速收藏設定逐一管理。

「持續登入」不是永久登入。Session 過期、使用者/Workspace 管理員撤銷、Google `invalid_grant`、Refresh Token 到期或安全策略要求時，App 會要求重新登入。

## Google Testing 七天限制

External 且 Publishing status 為 **Testing** 的專案，如果取得 `drive.file` 等非純身分 scope，refresh token 一般會在 7 天到期。這是 Google 平台政策，不能以自動 popup 或把 token 放瀏覽器規避。個人長期使用應將 OAuth app 切到 **Production**。

`drive.file` 是 Google Drive 推薦的最小檔案級 scope；是否需要品牌／應用程式驗證仍以 Cloud Console 當下提示、使用者類型與發布範圍為準。只供擁有者個人使用不代表可以忽略 Console 的 Publishing status。切換 Production 後應重新授權一次，讓 D1 收到新的 refresh token。

沿用原本同一 Google Cloud project 與 OAuth Web Client，新增 Worker callback URI，是保留 `drive.file` 既有工作區可見性的最低風險做法。改用另一 project/client 時，不能假設新 app 自動看到舊 client 建立的資料夾；先走完整 ZIP 搬移或明確重新授權／選取資料夾，不得擴大成 `drive` scope。

## 加密與金鑰輪替

`TOKEN_ENCRYPTION_KEY` 是 32-byte base64url secret；ciphertext 格式帶 key version，AES-GCM additional data 綁定版本。輪替步驟：

1. 保留舊 key 為 `TOKEN_ENCRYPTION_KEY_PREVIOUS`，設定其 version。
2. 產生新 key，提升 `TOKEN_ENCRYPTION_KEY_VERSION` 並部署。
3. 新登入與下一次成功 Drive 存取會以新 key 重新加密 Access/Refresh Token；不必等 Access Token 到期。確認所有有效 grant 已更新後才刪除 previous key。
4. 刪除舊 key 前先做 D1 備份；遺失仍被資料引用的 key 只能要求使用者重新授權。

所有錯誤回應均不回傳 token、authorization code、cookie 或 Google 原始敏感內容；正式環境不可記錄 request headers/body。

## 免費額度與失效行為

依 2026-10-18 Cloudflare 官方文件來源：

- Workers Free：100,000 requests/day、HTTP request 10 ms CPU、50 subrequests、6 同時外連；超量時 Worker API 回 429/Error 1027。
- 帳戶 Free request body 上限 100 MB；Worker isolate 記憶體 128 MB，因此代理採 streaming。
- D1 Free：單庫 500 MB、每次 Free Worker 最多 50 queries；官方定價表的免費日額為 5M rows read、100k rows written，午夜 UTC 重設。
- Static Assets 請求免費且不限量；若 `/api/*` 超量，既有離線快取與本機 IndexedDB 仍可使用。
- Google Drive API 另有 per-user/per-project 配額；429/5xx 可重試，401/`invalid_grant` 要重新授權。

個人低流量預期遠低於免費額度，但免費額度不是 SLA。API 不可用時，App 不宣稱備份／同步成功，且不阻擋本機新增、搜尋、匯出與還原。

## 威脅邊界

- 防護：OAuth state/nonce/PKCE、OIDC 簽章、CSRF、session fixation/rotation、同來源檢查、固定 Drive endpoint 與欄位白名單、檔案 ID 驗證、CSP/安全 headers、敏感值加密、錯誤去敏。
- SSRF：Worker 不接受任意 upstream URL；Drive proxy 路徑與 Google host 固定。
- XSS：既有 UI 使用 escaping，並新增 CSP。XSS 仍可能代表使用者操作，因此需持續避免 `innerHTML` 注入未轉義值。
- D1 不是私人收藏備份；D1 遺失時可重新登入，不應造成 IndexedDB／Drive 收藏消失。

## 快速收件佇列

Shortcut credential 只具 `capture:create`，資料庫只保存 secret 的 SHA-256。每分鐘最多 30 次、每次必須帶 8–128 字元 `Idempotency-Key`，API 會依既有 URL 正規化移除 tracking parameters。待處理工作保留 30 天；完成時立即清除原始分享文字／標題，完成狀態 7 天後刪除。App 以兩分鐘 lease 取得最多 20 筆，先完成 IndexedDB 原子寫入再 ack；另一裝置不能同時取得同一工作。失敗會釋放重試，十次後標記 failed 而不靜默遺失原始提交。

## 官方來源與研究限制

- [Google OAuth 2.0 for Web Server Applications](https://developers.google.com/identity/protocols/oauth2/web-server)
- [Google OAuth refresh-token expiration](https://developers.google.com/identity/protocols/oauth2#expiration)
- [Google Drive scopes](https://developers.google.com/drive/api/guides/api-specific-auth)
- [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Cloudflare D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
- [Cloudflare Static Assets](https://developers.cloudflare.com/workers/static-assets/)
- [Apple Shortcuts User Guide](https://support.apple.com/guide/shortcuts/welcome/ios)

本執行環境對 Google、Cloudflare 與 Apple 官方網站直接請求回覆 403。Cloudflare 數值另由其官方 `cloudflare/cloudflare-docs` repository 當日 `production` 文件來源核對；Google/Apple 來源 URL 已保留，但未宣稱保存了網頁快照。帳號端實際畫面與政策仍須在正式設定時再次確認。
