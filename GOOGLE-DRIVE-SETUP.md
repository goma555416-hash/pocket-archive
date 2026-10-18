# Google Drive / OAuth 最小設定

只有 Google 帳號擁有者能完成以下步驟；Repository 不需要也不應保存 Client Secret、Access Token 或 refresh token。

1. 到 [Google Cloud Console](https://console.cloud.google.com/) 建立或選擇專案。
2. **APIs & Services → Library** 啟用 **Google Drive API**。
3. **Google Auth Platform / OAuth consent screen** 設定 App 名稱 `Pocket Archive`、支援 email 與必要聯絡資料。若仍為 Testing，加入實際使用的 Google 帳號為 Test user。
4. **Clients → Create client → Web application**。
5. Authorized JavaScript origins 加入實際 origin，不可帶路徑：
   - 正式 Pages：`https://goma555416-hash.github.io`
   - 本機測試：`http://localhost:5173`
   - 若用 E2E：`http://127.0.0.1:4173`
   - 若有自訂網域，再加入該 HTTPS origin。
6. GIS token model 不使用 redirect callback，本專案不需要設定 Client Secret 或把 Authorized redirect URI 寫進程式。
7. 複製公開的 **Client ID**（結尾為 `.apps.googleusercontent.com`）。在 Pocket Archive →「Drive 同步」貼上並保存。
8. 點「連結 Google Drive」，確認同意畫面只要求 Pocket Archive 建立/開啟檔案的 `drive.file`。完成後 App 會建立 `Pocket Archive/` 和四個子資料夾。
9. 在 iPhone 與 Windows 使用同一個部署網址、同一 Client ID、同一 Google 帳號，各自連結一次，再執行人工驗收。

## Codex Cloud

1. 在 Codex 的 Apps/Connectors 連結 Google Drive。這是和 PWA 分開的 OAuth 授權；不要假設 PWA 的同意會自動授權 Codex。
2. 在 Pocket Archive 先建立 AI 工作，確保 Drive 中同時存在 `AI-Inbox/pocket-archive-inbox-…` 與 `AI-Results/organized-<export_id>.json` 占位檔。
3. 讓 Codex 依 [CODEX-DRIVE-WORKFLOW.md](./CODEX-DRIVE-WORKFLOW.md) 處理。Codex 必須覆寫占位檔，不可建立一個 PWA 可能無權讀取的新檔。

## 常見錯誤

- `origin_mismatch`：實際網址的 scheme/host/port 沒有逐字列在 Authorized JavaScript origins。
- `access_denied`：測試模式未加入 Test user、使用者拒絕，或 Workspace 管理員禁止此 App。
- `401`：短效 token 已失效；重新點「連結 Google Drive」。App 不保存 refresh token。
- App 看不到 Codex 新建的檔案：這是不同 OAuth Client + `drive.file` 的預期限制；請讓 Codex update App 預建的結果 file ID。
- iPhone 關閉後沒有同步：純前端 PWA 不保證背景工作；重新打開 App 並連結後會補傳。
