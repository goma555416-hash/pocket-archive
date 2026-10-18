# Cloudflare Worker + D1 設定

以下操作會建立帳號資源及正式部署，必須由帳號擁有者執行。不要把任何 Secret 貼到對話、Issue、commit 或前端設定。

> **合併前硬性前置作業：** `main` 更新會觸發既有 GitHub Pages 自動部署。第一次合併任何 v2.2 PR 前，務必先在舊站下載一份完整 ZIP，確認檔案可開啟並另存至少一份副本。不要等待 Worker 部署後才備份；v2.2 不會自動搬移、清除或改寫舊 origin 的 IndexedDB。

## 1. 建立 D1

1. Cloudflare Dashboard → **Storage & Databases → D1 SQL Database → Create**。
2. 名稱輸入 `pocket-archive`。
3. 複製 Database ID，取代 `wrangler.jsonc` 的 `REPLACE_WITH_D1_DATABASE_ID`。
4. 本機先登入 Wrangler：`npx wrangler login`。
5. 套用 schema：`npx wrangler d1 migrations apply pocket-archive --remote`。

這只建立帳號／Session metadata，不會匯入任何私人收藏。

## 2. 產生加密金鑰

在自己的終端執行；不要把輸出保存到 Git：

```bash
openssl rand -base64 32 | tr '+/' '-_' | tr -d '=' | npx wrangler secret put TOKEN_ENCRYPTION_KEY
```

再依序設定：

```bash
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

雖然 Client ID 可公開，後端同樣以部署設定管理。`TOKEN_ENCRYPTION_KEY_VERSION=1` 已是非敏感變數。不要把 Client Secret 放入 `wrangler.jsonc`。

## 3. 設定唯一擁有者（未設定即拒絕登入）

正式環境必須選一種方式。授權判斷只使用 Google 簽章驗證後的穩定 `sub`，不以可變更的 email 當白名單。

### 方式 A：預先設定 `sub`（建議）

從自己控制的受信任 OIDC 管理流程取得 Google 帳號 `sub`，在自己的終端設定；不要貼到聊天或 Issue：

```bash
npx wrangler secret put OWNER_GOOGLE_SUB
```

重新部署後，只有該 `sub` 能在 OAuth callback 建立使用者、Refresh Token 與 Session。若設定錯誤，後端會拒絕登入；不要改用 email 迴避。

### 方式 B：一次性首次綁定

先在本機密碼管理器產生至少 32 bytes 的隨機值，直接送入 Wrangler，避免 shell history 保存明文：

```bash
openssl rand -base64 32 | tr '+/' '-_' | tr -d '=' | npx wrangler secret put OWNER_BOOTSTRAP_TOKEN
```

部署後由同來源 PWA 的「首次擁有者設定」輸入一次性綁定碼，隨即用預定成為擁有者的 Google 帳號完成登入。綁定 grant 只有 10 分鐘、只能使用一次；D1 會保存簽章驗證後的 `sub`。成功後立即刪除 bootstrap secret 並重新部署：

```bash
npx wrangler secret delete OWNER_BOOTSTRAP_TOKEN
```

未設定 `OWNER_GOOGLE_SUB`、尚未完成 D1 綁定且沒有有效一次性 grant 時，`/api/auth/start` 預設拒絕，不會建立 OAuth attempt。錯誤綁定碼每個來源 IP 每小時最多 5 次；OAuth start 預設每個來源 IP 每 10 分鐘 10 次（可用非敏感 `OAUTH_START_LIMIT` 調低，最小 3）。這可限制一般誤用與 D1 寫入，但無法取代 Cloudflare WAF／Rate Limiting 對分散式攻擊的保護。

## 4. Google Cloud

優先沿用 v2.1 使用的同一 project / Web Client：

1. Google Cloud Console → **Google Auth Platform → Clients** → 選既有 Web client。
2. **Authorized redirect URIs** 加入 `https://YOUR-WORKER-HOST/api/auth/callback`，必須完全一致且不可多斜線。
3. 保留原 GitHub Pages Authorized JavaScript origin，直到遷移與回滾完成。
4. **Audience / Publishing status**：長期使用需由 Testing 切為 Production；依 Console 提示完成必要資料或驗證。
5. 不增加 `drive` scope；保持 `drive.file`。

正式切換後首次登入要重新同意一次。舊 Google Drive 工作區是否可見，必須先用匿名測試資料驗證；不可在看不到舊資料夾時直接建立第二套並盲目雙向合併。

## 5. 部署前設定 origin

把 `wrangler.jsonc` 的 `APP_ORIGIN` 改為最後 HTTPS origin，例如 `https://pocket-archive.example.workers.dev`。若未購買網域，可先使用免費 `workers.dev` 子網域；本任務不會代為開帳號、綁卡、買網域或公開部署。

執行：

```bash
npm ci
npm test
npm run test:e2e
npx wrangler deploy
```

部署後以瀏覽器開 `/api/session`：未登入應回 JSON 401，而不是 HTML。確認 `/`、離線啟動、本機收藏和下載備份後，再做 Google 登入。

## 6. 金鑰輪替

1. 先把舊 key 放入 `TOKEN_ENCRYPTION_KEY_PREVIOUS`，並把舊版本放入非敏感變數 `TOKEN_ENCRYPTION_KEY_PREVIOUS_VERSION`。
2. 設定新 `TOKEN_ENCRYPTION_KEY`，提升 `TOKEN_ENCRYPTION_KEY_VERSION`，套用 migration 後部署。
3. 每個既有擁有者下一次成功使用 Drive 時，即使 Access Token 尚未到期，也會把既有 Access Token 與 Refresh Token 重新加密成目前版本；Google 回傳新 Refresh Token 時也走相同更新路徑。
4. 用 D1 查詢確認 `oauth_credentials` 中所有非空密文都以新版本前綴開頭，再等待至少 5 分鐘讓 Session rotation 過渡密文失效，並完成 D1 備份，才能刪除 previous key。仍有舊版本時不要刪除；否則只能撤銷本機 credential 並要求重新授權。

「撤銷 Google 授權與所有裝置」會先嘗試呼叫 Google revoke，無論 Google 暫時是否可達，都會刪除 D1 的整筆 OAuth credential（包含 Refresh Token 密文）並撤銷全部網頁 Session。iPhone 捷徑憑證是獨立的最小權限憑證，不會被此按鈕暗中撤銷；應在「iPhone 快速收藏」清單逐一撤銷或輪替。
