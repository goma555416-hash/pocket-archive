# iPhone 安全分享捷徑

Pocket Archive 是純靜態 PWA，其他 App 不能在背景直接寫入它的 IndexedDB。以下流程不把私人 URL 放進 GET query，也不需要伺服器或帳號：分享 → 複製 → 開啟 App → 使用者預覽確認。

## 建立捷徑

先把 Pocket Archive 部署到你信任的 HTTPS 網址，並從 Safari「分享 → 加入主畫面」。接著在 iPhone 的「捷徑」App：

1. 新增捷徑，名稱設為「存到 Pocket Archive」。
2. 點捷徑名稱旁的資訊按鈕，開啟「顯示於分享表單」。接受類型選「URL」與「文字」。
3. 加入「從捷徑輸入取得 URL」動作（英文介面可能顯示 `Get URLs from Shortcut Input`）。
4. 加入「如果」：若上一步沒有值，顯示提示「分享內容沒有可辨識網址」並停止捷徑。
5. 加入「複製到剪貼簿」，內容選上一步取得的 URL。不要建立含 `?url=`、`?text=` 的網址。
6. 加入「打開 URL」，URL 固定填入你的 Pocket Archive HTTPS 首頁，例如 `https://YOUR-NAME.github.io/pocket-archive/`。
7. 可選擇再加入通知：「已複製；回到 Pocket Archive 點『讀取剪貼簿並預覽』」。

## 使用

1. 在 Safari 或其他 App 對連結開啟分享表單，選「存到 Pocket Archive」。
2. 捷徑只把 URL 複製到本機剪貼簿並開啟網站。
3. 在首頁點「讀取剪貼簿並預覽」。檢查有效／重複／無效內容，再確認匯入。

若 Safari 的「打開 URL」沒有切到已安裝的主畫面 Web App，請手動點 Pocket Archive 主畫面 Icon；剪貼簿內容仍在。iOS 第一次讀剪貼簿可能要求同意；拒絕後可長按批次輸入框手動貼上。

## 圖片

圖片不要經上述文字捷徑。直接在 Pocket Archive 點「圖片」，從「照片」或「檔案」選取；瀏覽器會顯示它支援的系統選擇器。若分享來源只提供圖片，先「儲存影像」或「儲存到檔案」，再回 App 選取。

## 安全提醒

- GET query 會出現在瀏覽器歷史、伺服器存取紀錄或分析工具中，因此捷徑固定只開首頁。
- 剪貼簿也可能含敏感資料；匯入完成後可在其他位置複製一般文字覆蓋它。
- 遇到需要登入的社群貼文，Pocket Archive 只保證保存 URL，不會繞過平台限制。
