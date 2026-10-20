# v2.3 最後一次實機驗收（10–15 分鐘）

PR 經本人審閱核准，依 CAPTURE-IMAGES.md 的單一部署清單完成 migration／部署後，再執行本清單。只用匿名網址與合成圖片，不上傳真實私藏或憑證。自動化不代表已在 Google／iPhone／Windows 實機成功。

1. **原圖（2 分鐘）**：iPhone Safari 與主畫面 PWA 各開一次。加入直幅、橫幅、長圖，卡片主體應完整。點圖，縮放／雙指／拖移，下載原檔；關閉後焦點回卡片。Windows 鍵盤 Tab/Enter 開圖、+/−/0、ESC。HEIC 若不可解碼須提示並能下載，不可悄悄轉檔。
2. **共用捷徑（3 分鐘）**：保留 URL 回滾副本，依 IOS-SHORTCUT.md 更新原名稱。從照片／檔案分享一張、再多選兩張合成圖片（每張 <4 MiB），結果逐張為安全收件。重送一張為 duplicate。5 MiB 原檔應未收件，改由 App 直接選圖。關網路試一次，只能顯示失敗／系統錯誤，不能通知成功。
3. **入庫／同步／備份（3 分鐘）**：開 iPhone App，圖片自動入庫，原始檔名、MIME、bytes 不變，等待「立即雙向同步」完成；Windows 同帳號同步後查看及下載原圖。用合成原檔在電腦算 SHA-256 比較。下載完整 ZIP、預覽還原，確認原圖存在且沒有重複加入。收件後關閉 App 再開一次，不應重複。
4. **既有 URL（2 分鐘）**：同一捷徑分享匿名 URL，確認 accepted；重送 duplicate；純文字無網址提示；離線失敗提示。原有 Google 登入、自動恢復 Session、備份及同步按鈕正常。
5. **Codex（3 分鐘）**：選一小批匿名收藏，明確按「送到 Drive AI-Inbox」再「一鍵複製 Codex 指令」。確認指令含正確 export_id、repo、必讀規則、App 已驗證的 inbox/result file ID 與 raw SHA-256，以及禁止 Notion。在有 Drive raw download／原檔更新能力的 Codex 執行，AI-Results 同一 file ID 回寫並回讀；重做同批不能另建結果。若連接器缺能力，應明確停止，不能轉搜 Notion。App「檢查結果」先預覽，勾選後才套用，可復原。

必要本人核准集中於 CAPTURE-IMAGES.md：備份 → 審閱 CI → 遠端 migration 0004 → 部署與 cron → 更新捷徑。無新增 Secret／OAuth scope／AI 費用。若 Google 連接器缺 raw 下載／原檔更新能力，使用明確的離線檔案流程；這不是自動 Drive 整理成功。
