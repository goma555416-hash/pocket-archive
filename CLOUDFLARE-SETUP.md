# Cloudflare Worker + D1 初次部署（Windows PowerShell 7）

本文件只描述帳號擁有者核准後的正式部署操作。所有 Cloudflare、Google 與擁有者 Secret 都必須在自己的 Windows 電腦或密碼管理器中輸入；不得貼到對話、Issue、commit、螢幕錄影或前端設定。

目前固定設定：

- Worker：`pocket-archive`
- 正式 origin：`https://pocket-archive.goma555416.workers.dev`
- OAuth callback：`https://pocket-archive.goma555416.workers.dev/api/auth/callback`
- D1：`pocket-archive`（`8db0c270-eae9-4da2-9347-e0ae5219ca8f`）

責任邊界：

| 執行者 | 可執行事項 |
| --- | --- |
| Codex / CI | 更新非敏感設定、檢查 migration、執行本機測試與 Worker dry-run、建立 PR |
| 帳號擁有者 | 核准／合併 PR、舊站備份、`wrangler login`、Google Console callback、遠端 D1 migration、正式 deploy、輸入／刪除 Secrets、綁定擁有者與實機驗收 |

下列第 1 節可由 Codex 或帳號擁有者重跑；第 2 節起只由帳號擁有者在自己的安全環境執行。本次 preflight 不會代做任何第 2 節以後的帳號操作。

> **資料前置作業：** 原訂要求是第一次合併 v2.2 前，先從舊 GitHub Pages 下載並驗證完整 ZIP。若三個 v2.2 PR 已合併但這一步尚未完成，先停止 Cloudflare 部署，立即在仍保留原 IndexedDB 的舊 Pages origin 下載完整 ZIP，確認可開啟並保存第二份副本。不要清除網站資料。Worker 與 Pages 是不同 origin，不會自動搬移、改寫或刪除彼此的 IndexedDB。

## 1. 在核准的 commit 做本機驗證

安裝 Git、Node.js 20+ 與 PowerShell 7，從 repository 根目錄執行：

```powershell
git switch main
git pull --ff-only origin main
git status --short --branch
npm ci
npm test
npm run test:security
npm run test:assets
npm run test:e2e

$env:XDG_CONFIG_HOME = Join-Path $env:TEMP 'pocket-archive-wrangler-config'
$localD1 = Join-Path $env:TEMP 'pocket-archive-d1-preflight'
npx wrangler d1 migrations apply pocket-archive --local --persist-to $localD1
npx wrangler deploy --dry-run --outdir (Join-Path $env:TEMP 'pocket-archive-worker-build')
```

`wrangler.jsonc` 必須仍保留 Worker entry、Static Assets `ASSETS` binding、`/api/*` Worker-first routing、D1 `DB` binding，以及本頁列出的正式 origin / Database ID。dry-run 不會部署。

### Static Assets 安全邊界

目前 `assets.directory` 保持 repository 根目錄，因為 PWA 的 `index.html`、CSS、JavaScript modules、`sw.js`、Manifest、icons 與 Pages 發布流程都以現有根路徑運作。改成 `public/` 白名單目錄理論上更安全，但會同時牽動 Service Worker 快取路徑、GitHub Pages artifact、模組位置與雙 origin 回滾；本次不以部署安全補修為由進行這項結構性搬移。

現階段使用兩層防護：

1. `.gitignore` 阻止 `.dev.vars*`、`.env*`、私有備份、AI 匯出與本機工具資料進入 Git。
2. `.assetsignore` 獨立阻止上述資料以及 `.wrangler/`、`private-data/`、`exports/`、測試／Worker source／repository metadata 進入 Cloudflare Static Assets。

`npm run test:assets` 會建立內容明確標示為非機密的暫存哨兵檔，以實際本機 Wrangler server 驗證私有路徑全部為 `404`，同時確認 HTML、CSS、JavaScript、Manifest 與 icons 仍可提供；測試結束會只刪除自己建立的精確檔名。未通過此測試或 dry-run 時不得正式部署。未來若要改用真正的 `public/` 白名單，應另開 PR 並同時驗證 Worker、Pages、PWA 更新與離線回滾。

