# v2.3 圖片收件：設計與維運

`POST /api/capture/images` 使用原有 `capture:create` Bearer，raw file body（不接受 multipart/base64），每張一個 Idempotency-Key。X-PA-Filename 為 UTF-8 percent encoding，Content-Type 為原檔 MIME。回應 `accepted` 只代表原檔已存入 Drive 且回讀 SHA-256 相符；不是 App 已入庫或已同步。原有 `POST /api/capture` JSON URL API 不變。

## 選擇與限制

沿用已授權的 Google `drive.file`，不新增帳號、Object Storage、付費 API 或模型。Worker 不接受捷徑選擇任何 Drive ID／parent／query；不把 Google Token、暫存 Drive ID 或原檔內容交給捷徑。D1 只有小型 metadata、配額、狀態與稽核，圖片不進 D1、日誌、query 或 Static Assets。

為避免 Worker 128 MiB 記憶體與小型簡易上傳限制，**分享 API 每張 4 MiB（4,194,304 bytes）**，而非 25 MB；App 本機選取維持 25 MiB。raw body 逐段計數，最多緩衝 4 MiB，不信任 Content-Length；單段讀取 15 秒、整份 body 30 秒逾時，Google 操作 20 秒逾時。全帳號同時只能一個圖片接收工作（D1 partial unique index），多圖須逐張傳送。

- 每憑證原有 30 requests/min，含重試／拒收。
- 全擁有者每日 50 MiB、100 次 upload reservation；每個新工作先預留 4 MiB，驗證後記實際大小，失敗也計入當日預留以防濫用。
- 暫存 100 MiB，未確認清理成功的檔案繼續計額。Google Drive 自有剩餘空間、平台免費額度亦適用，非無限收件。
- MIME 白名單 JPEG、PNG、WebP、GIF、HEIC/HEIF，內容簽章必須匹配。不轉碼、不改寫原檔。尺寸在 App 可解碼時寫入 attachment width/height；不可解碼則 null，原檔仍可下載。
- Exif、GPS 與其他 metadata 原樣保留，UI 及捷徑說明會提示。

## 私密暫存與狀態機

App 的一般資料夾可能被擁有者分享。因此圖片收件另在 My Drive 建立無 sharing 的 `Pocket Archive Capture (private)`，不繼承 App root 的分享權限。每次上傳檢查該資料夾 permissions：只有 user/owner 才允許，分享給其他人即 fail closed。不可將此資料夾分享或移入共享位置。

`receiving → ready → completed`，錯誤轉 `failed`，逾時轉 `expired`。建立 Drive 檔前先 generateIds 並把 file ID 寫入 D1，讓「Google 已寫入但回應斷線」仍可精確回收。新建原檔私密、內容上傳、回讀 bytes/hash 相符後才建 pending queue 與 ready 狀態；App 不可領取尚未 ready 的工作。期間斷線不回報成功。

相同 Idempotency-Key 重送：ready/completed 回 duplicate，receiving 回 409，失敗 key 回 409 `upload_retry_new_key`，讓捷徑以新 UUID 重傳。相同原檔只在**尚待領取的 ready 工作**以 SHA-256 去重；已 completed 表示「曾被 App 接收」，不表示圖片目前仍存在本機收藏庫。完成後再次分享新 UUID，會建立**新的隨機 job/item ID**，才能在使用者刪除舊圖片後重新加入；每個工作自身的重試／跨裝置重領仍使用相同 ID。附件 ID 由內容 hash 決定，本機入庫仍以現有圖片 hash 去重：若舊圖未刪，第二筆只會在 App 端回報 duplicate。此機制不需 Worker 讀取私人收藏庫，也不會把已刪除的舊 tombstone 重新當成新工作。

**可見行為差異：** 先前工作已 completed 時，新分享的捷徑可顯示 `accepted`，僅代表新工作已安全排隊，不代表收藏一定新增；App 收件後才知道圖片是否仍存在並決定 `saved` 或 `duplicate`。因此重送已收藏圖片也可能多一次安全收件與 Drive 暫存流量，依原配額控制。

