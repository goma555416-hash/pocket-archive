# Pocket Archive v2.1 — Google Drive 架構決策

## 結論

Pocket Archive 保持 local-first，Google Drive 是可選的保存與同步層。純前端 PWA 使用 Google Identity Services（GIS）OAuth token model，直接呼叫 Drive API，要求最小的 `https://www.googleapis.com/auth/drive.file`。前端不含 Client Secret；短效 Access Token 只留在目前頁面的記憶體，重新開啟 App 或失效後必須由使用者再次點擊連結。

雲端結構由 App 建立：

```text
Pocket Archive/
├── Backups/       完整 JSON/ZIP 或 .paenc 歷史備份
├── AI-Inbox/      Codex 待整理 JSON/ZIP
├── AI-Results/    App 預先建立、Codex 原檔覆寫的 organized.json
└── Sync/
    ├── journal-<device-id>.json
    └── Attachments/
```

## 為何選一般 Drive 資料夾 + `drive.file`

- `appDataFolder` 對使用者不可見，而且只限建立它的應用程式存取；不同 OAuth Client 的 Codex 連接器不能拿它當交換區，因此不採用。
- `drive` 全碟權限超出需求且通常涉及更高的 OAuth 驗證負擔，因此不採用。
- `drive.file` 可讓 App 管理它建立或使用者明確授權的檔案；資料夾對使用者可見，也能由另行授權的 Codex Google Drive 連接器找到。
- 不同 OAuth Client 的 per-file grant 不會自動互通。為確保 App 能讀回結果，App 在 `AI-Results` **先建立結果占位檔**；Codex 必須以 `files.update` 覆寫同一 file ID，不能另建 `organized.json`。

## OAuth 與瀏覽器限制

- 使用 GIS token model，不使用已淘汰的 Google Sign-In 平台程式庫，也不在瀏覽器保存 refresh token。
- Google OAuth Web Client 的 Authorized JavaScript origins 必須精確包含 GitHub Pages HTTPS origin；origin 不可包含 path。
- iOS Safari/PWA 關閉後不能保證執行 JavaScript、Service Worker、OAuth 或 Drive 上傳。本實作只承諾：App 開啟且已連結時、資料變更後延遲執行、重新連線/回到前景時補傳。
- 登入彈窗需要使用者操作。既有授權通常可減少同意步驟，但 App 不把「曾同意」誤當成目前仍有有效 token。
- Drive 無法連線、token 過期或上傳失敗不會阻止 IndexedDB 的收藏操作，狀態也不會顯示假成功。

## 完整備份

- 每次備份建立全量 JSON；含附件時建立 ZIP。
- 上傳前算 SHA-256，寫入 Drive `appProperties`；上傳後完整下載回讀並再次計算 SHA-256，通過後才輪替舊備份。
- 預設保留最近 5 份，可設 1–30 份。只會移到垃圾桶由本 App 標示为 `paRole=backup`、且位於 `Backups` 的超額檔案。
- 還原時再次驗證 SHA-256、ZIP CRC、路徑、MIME、附件大小與附件 SHA-256，然後只顯示合併預覽；不直接清空本機資料。
- 可選 PBKDF2-SHA256（250,000 次）+ AES-256-GCM 用戶端加密。密碼不持久化；遺失密碼沒有管理員後門，也無法在另一裝置自動解鎖。
- 同步與 AI 交換資料不套用這個備份加密，因為其他裝置與 Codex 必須讀取 schema。需要端到端加密且仍讓 Codex 分析，必須另行提供受信任的解密執行環境，不可假裝零知識加密與雲端 AI 可同時成立。

## 雙向同步與衝突

- 每個瀏覽器安裝有穩定 `device-id`，只寫自己的 journal，避免多裝置覆寫同一份整庫 ZIP。
- 每筆 upsert/delete 帶向量時鐘。同步時：較新的因果版本套用、較舊版本忽略、並行版本建立衝突。
- 刪除使用 tombstone；刪除與編輯同時發生時先保留資料，防止誤刪，再由使用者選擇版本。
- 使用者解決衝突後會合併兩側時鐘並建立新版本，下一次同步傳播結果。
- 圖片依 SHA-256 去重上傳並在下載後驗證。刪除收藏不會自動刪除雲端附件，以避免其他離線裝置尚未同步時永久遺失；孤立附件的安全清理是後續維護工作。
- 套用遠端狀態時，收藏清單與新下載附件在同一個 `entries + attachments` IndexedDB readwrite transaction 寫入；任何附件錯誤或容量不足都會使整批回滾，不會留下只有 metadata、沒有 Blob 的半套狀態。
- journal 目前單次讀取上限 100 個裝置/100 個附件索引，適合個人使用；不是多租戶團隊同步服務。

## Codex Cloud 交換流程

App 建立 inbox 與結果占位檔，並保留 `export_id`、item ID、schema version。Codex 讀取最新 inbox，實際能讀到內容才分類，驗證後原檔覆寫結果占位檔。App 只接受本機記錄過的 `export_id` 和已知 item ID，先預覽再套用，且保留一次復原快照。

2026-10-18 已在目前 Codex Google Drive 連接器實測匿名 JSON 的 upload → raw fetch → update in place → raw fetch，file ID 維持不變；另上傳匿名 inbox ZIP，以 raw stream 下載後通過 `unzip -t` 並正確讀出 `inbox.json`。兩個臨時檔都在驗證後刪除。這證明目前連接器具有交換所需的 ZIP/JSON 原始下載與原檔寫回能力；Pocket Archive PWA 自身的 OAuth 尚需儲存庫擁有者建立 Web Client ID 後做帳號端驗證。

## 官方參考

- [Google Identity Services OAuth token model](https://developers.google.com/identity/oauth2/web/guides/use-token-model)
- [Choose Google Drive API scopes](https://developers.google.com/drive/api/guides/api-specific-auth)
- [Upload file data](https://developers.google.com/drive/api/guides/manage-uploads)
- [Download and export files](https://developers.google.com/drive/api/guides/manage-downloads)
- [Resolve Drive API errors](https://developers.google.com/drive/api/guides/handle-errors)
- [Drive API usage limits](https://developers.google.com/drive/api/guides/limits)

目前執行環境對 `developers.google.com` 回覆 403，因此無法在本次工作階段保存官方頁面快照；上述設計同時以 Drive REST 行為的程式測試及已授權 Codex 連接器的真實讀寫驗證交叉確認，未把被阻擋的文件讀取寫成已驗證。