## 2. 登入並核對 Cloudflare 帳號

```powershell
npx wrangler login
npx wrangler whoami
```

在瀏覽器完成 Cloudflare 授權後，人工確認顯示的是建立 `pocket-archive` Worker 與 D1 的同一帳號。不要使用別人的 API Token，也不要把 Token 寫入 `.env`、`.dev.vars` 或 shell profile。

## 3. 先設定 Google OAuth callback

Google Cloud Console → **Google Auth Platform → Clients** → 選擇既有 Web Client：

1. 在 **Authorized redirect URIs** 加入 `https://pocket-archive.goma555416.workers.dev/api/auth/callback`；必須完全一致，結尾不可多 `/`。
2. 保留原 GitHub Pages 的 Authorized JavaScript origin 與舊設定，直到遷移及回滾驗收完成。
3. 保持最小 `drive.file` scope，不改成完整 Drive scope。
4. 長期使用須依 Google Console 要求完成 Audience / Publishing status；不要把 Client Secret 放入前端或 Git。

Worker 使用 Authorization Code + PKCE，因此 callback 由後端處理。前端對 Worker 的請求都是同來源 `/api/...`，不需要把 Secret 或 Refresh Token 交給瀏覽器。

## 4. 套用遠端 D1 migrations

先列出待套用檔案，再由帳號擁有者確認套用：

```powershell
npx wrangler d1 migrations list pocket-archive --remote
npx wrangler d1 migrations apply pocket-archive --remote
npx wrangler d1 migrations list pocket-archive --remote
```

第一次套用應依序包含：

1. `0001_auth.sql`
2. `0002_capture.sql`
3. `0003_owner_session_security.sql`
4. `0004_capture_images.sql`（v2.3 新增；既有正式 D1 只需新增此項）

最後一次 `list` 應沒有未套用 migration。這些表只保存驗證、Session、加密 OAuth credential、快捷收件與安全 metadata；不會匯入私人收藏。不要跳過 `0003`，否則唯一擁有者與安全 Session 欄位不存在。

## 5. 先部署 fail-closed 版本，再輸入 Secrets

`wrangler secret put` 在不同 Workers versioning 狀態下可能建立並立即啟用新版本；因此把每一次 secret 變更都當成一次部署。安全順序是先部署程式與 migration，但不提供任何 Secret：缺少必要設定時 API 會 fail closed，且尚未設定擁有者時任何 Google 帳號都不能註冊。

```powershell
npx wrangler deploy
```

這是第一次真正部署，必須等 PR 核准並由帳號擁有者親自執行。本 repository 的自動化與 Codex 不會代跑。

接著依序執行下列命令，值只在 Wrangler 的互動提示中輸入：

