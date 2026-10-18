# Pocket Archive v2.2 實機驗收（約 15 分鐘）

只用匿名測試 URL／圖片。開始前先從舊站下載完整備份，不清除任何網站資料。

## iPhone：登入與持續工作階段

1. Safari 開啟新 HTTPS origin，加入主畫面；確認版本 `V2.2.0`、舊收藏尚未被假設自動搬入。
2. 先依部署文件設定 `OWNER_GOOGLE_SUB`，或用一次性 bootstrap 綁定；未設定時登入按鈕必須停用，不能讓任意 Google 帳號註冊。可用另一個測試 Google 帳號確認 callback 被拒絕，且 D1 不新增 user、OAuth credential 或 Session。
3. 以合法擁有者登入 Google；同意畫面只能包含基本身分與 `drive.file`，不得要求整個 Drive。
4. 完全關閉主畫面 App 後重開；應顯示已連結並自動補同步，不應再點「連結」。放置至少 5 分鐘後再呼叫 Drive，仍不得要求手動登入。
5. 在「已登入裝置」確認 iPhone 工作階段。若手動撤銷此裝置，重新開啟應明確要求登入，本機收藏仍存在。

## iPhone：分享捷徑

1. 依 [IOS-SHORTCUT.md](./IOS-SHORTCUT.md) 建立「存到 Pocket Archive」。
2. 從 Safari 分享一個匿名 URL，再從 YouTube 或其他 App 分享一個 URL；通知應說「已送出」，不是「已同步全部裝置」。
3. 重跑同一個 `Idempotency-Key` 測試或快速重試；伺服器應回 duplicate，不新增兩筆。
4. 分享不含 URL 的純文字，必須提示沒有網址。開飛航模式再分享，必須顯示尚未收件，不能假成功。
5. 打開 Pocket Archive，確認顯示實際收入筆數。撤銷捷徑憑證後再分享，應要求重新配對。

## Windows 與 Drive 收斂

1. Windows 開同一新 origin 並登入同一 Google 帳號；確認裝置清單同時有 iPhone／Windows。
2. 執行同步，確認 iPhone 快捷收入的匿名 URL 出現。
3. Windows 刪除其中一筆並同步，再在 iPhone 同步；刪除不得復活。兩端同時編輯另一筆時應進入衝突面板，不靜默覆寫。
4. 建立一份完整 Drive 備份並預覽還原；圖片要能開啟且 SHA 驗證成功。

## 遷移與回滾抽查

1. 舊 GitHub Pages 下載遷移 ZIP；新 origin 匯入預覽要顯示來源 origin、tombstone，且附件全數通過。
2. 匯入同一 ZIP 第二次不得重複新增。舊站仍能開啟，沒有 redirect、資料清除或 Pages 停用。
3. 依 [MIGRATION-ROLLBACK.md](./MIGRATION-ROLLBACK.md) 完成匿名回滾演練後，才開始正式資料切換。

任一步驟顯示 401、`reauth_required`、SHA 錯誤、來源不符或未知衝突時停止切換，保留新舊站與所有備份，不做清除。
