# Pocket Archive — 不接 API 的 Codex 批次整理設計草案

> **尚未實作。** 本文件是交付 Codex 開發的需求規格。此版本 App 仍只支援逐筆保存 HTTP(S) 網址與 JSON 備份，尚不能直接儲存圖片檔或一次匯入大量連結。

## 目標工作流程
1. iPhone / Windows 隨手收集：網址、文章、影片、社群貼文連結，未來加入圖片附件與批次貼上。
2. 本機持有資料，待整理 items 一次匯出為 `pocket-archive-inbox-<date>.json`；若有圖片，以 ZIP 附檔放在同一批內。**不要自動提交 GitHub**。
3. 使用者明確選擇匯出檔，交給 Codex CLI 於 Windows 本機分析。Codex Cloud 只處理明確提供、且可接受傳到雲端的資料。
4. Codex 依來源實際可讀內容提分類、標籤、摘要、理由與無法分析原因，輸出結構化 `organized-<date>.json`。
5. App 匯入後先顯示差異預覽及警示，經使用者確認才套用。保留原始網址、使用者備註和更新前快照；可復原。

## 模型分析規則
- 不宣稱 Codex 可以自動讀取 iPhone Safari localStorage；由使用者主動匯出／匯入。
- 不保證 Instagram、X、Threads、Pinterest 等社群平台的私密、需登入或防抓取內容能被存取。
- 若只有網址但抓不到正文，僅利用明確可見資訊，將 `analysis_status` 設為 `insufficient_data`；不得捏造摘要。
- 優先採既有分類，可提建議新分類；允許多標籤，不可靜默刪除原資料。
- 內容可能含個人敏感資訊、驗證 token 或私人連結；先設計過濾提醒與匯出審核，並建議優先本機 Codex CLI。
- 本方案不使用額外 AI API，但仍消耗 Codex 任務額度；不是自動、即時或無限制分類服務。

## 資料交換提案（Codex 實作前須審核版本相容性）
### Export envelope
```json
{
  "format": "pocket-archive-inbox",
  "schema_version": 1,
  "exported_at": "2026-10-17T00:00:00Z",
  "items": [
    {
      "id": "same-stable-id-as-local-record",
      "url": "https://example.org/article",
      "title": "Example",
      "note": "User note",
      "tags": [],
      "status": "inbox"
    }
  ]
}
```
### Proposed Codex output
```json
{
  "format": "pocket-archive-organized",
  "schema_version": 1,
  "source_export_id": "export-identifier",
  "items": [
    {
      "id": "same-stable-id-as-local-record",
      "analysis_status": "completed",
      "suggested_categories": ["設計靈感"],
      "suggested_tags": ["配色", "平面設計"],
      "summary": "A concise source-grounded summary",
      "confidence": "medium",
      "reason": "Based on visible title and article content"
    }
  ]
}
```
`source_export_id` 在正式實作時必須與匯出檔一致，且在匯入時嚴格檢查。以上僅為擬議結構，**目前 App 不接受這種 JSON**。

## Codex 建議開發順序
1. 批次貼上網址，預覽新增/重複/非法連結，確認後匯入。
2. 「只匯出待整理」 JSON，穩定 ID、來源、備註與版本資訊。
3. 區分原始欄位與 AI 建議欄位，加入匯入差異預覽、衝突偵測與復原。
4. 支援實際圖片附件、容量管理、可攜 ZIP（先評估 IndexedDB、儲存空間和 iOS 限制）。
5. 最後才研究 iOS 分享捷徑與跨裝置同步；避免用 GET 查詢參數傳敏感內容。

## 驗收要求
- 不接付費 API，不把收藏靜默上傳。
- 匯出檔案遵守 .gitignore，不預設提交私人資料。
- 匯入不能變更未知 ID 的紀錄，不能刪原始資料；備份可往返還原。
- 增加自動測試覆蓋缺資料、重複、錯誤 JSON、版本衝突、惡意輸入、部分可讀來源。


> **v1.3 補充**：本文件的「建議開發順序」僅供 Codex 在**同一次完整任務**內安排實作，不代表可以只交第一階段。以 `MASTER-TASK.md` 的一次性交付要求為準。
