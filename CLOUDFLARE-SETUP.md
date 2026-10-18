# Cloudflare Worker + D1 設定

以下操作會建立帳號資源及正式部署，必須由帳號擁有者執行。不要把任何 Secret 貼到對話、Issue、commit 或前端設定。

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

## 3. Google Cloud

優先沿用 v2.1 使用的同一 project / Web Client：

1. Google Cloud Console → **Google Auth Platform → Clients** → 選既有 Web client。
2. **Authorized redirect URIs** 加入 `https://YOUR-WORKER-HOST/api/auth/callback`，必須完全一致且不可多斜線。
3. 保留原 GitHub Pages Authorized JavaScript origin，直到遷移與回滾完成。
4. **Audience / Publishing status**：長期使用需由 Testing 切為 Production；依 Console 提示完成必要資料或驗證。
5. 不增加 `drive` scope；保持 `drive.file`。

正式切換後首次登入要重新同意一次。舊 Google Drive 工作區是否可見，必須先用匿名測試資料驗證；不可在看不到舊資料夾時直接建立第二套並盲目雙向合併。

## 4. 部署前設定 origin

把 `wrangler.jsonc` 的 `APP_ORIGIN` 改為最後 HTTPS origin，例如 `https://pocket-archive.example.workers.dev`。若未購買網域，可先使用免費 `workers.dev` 子網域；本任務不會代為開帳號、綁卡、買網域或公開部署。

執行：

```bash
npm ci
npm test
npm run test:e2e
npx wrangler deploy
```

部署後以瀏覽器開 `/api/session`：未登入應回 JSON 401，而不是 HTML。確認 `/`、離線啟動、本機收藏和下載備份後，再做 Google 登入。

## 5. 金鑰輪替

先把舊 key 放入 `TOKEN_ENCRYPTION_KEY_PREVIOUS`，把舊版本放入非敏感變數 `TOKEN_ENCRYPTION_KEY_PREVIOUS_VERSION`；再設定新 key 並提升 `TOKEN_ENCRYPTION_KEY_VERSION`。保持 previous key 至所有有效 grant 已重新登入或 refresh。不要先刪舊 key。
