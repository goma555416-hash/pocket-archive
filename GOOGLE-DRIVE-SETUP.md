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
6. GIS token model 只支援 dialog UX，不使用 redirect callback；本專案不需要設定 Client Secret 或把 Authorized redirect URI 寫進程式。不要替 Token Model 加上不存在的 redirect 選項。
7. 複製公開的 **Client ID**（結尾為 `.apps.googleusercontent.com`）。在 Pocket Archive →「Drive 同步」貼上並保存。
8. 開啟「Drive 同步」後，若按鈕顯示「正在準備 Google 登入…」，先等它恢復成「連結 Google Drive」，再直接點一下。App 會在這次點擊的同步事件內呼叫 `requestAccessToken()`；確認同意畫面只要求 Pocket Archive 建立/開啟檔案的 `drive.file`。完成後 App 會建立 `Pocket Archive/` 和四個子資料夾。
9. 在 iPhone 與 Windows 使用同一個部署網址、同一 Client ID、同一 Google 帳號，各自連結一次，再執行人工驗收。

## Codex Cloud

1. 在 Codex 的 Apps/Connectors 連結 Google Drive。這是和 PWA 分開的 OAuth 授權；不要假設 PWA 的同意會自動授權 Codex。
2. 在 Pocket Archive 先建立 AI 工作，確保 Drive 中同時存在 `AI-Inbox/pocket-archive-inbox-…` 與 `AI-Results/organized-<export_id>.json` 占位檔。
3. 讓 Codex 依 [CODEX-DRIVE-WORKFLOW.md](./CODEX-DRIVE-WORKFLOW.md) 處理。Codex 必須覆寫占位檔，不可建立一個 PWA 可能無權讀取的新檔。

## 常見錯誤

- `origin_mismatch`：實際網址的 scheme/host/port 沒有逐字列在 Authorized JavaScript origins。
- `access_denied`：測試模式未加入 Test user、使用者拒絕，或 Workspace 管理員禁止此 App。
- `401`：短效 token 已失效；重新點「連結 Google Drive」。App 不保存 refresh token。
- `popup_failed_to_open`：先確認按鈕已結束「正在準備」狀態，再由手指直接點一次；不要從自動化點擊、延遲 callback 或其他 App 返回事件啟動。v2.1.2 已將 IndexedDB 設定保存移到 popup 觸發之後，並在使用者點擊前預先載入/初始化 GIS。
- App 看不到 Codex 新建的檔案：這是不同 OAuth Client + `drive.file` 的預期限制；請讓 Codex update App 預建的結果 file ID。
- iPhone 關閉後沒有同步：純前端 PWA 不保證背景工作；重新打開 App 並連結後會補傳。

## iPhone Safari／主畫面 PWA 實機驗證

目前自動化環境沒有 iPhone 或可執行的 WebKit browser binary，因此以下仍需在實機完成，不能以 Chromium 結果取代：

1. 從 Safari 開啟正式 HTTPS 網址並更新頁面，再從主畫面完全關閉、重新開啟 Pocket Archive，確認新版 Service Worker 已生效。
2. 打開「Drive 同步」，等待「正在準備 Google 登入…」消失，直接點「連結 Google Drive」。
3. 確認 Google 帳號選擇／同意視窗成功開啟，且不再顯示 `popup_failed_to_open`；若 iOS 詢問是否允許開啟視窗，選擇允許。
4. 完成同意後確認畫面顯示已連結帳號，手動執行一次「立即備份」與「立即同步」。
5. 到 Drive 確認只建立/更新 Pocket Archive 管理的資料夾與檔案；回到 PWA 確認本機收藏與圖片仍完整。
6. 完全關閉再開啟 PWA，確認 Token 沒有被永久保存、需重新點擊連結，而 IndexedDB 收藏仍存在。

若特定 iOS 版本在直接手勢下仍無法使用 GIS popup，不應把 Token Model 假設成可 redirect。安全替代方案是另建後端 Authorization Code flow，由伺服器處理 code exchange、CSRF state 與 refresh token；Client Secret 絕不可放進這個純前端 PWA。這會改變部署與威脅模型，因此本修正未擅自加入。

設計依據：[Google GIS Token Model](https://developers.google.com/identity/oauth2/web/guides/use-token-model) 明確要求由 user gesture 呼叫 `requestAccessToken()`，且只支援 dialog UX；[WebKit User Activation API](https://webkit.org/blog/13862/the-user-activation-api/) 說明 popup 等受 transient activation 管制的操作必須避免在開啟前跨越會耗盡或逾時的非同步工作。
