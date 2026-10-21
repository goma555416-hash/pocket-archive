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

## v2.3：把同一個捷徑擴充為圖片／網址共用入口

先複製現有 **存到 Pocket Archive** 為 **存到 Pocket Archive（URL 回滾）**，停用副本的分享表單但保留全部原動作。修改原捷徑，名稱與原憑證不變，不需取得 Google Token。接收類型增加 **影像、檔案**（保留 URL、文字）。不要使用調整大小、轉換影像或重新編碼動作。

照片來源 App／iOS 可能先產生分享版本；在照片分享選項選「目前格式／Current」與原始資料（版本提供時），若必須確保相機原始 HEIC，先將**原始檔**存入「檔案」再分享。Pocket Archive 保證收到的 bytes 原樣保存，不能還原 iOS 已在分享前轉換的資料。原圖可能包含 Exif／GPS。

**限制：分享 API 每張最多 4 MiB，逐張上傳；每日全帳號 50 MiB／100 次新工作、未清理暫存 100 MiB、每憑證 30 requests/min。App 直接選圖仍可 25 MB。** 不要把圖片壓縮後假稱保留原圖；超額請改在 App 選取原檔。

在原「從捷徑輸入取得 URL」動作前加入分支：

1. 使用「重複每個項目」（Repeat with Each）處理捷徑輸入，保留每個 Repeat Item。
2. 「取得輸入中的檔案／Get Files from Input」以 Repeat Item 為輸入。用「取得檔案詳細資訊／Get Details of Files」取得 **副檔名、名稱、檔案大小**。若來源是影像、可取得檔案且副檔名在下列白名單，進圖片分支；非圖片才進原 URL 分支。檔案本身作為 body，不用「取得影像」轉換原圖。來源未提供實際檔案時提示「請先存為原始檔再分享」，不可送空檔或假 URL。
3. 將副檔名轉小寫，用「字典」映射 MIME：`jpg/jpeg → image/jpeg`、`png → image/png`、`webp → image/webp`、`gif → image/gif`、`heic → image/heic`、`heif → image/heif`。這只是宣告，Worker 仍驗證簽章。其他類型提示不支援，不修改副檔名。
4. 若檔案大小大於 **4194304** bytes，將「名稱：未收件，超過 4 MiB，請在 App 選原圖」加入結果清單；略過此張繼續下一張。
5. 「產生 UUID」，存入本張變數 `UploadUUID`。用「URL 編碼／URL Encode」對完整檔名 UTF-8 percent encode，存入 `EncodedName`。
6. 「取得 URL 內容／Get Contents of URL」：
   - URL：`https://你的正式網域/api/capture/images`
   - Method：`POST`
   - Request Body：**File／檔案**，選原始檔案變數，不是 JSON／Form，也不是 base64。
   - Headers：`Authorization: Bearer <既有 pa_capture_... 憑證>`、`Idempotency-Key: <UploadUUID>`、`Content-Type: <字典映射的 MIME>`、`X-PA-Filename: <EncodedName>`。
   - 不手動設定 Content-Length；iOS 可設定或省略，伺服器會逐段計數。
7. 取得回應 Dictionary 的 `status`，將逐項結果加入「結果清單」：
   - `accepted`：「名稱：原圖已安全收件；請開 App 入庫及同步」。
   - `duplicate`：「名稱：已收過，未重複新增」。
   - 其他／沒有 status：「名稱：尚未收件」，可追加 error.code，**不要**追加 token、URL、原圖或完整 request。
8. 非圖片的 Repeat Item 執行原有 URL/文字流程：從此項取得 URL；無值通知「分享內容沒有可辨識網址」；有值則以原 JSON/header 呼叫 `/api/capture`。保留已驗證四結果：accepted、duplicate、無有效 URL、離線失敗。多圖時不要把第一張照片的標題當作每一筆的 URL。
9. 重複結束，以「合併文字」換行顯示逐張結果（長清單用「顯示結果」），不要只顯示籠統成功。可加「開啟 URL」至 App 首頁，**不帶 query 圖片或憑證**。App 下次在前景下載、驗 hash、原子寫入，接著同步至 Windows。

iOS Shortcuts 的網路動作若拋出系統錯誤，原生捷徑沒有通用的 try/catch：它可能立即停止其餘迴圈並顯示系統離線／逾時錯誤，這代表本次沒有確認成功，不應有預先顯示的成功通知。已回傳 accepted 的項目仍已安全收件；重跑整批由 hash 去重。若重試同一個網路動作且保留 UploadUUID，可沿用 UUID；整個捷徑重跑會生成新 UUID，由 hash 再次防重複。

### 圖片錯誤與恢復

| HTTP／code | 顯示與處理 |
| --- | --- |
| 401 shortcut_expired | 未收件；撤銷舊捷徑憑證並重新配對 |
| 401 reauth_required | 未收件；在 App 重新 Google 登入，捷徑本身不能取得 grant |
| 413 image_too_large | 未收件；超過 4 MiB，請在 App 直接選原檔 |
| 415 invalid_image_type / image_signature_mismatch | 未收件；MIME 與實際格式不符，不改副檔名硬送 |
| 409 upload_busy / upload_in_progress | 另一張處理中；等待再逐張送出 |
| 409 upload_retry_new_key | 上次失敗，重跑產生新 UUID；不代表舊工作已成功 |
| 409 capture_folder_shared | 未收件；擁有者檢查專用 private 暫存資料夾分享權限 |
| 429 rate_limited / capture_quota | 未收件；分鐘限流稍後重試，日配額等待下一個滑動 24 小時／清理完成 |
| 4xx/5xx、空回應、離線、逾時 | 尚未確認收件；保留原檔並重試，不能通知已儲存 |

Worker 將未完成上傳在 10 分鐘後列入回收，待 App 收件保留 7 天，App 確認後暫存再留 24 小時；自動回收遇撤權／Google 錯誤會延後。配額與保留完整規則見 CAPTURE-IMAGES.md。沒有 Worker 的 Pages 回滾模式，圖片仍須在 App 點「圖片」選取，不能用背景捷徑收圖。

## v2.3.2 入庫分類

原有 POST /api/capture 與憑證流程不變，無須重建捷徑。URL、分享文字及穩定 ID 保留。YouTube watch/Shorts、Instagram Reels、明確 TikTok 影片頁入庫為影片；YouTube 頻道為網頁。X／Threads／無法驗證的 Instagram 貼文為社群且待確認，可在 App 人工修改。Safari 文章與網站都屬網頁，再選內容形式；捷徑不自動爬整站。公開 metadata 若被阻擋仍可保存，Codex 模擬測試不等於各 App 的 iPhone 實機通過。請依 UAT-V2.3.2.md 驗收。
