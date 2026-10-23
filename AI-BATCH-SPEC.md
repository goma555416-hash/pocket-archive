# Pocket Archive — 不接 API 的 Codex 批次整理規格（schema v2）

本流程已實作。App 不呼叫 OpenAI 或其他 AI API，也不在背景執行模型。使用者可使用本機檔案流程，或在已明確授權 Google Drive 後，主動把選取批次送到 AI-Inbox，再由 Codex Cloud 原檔寫回 App 預建的 AI-Results 占位檔。

## 流程

1. 選取收藏；若未選取則使用全部 `status: "inbox"` 的項目。
2. 無附件輸出 `pocket-archive-inbox-YYYY-MM-DD.json`；含附件輸出 ZIP，根目錄為 `inbox.json`，圖片位於 metadata 指定的 `attachments/<attachment-id>`。
3. 使用 [CODEX-ORGANIZE-PROMPT.md](./CODEX-ORGANIZE-PROMPT.md) 產生 `organized.json`，並以 `scripts/validate-organized.mjs` 驗證。
4. App 嚴格核對 schema、由本裝置記錄的 `export_id`、item ID 及欄位，列出接受和拒絕項目。
5. 使用者逐項勾選後套用。只合併主題標籤、保存 AI 摘要及已完成狀態；type、classification、webpageKind、原 category、原始網址、備註、來源與附件不變。
6. App 在 IndexedDB 保存一次更新前快照，可從備份視窗復原最近一次套用。

Drive 流程的 schema 完全相同。為兼容不同 OAuth Client 的 `drive.file` 權限，Codex 不可另建結果檔，必須依 [CODEX-DRIVE-WORKFLOW.md](./CODEX-DRIVE-WORKFLOW.md) 覆寫 `organized-<export_id>.json` 的既有 file ID。

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
      "type": "網頁",
      "classification": {"status": "provisional", "evidence": "page-url"},
      "webpageKind": "",
      "legacyType": "",
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
      "suggested_categories": [],
      "suggested_tags": ["設計靈感", "配色", "平面設計"],
      "summary": "有來源依據的繁體中文摘要",
      "reason": "根據實際可見標題、正文或圖片",
      "confidence": "medium"
    }
  ]
}
```

`analysis_status` 只能是 `completed` 或 `insufficient_data`；`confidence` 只能是 `low`、`medium`、`high`。讀不到正文、需登入或圖片不可解碼時必須使用 `insufficient_data`，不得虛構。

v2.3.2 維持 schema v2；新增 inbox 欄位是相容擴充，舊 inbox／organized 不要求補欄位。type 只代表圖片／影片／社群／網頁；主題放 suggested_tags。舊 suggested_categories 原陣列仍完整讀取，套用時與 suggested_tags 一起作為標籤候選。合併超過 24 個或單個超過 32 字時，不截斷既有值，預覽列出未加入項目，整份建議保留於 aiSuggestion，卡片仍可查閱與搜尋。不支援 AI 類型建議，因此 AI 永不覆寫人工類型。

## 驗證與隱私

- App 最多記錄最近 50 個本機匯出的 `export_id`，防止把其他批次或偽造結果誤套到目前收藏。
- 未知、重複或欄位錯誤的項目會列入拒絕報告，不阻止其餘合法項目預覽。
- CLI validator 對正式工作流要求輸入與輸出 ID 完整一對一；App 則支援部分結果，讓錯誤項目不阻塞合法項目。
- 匯出前應人工檢查私人網址、token、備註及圖片；匯出檔已由 `.gitignore` 排除，但仍不可提交 GitHub。
- Codex Cloud 只有在使用者主動選擇上傳時才會取得檔案；優先使用本機 CLI。

## v2.3 啟動與批次範圍

Drive 送出後，App 先驗證既有原檔的 appProperties／父資料夾／雜湊，再顯示含明確 Drive file IDs 與原檔 SHA-256 的 export_id 專用指令，不包含私人 URL／token／匯出內容；禁止 Notion／其他私人資料來源。App 保存 itemIds 並要求 Drive 結果 ID 完整一對一，原 file ID 的 parent、檔名、appProperties 與內容 export_id 必須匹配；舊工作缺 itemIds 時只從原 AI-Inbox 下載復原。缺失／不匹配／重複占位檔 fail closed。離線手動匯入仍保留既有部分結果預覽能力。

## v2.4.0：Codex 逐筆讀取內容與證據閘門

新版保持 **inbox / organized schema_version=2**、export_id、item.id、Drive 原檔 ID/parent/appProperties/SHA-256 驗證、人工套用及 Undo 不變。新增 **organized.items[].evidence**，詳細規格與取得方法見 [CODEX-CONTENT-EVIDENCE.md](./CODEX-CONTENT-EVIDENCE.md)。

- `content_read`：Codex 回報實際讀取的 article_body/post_text/transcript/user_share_text（與 item.url 相同的 source_url，至少 24–80 字的真正文字 excerpt，observed_at）。
- `image_read`：Codex 必須真的檢視 ZIP 原圖，且 evidence.attachment_sha256 與匯出的附件 hash 一致。只看圖片檔名／縮圖 URL 不合格。
- `metadata_only` / `auth_required` / `blocked` / `unavailable`：只能 insufficient_data、low、空 summary 和空標籤；不能把 YouTube 標題或社群網站主網域猜測成影片／貼文內容。
- **舊版 organized 沒有 evidence 仍可載入**，但被標記為 `legacy_unverified` 且預覽預設不勾選。新版 Codex 批次使用 `node scripts/validate-organized.mjs organized.json inbox.json|zip --require-evidence` 強制每筆附 evidence。
- App 只能驗證所提供 evidence 的欄位、來源 URL、與原圖 SHA；**無法獨立證明 Codex 真的造訪網頁或檢視圖片**。UI 將明示「Codex 回報」，最後依使用者人工確認套用。

公開文章可在有網路許可的 Codex workspace 手動執行 `node scripts/collect-content-evidence.mjs <inbox.json|zip>`。該 Node CLI 只對符合安全界線的公開 HTTPS 文章做正文擷取，最多 100 筆、8 秒逾時、1MiB HTML 上限，拒絕登入/轉址/私網/社群頁；結果只寫至被忽略的 `private-data/`。對 Threads/Instagram/X/YouTube 等不能假稱已取得正文，仍需 Codex 具有正當可用的實際內容工具或使用者提供分享文字／截圖。