```powershell
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

在記憶體產生 32-byte 加密金鑰並直接送給 Wrangler，不寫檔也不印出：

```powershell
$keyBytes = [byte[]]::new(32)
[Security.Cryptography.RandomNumberGenerator]::Fill($keyBytes)
$tokenKey = [Convert]::ToBase64String($keyBytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
$tokenKey | npx wrangler secret put TOKEN_ENCRYPTION_KEY
Remove-Variable tokenKey, keyBytes
```

`TOKEN_ENCRYPTION_KEY_VERSION=1` 是已提交的非敏感變數。不要把以上 Secret 放進 `wrangler.jsonc`，也不要用會把明文留在 PowerShell history 的命令參數。

## 6. 一次性綁定唯一擁有者

### 方式 A：預先設定 Google `sub`

如果能從自己控制的受信任 OIDC 管理流程取得穩定 Google `sub`，最後設定：

```powershell
npx wrangler secret put OWNER_GOOGLE_SUB
```

只使用 Google 簽章驗證後的 `sub` 授權，不以可變更的 email 當白名單。值不要貼到聊天或 Issue。

### 方式 B：一次性首次綁定

如果不預先設定 `sub`，在密碼管理器建立至少 32 bytes 的隨機值並暫存，最後設定：

```powershell
npx wrangler secret put OWNER_BOOTSTRAP_TOKEN
```

然後立即：

1. 開啟 `https://pocket-archive.goma555416.workers.dev`。
2. 在「首次擁有者設定」貼入一次性綁定碼；不要放在 URL。
3. 於 10 分鐘內用預定成為唯一擁有者的 Google 帳號完成登入。
4. 確認登入成功後立刻刪除 bootstrap secret：

   ```powershell
   npx wrangler secret delete OWNER_BOOTSTRAP_TOKEN
   ```

5. 清除剪貼簿與密碼管理器中的一次性值，再確認 `/api/owner/status` 顯示已綁定且不可再次 bootstrap。

`secret delete` 也可能啟用新版本；D1 中已綁定的簽章驗證 `sub` 會保留，因此刪除一次性 Secret 不會解除擁有者。不要同時設定錯誤的 `OWNER_GOOGLE_SUB` 與 bootstrap 流程。

在 `OWNER_GOOGLE_SUB` 或有效 bootstrap grant 都不存在時，`/api/auth/start` 會拒絕且不建立 OAuth attempt。bootstrap 錯誤每來源 IP 每小時最多 5 次；OAuth start 預設每來源 IP 每 10 分鐘 10 次，以限制濫用與 D1 消耗。

## 7. 部署後只用匿名資料驗收

依序確認：

1. `/` 載入 PWA；`/api/session` 未登入時回 JSON `401`，不是 Static Assets HTML。
2. Google callback 實際導回相同 workers.dev origin，合法擁有者可登入，其他 Google 帳號被拒絕。
3. 關閉並重新開啟 iPhone PWA 後仍可恢復 Session；超過五分鐘後 Drive API 仍可使用。
4. 離線重新開啟可讀到已快取 UI；Service Worker 不快取 `/api/*` 回應。
5. 只以匿名 URL / 圖片演練完整備份、Drive workspace、同步、快速收藏與回滾。
6. 驗收完成前保留 GitHub Pages origin、舊 IndexedDB、舊 OAuth JavaScript origin 與完整 ZIP；不要自動 redirect 或清除資料。

iPhone 快捷憑證只能在擁有者登入後由 UI 建立，權限僅 `capture:create`。每支裝置使用不同憑證；撤銷 Google grant 不會暗中撤銷快捷憑證，需在 UI 個別撤銷或輪替。

## 8. Token 加密金鑰輪替

1. 先把舊 key 設為 `TOKEN_ENCRYPTION_KEY_PREVIOUS`，並把舊版本填入非敏感 `TOKEN_ENCRYPTION_KEY_PREVIOUS_VERSION`。
2. 設定新的 `TOKEN_ENCRYPTION_KEY`，提高 `TOKEN_ENCRYPTION_KEY_VERSION`，再部署。
3. 每個既有擁有者下一次成功使用 Drive 時，既有 Access Token 與 Refresh Token 會重新加密為目前版本。
4. 以 D1 確認所有非空密文都有新版本前綴；等待至少五分鐘讓 Session rotation 過渡密文失效並完成 D1 備份後，才能刪除 previous key。

仍有舊版本密文時不可刪除 previous key，否則只能撤銷 credential 並重新授權。「撤銷 Google 授權與所有裝置」會先刪除 D1 整筆 OAuth credential（包含 Refresh Token 密文）與網頁 Session，再 best-effort 呼叫 Google revoke；快捷憑證仍依 UI 說明獨立管理。

## v2.3 更新

已有 v2.2 的擁有者只需依 [CAPTURE-IMAGES.md](./CAPTURE-IMAGES.md) 合併後單一清單備份、核准 0004 migration、部署與 cron，再更新既有捷徑。不要重新設定 Secret／OAuth／擁有者；完整 UAT 見 UAT-V2.3.md。