App 逐次只租用一筆（120 秒），驗大小、MIME、簽章及 SHA-256，在同一 IndexedDB 交易寫入 entry + 原始 blob + sync journal + dirty flag + capture receipt 後才 ack。ack／content 需要登入擁有者 Session（ack 另需 CSRF），捷徑憑證不能讀取、列舉、刪除。每次領取的 attemptCount 作為 leaseVersion，content header 與 ack body 必須匹配，防止同 Session 多分頁的舊確認。過期或別人的租約拒絕；lost ack 後重領會看到本機 receipt 並確認 duplicate。可恢復的 IndexedDB／網路錯誤回 pending，不以十次本機失敗丟棄已安全收件圖片。

ack 後仍需 App 在前景完成既有 Drive journal/附件同步；App 關閉期間不宣稱同步成功。兩裝置若在 lease 到期交接時都曾寫入，穩定 ID 與原檔 hash 由既有同步機制收斂。已入庫但尚未同步的本機資料仍受 Safari 儲存限制，請保留完整備份。

## 保留與回收

新增 cron 每 15 分鐘執行，每次最多 3 筆，以控制免費層 subrequest 預算。未完成 upload intent 最多 10 分鐘；ready 工作 7 天；ack 後暫存原檔再留 24 小時。回收只操作 D1 已知 file ID 且 Drive appProperties 的 `paRole=captureImage`、`uploadId` 同時匹配的檔案，移至 Drive 垃圾桶，不永久刪除。不確定建立結果的 404 先隔離至 intent 建立後 15 分鐘，再視為已清理，避免過早釋放配額。Google 撤權／空間或連線錯誤時保留 ID 與配額，下次重試；不讀取其他 Drive 檔案。清理後抹除檔名、最小 metadata 留 30 天；失敗會延後實際保留期限，須監控 cron。

Drive 垃圾桶仍可能占使用者空間；由擁有者自行管理，App 不自動清空。受限憑證仍可能被偷走並用來耗用收件額度，請個別撤銷遺失裝置；沒有升級成任意 Drive 權限。

## 合併後由擁有者一次執行

不新增 Secret、不更動 OAuth Client／callback／加密金鑰。本 PR 未操作真實 D1／Drive 或部署。

1. 備份既有 ZIP；確認本 PR CI 與下方本機命令通過。
2. `npx wrangler d1 migrations list pocket-archive --remote`，確認只有新增 `0004_capture_images.sql`，再由本人核准 `npx wrangler d1 migrations apply pocket-archive --remote`。Wrangler ledger 確保只套一次，DDL 的 IF NOT EXISTS 可重跑且不改舊欄位。
3. 本人核准 `npx wrangler deploy`，確認 scheduled trigger 與 Drive grant 可用。無須新增 scope、付費服務或 Secret。
4. 更新原捷徑（見 IOS-SHORTCUT.md），只用匿名圖片完成 UAT-V2.3.md。若圖片超過 4 MiB，改在 App 直接選圖，不能顯示收件成功。

回滾：保留 URL-only 舊捷徑；停止圖片送出，先讓已安全收件工作入庫及同步。不可在仍有圖片 pending／leased 工作時回滾 Worker 至 v2.2：舊 claim API 不認識圖片，可能阻塞 URL 收件。緊急停用圖片時先保留 v2.3 Worker、將捷徑回到 URL-only；待圖片全部入庫／同步後才可停用 cron 並回滾 Worker。保留新增表及暫存 metadata，不 DROP 表、不刪原檔，回復 v2.3 後繼續清理。App 完整 ZIP 能保留原圖。不得為回滾重設金鑰、grant、舊 origin 資料或 migration ledger。

## v2.3.2 分類呈現

圖片收件／驗證／儲存流程不變；經既有 MIME、簽章、大小及 SHA-256 驗證的原圖，入庫為圖片／可靠判斷。舊附件 metadata 不能冒充本次重新讀過原檔，保守保留待確認。僅外部圖片 URL 或 og:image 縮圖不等於原檔已入 IndexedDB，卡片會標示未離線保存。本版不新增 migration，也不重新套用歷史 migration；前文 v2.3 新增 0004 的清單只屬歷史首次部署。
