# iPhone「存到 Pocket Archive」捷徑

v2.2 的同來源 Worker 可讓捷徑在不開啟 PWA 的情況下，把 URL 安全送入待收件佇列：

**分享 → 存到 Pocket Archive → 顯示「已送出」**

「已送出」只代表伺服器已安全收件，不代表 iPhone、Windows 與 Google Drive 已全部同步。下次 Pocket Archive 開啟或回到前景時，App 會租用工作、寫入 IndexedDB、確認完成，再照既有 journal 同步到 Drive。

Apple Shortcuts 的文字欄位不是 Keychain 或 Secure Enclave；有限憑證仍可能被能查看／匯出該捷徑的人取得。本設計把它限制成 `capture:create`：不能讀取、修改、刪除收藏，不能讀 D1，不能取得 Google Token，也不能呼叫 Drive。建議每 180 天輪替，裝置遺失時在 Pocket Archive 單獨撤銷。

## 先在 Pocket Archive 配對

1. 登入已部署 v2.2 Worker 的 Pocket Archive。
2. 「Drive 同步」→「iPhone 一鍵收藏」。
3. 裝置名稱填「我的 iPhone」→「建立捷徑憑證」。
4. 點「複製憑證」。它只顯示一次；不要貼到對話、公開筆記、URL query 或截圖分享。

若憑證遺失，不需找回；撤銷舊憑證並建立新的一個。

捷徑憑證與 Google OAuth grant 相互獨立。「撤銷 Google 授權與所有網頁裝置」會清除加密 Refresh Token 與網頁 Session，但不會讓已安裝捷徑無預警失效；要停用遺失裝置，必須在「iPhone 一鍵收藏」清單單獨撤銷該憑證。

## 建立捷徑

iOS 版本間的動作翻譯可能略有不同。本專案不產生無法驗證簽章的假 `.shortcut` 安裝檔；請在 Apple「捷徑」App 手動建立：

1. 新增捷徑，名稱 **存到 Pocket Archive**。
2. 點名稱旁資訊按鈕 → 開啟「顯示於分享表單」。接收類型只選 **URL** 與 **文字**。
3. 加入「從捷徑輸入取得 URL」（`Get URLs from Shortcut Input`）。
4. 加入「如果」：若 URL 沒有值，顯示「分享內容沒有可辨識網址」，並用「停止此捷徑」結束。不要捏造 URL。
5. 加入「產生 UUID」（`Generate UUID`），作為這一次送出的 `Idempotency-Key`。
6. 加入「取得 URL 內容」（`Get Contents of URL`）：
   - URL：`https://你的正式網域/api/capture`
   - Method：`POST`
   - Request Body：`JSON`
   - `url`：第 3 步取得的 URL
   - `text`：`捷徑輸入`（可用時）
   - `source`：固定文字 `ios-shortcut`
7. 在同一動作的 Headers 加入：
   - `Authorization`：`Bearer ` 後緊接剛才複製的完整憑證
   - `Idempotency-Key`：第 5 步的 UUID
   - `Content-Type`：`application/json`
8. 從回應取得 Dictionary 的 `status`：
   - `accepted` → 顯示通知「已送出到 Pocket Archive」
   - `duplicate` → 顯示通知「已收過，未重複送出」
   - 其他／動作失敗 → 顯示「尚未收件，請檢查網路或重新配對」

不要把憑證放在 `?token=`、分享連結、通知文字或錯誤畫面。API 會主動拒絕疑似含憑證的 query。

## 實際限制與錯誤

- Safari、YouTube、Threads、Instagram、X 等 App 只要分享內容包含可取得的 HTTP/HTTPS URL，就能送出；來源 App 是否真的提供 URL 由它自己決定。
- 只有文字且沒有 URL：捷徑必須提示，不建立假收藏。
- 網路離線、HTTP 4xx/5xx 或 Shortcut 動作逾時：顯示「尚未收件」，不可顯示成功。使用者可重跑；相同 UUID 不會建立兩次。
- 401 `shortcut_expired`：在 Pocket Archive 撤銷舊憑證、建立新憑證並更新 Authorization header。
- 429 `rate_limited`：每個憑證每分鐘最多 30 次，稍後重試。
- 伺服器保存 URL、分享文字與標題最多 30 天；完成後只保留最小稽核狀態，後續清理依維運 SOP 執行。

## 純 GitHub Pages 回滾模式

如果尚未部署 Worker，捷徑只能使用 v2.1.3 安全流程：分享 → 複製 URL → 開啟 Pocket Archive →「讀取剪貼簿並預覽」。純靜態網站無法讓其他 App 在背景寫入它的 IndexedDB，也不能安全保存 Refresh Token。不要以 GET query 取代收件 API。
