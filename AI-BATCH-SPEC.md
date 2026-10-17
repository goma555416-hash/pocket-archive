# Pocket Archive — 不接 API 的 Codex 批次整理規格（schema v2）

本流程已實作。App 不呼叫 OpenAI 或其他 AI API，不在背景執行模型，也不自動上傳收藏。使用者主動匯出、交給本機 Codex CLI（或明確選擇的 Codex Cloud）、再匯回結果。

## 流程

1. 選取收藏；若未選取則使用全部 `status: "inbox"` 的項目。
2. 無附件輸出 `pocket-archive-inbox-YYYY-MM-DD.json`；含附件輸出 ZIP，根目錄為 `inbox.json`，圖片位於 metadata 指定的 `attachments/<attachment-id>`。
3. 使用 [CODEX-ORGANIZE-PROMPT.md](./CODEX-ORGANIZE-PROMPT.md) 產生 `organized.json`，並以 `scripts/validate-organized.mjs` 驗證。
4. App 嚴格核對 schema、由本裝置記錄的 `export_id`、item ID 及欄位，列出接受和拒絕項目。
5. 使用者逐項勾選後套用。只可更新建議分類、合併標籤、AI 摘要及已完成狀態；原始網址、備註、來源與附件不變。
6. App 在 IndexedDB 保存一次更新前快照，可從備份視窗復原最近一次套用。

## Inbox envelope

```json
{
  "format": "pocket-archive-inbox",
  "schema_version": 2,
  "export_id": "export-stable-random-id",
  "exported_at": "2026-10-17T00:00:00.000Z",
  "privacy_notice": "...",
  "items": [
    {
      "id": "pa-stable-item-id",
      "kind": "link",
      "url": "https://example.org/article",
      "title": "Example",
      "note": "User note",
      "type": "文章",
      "category": "",
      "tags": [],
      "status": "inbox",
      "source": "example.org",
      "attachment": null
    }
  ]
}
```

圖片項目的 `attachment` 只有 `id`、原始檔名、大小、MIME、SHA-256 與安全相對路徑，不含 data URL 或 Blob。Blob 只進 ZIP。

## Organized result

```json
{
  "format": "pocket-archive-organized",
  "schema_version": 2,
  "source_export_id": "必須逐字匹配 export_id",
  "items": [
    {
      "id": "必須是該批次中仍存在的 item.id",
      "analysis_status": "completed",
      "suggested_categories": ["設計靈感"],
      "suggested_tags": ["配色", "平面設計"],
      "summary": "有來源依據的繁體中文摘要",
      "reason": "根據實際可見標題、正文或圖片",
      "confidence": "medium"
    }
  ]
}
```

`analysis_status` 只能是 `completed` 或 `insufficient_data`；`confidence` 只能是 `low`、`medium`、`high`。讀不到正文、需登入或圖片不可解碼時必須使用 `insufficient_data`，不得虛構。

## 驗證與隱私

- App 最多記錄最近 50 個本機匯出的 `export_id`，防止把其他批次或偽造結果誤套到目前收藏。
- 未知、重複或欄位錯誤的項目會列入拒絕報告，不阻止其餘合法項目預覽。
- CLI validator 對正式工作流要求輸入與輸出 ID 完整一對一；App 則支援部分結果，讓錯誤項目不阻塞合法項目。
- 匯出前應人工檢查私人網址、token、備註及圖片；匯出檔已由 `.gitignore` 排除，但仍不可提交 GitHub。
- Codex Cloud 只有在使用者主動選擇上傳時才會取得檔案；優先使用本機 CLI。
