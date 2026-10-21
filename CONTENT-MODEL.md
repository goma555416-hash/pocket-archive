# v2.3.2 內容模型與實作紀錄

## 開發前評估

- 基準：`1263d88`（最新 main，v2.3.1），工作樹乾淨。既有 npm test：13 個測試檔全部通過。
- 影響欄位：type、tags、category；新增可選 classification、webpageKind、legacyType。URL、note、attachment、ID、時間、source、AI 摘要及同步時鐘保留。
- 介面：獨立純函式分類器；lib 統一驗證／相容轉換；新增編輯與卡片；備份／inbox／同步保留擴充欄位；SW 快取加入新模組。
- 相容策略：schema v2 與 IndexedDB v2 不變，讀取時投影、不啟動全庫遷移、不改動時間與時鐘。舊 category 保留；舊 type 保存於 legacyType。可完整容納才合併主題標籤，超限則保留原欄位並顯示提醒。重複讀取冪等。
- 風險：舊裝置可能刪除未知欄位；新版遇到會覆寫人工類型的舊裝置更新時交由衝突面板決定。回滾前須下載新版完整備份、停止跨版本雙邊編輯；舊版不能理解新欄位，不能依靠舊版重新匯出作為唯一備份。
- 測試：來源 URL／證據、八種舊類型、上限與冪等、JSON/ZIP、IndexedDB、跨版本同步、AI 預覽套用復原、表單／批次／搜尋／四類篩選、窄螢幕、SW 更新與離線。OAuth、Session、Drive 原 file ID／SHA-256、D1、捷徑 API 與原圖驗證保持既有介面並回歸。

## 欄位契約

- type：圖片／影片／社群／網頁。主題只放 tags。
- classification：`{status: manual|verified|provisional, evidence: ...}`。manual 由表單明確選擇／確認；verified 只代表形式的可信網址結構或已驗證原圖，並不代表讀到貼文正文；provisional 必須顯示待確認。
- webpageKind：article／site／other／空字串；不靠根路徑或結尾斜線猜測。舊「文章」只提供 article 提示並維持待確認。
- legacyType、category：相容來源，不自動刪除。舊「影片」「圖片」只有文字時保守保留為待確認；舊「遊戲／香水／工具」依 URL 證據重判。
- tags：新增／人工輸入每筆最多 24 個、每個 32 字；舊資料讀取不截斷。相容轉入及 AI 合併只加入可完整容納的值，其餘留在原欄位或 aiSuggestion，卡片／預覽提示。
- 不輸出 AI 類型建議；suggested_categories 相容讀取並與 suggested_tags 合併為主題標籤，建議原陣列完整留於 aiSuggestion。AI 不改 type、webpageKind、category、原始來源與備註。
- 不新增 metadata 代理或伺服器抓取。前端讀取標題仍為明確按鈕、CORS 與匿名請求；標題文字或單獨 og:image 縮圖不構成主要媒體證據。只有同一成功讀取頁面的明確 og:type + 唯一主要媒體 URL 結構才提高可靠度；多個主要媒體、混合或重新導向／不明來源不確認。metadata 表達的是網站宣告，不等於已下載或看完原始媒體。

## 實作後確認

replaceBundle 在原有原子交易內比較各筆驗證後投影，只寫入有實際變更的紀錄、刪除明確移除的 ID；新增或同步其他項目不會把未變動舊資料整庫改寫。舊附件只憑 metadata 保守顯示圖片／待確認，不宣稱重新驗過原檔。完整測試與未驗收項目見 VALIDATION-V2.3.2.md、UAT-V2.3.2.md。
