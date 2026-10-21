# 刪除後重新分享原圖：驗收計畫（待執行）

這份修復不修改正式 v2.3.3、D1 schema、OAuth、捷徑憑證或 Google Drive Workspace。只在 PR/CI 驗收後，由擁有者決定合併部署。

## 行為契約

- **同一次圖片請求**使用同一 Idempotency-Key 重試：Worker 回 `duplicate`，不建立第二份工作。
- **第一份仍在 ready 等待 App 收件**：新 UUID、相同內容 SHA-256 回 `duplicate`；不重複佇列／附件。
- **第一份已 completed，App 尚保存原圖**：新 UUID 可以先回 `accepted`，App 原子入庫比對既有 attachment SHA-256 回 `duplicate`，收藏只有一筆。捷徑的 accepted 只代表已排入收件，**不可**宣稱已入庫。
- **第一份已 completed，使用者刪除原圖、同步完成，再次分享**：新 UUID 建立新 job/item ID，App 回 `saved`，新收藏可開啟原始圖片並同步至其他裝置；舊圖片 tombstone 不復活，沒有第二筆活躍相同圖片。
- **ACK 遺失的舊工作仍 ready／leased**：同 UUID 重試安全冪等；若尚未完成 ACK，該內容的 ready 工作仍受 hash 去重保護。這是保守的資料完整性選擇，不把未完成收件冒充已收件。
- **Drive 故障/傳輸不完整/簽章與 SHA 不符**：不可回 accepted，暫存垃圾回收仍照舊。

## 手動實機驗收（合併部署後）

1. 先匯出並保存完整 ZIP；使用匿名合成圖片（<4 MiB）。確認 iPhone、Windows 目前正常同步。
2. iPhone 捷徑分享圖片，等 App 收件成功、手動完成 Drive 同步；Windows 看到原圖。
3. 在 App 刪除該匿名圖片，兩端完成同步，確認不存在。
4. iPhone **不修改捷徑**、不重設憑證，重新分享同一張原圖。捷徑應顯示 accepted，開 App 後原圖重新入庫。
5. 重新整理與開關 App，確認原圖可下載、內容 SHA 一致；Windows 同步看到單一新收藏。
6. 原圖還在時再次分享：即使捷徑再次回 accepted，App 最終不能新增第二筆相同 hash 的圖片。
7. 不得清除 IndexedDB／D1／Drive，重試也不能重新出現先前已刪除的舊 job ID。

## 重要限制

Worker 不保存完整收藏清單，也不具有判斷使用者當前 IndexedDB 是否仍有這張圖片的權限。為了允許已刪除圖片重新收藏，**完成收件後的新分享不保證在捷徑階段直接顯示 duplicate**；最終由 App 的資料庫交易決定新增或重複。伺服器可能再次產生短期私有 Drive 暫存，受既有 4 MiB、每日及待處理配額限制。
