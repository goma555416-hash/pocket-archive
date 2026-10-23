# Pocket Archive：Codex 批次整理指令

請整理我明確提供的 Pocket Archive 匯出檔，先讀 AGENTS.md、AI-BATCH-SPEC.md、CODEX-DRIVE-WORKFLOW.md、**CODEX-CONTENT-EVIDENCE.md**；禁止搜尋 Notion 或其他私人工作區，不要存取其他私人資料，也不要把結果提交到 GitHub。

輸入是 `pocket-archive-inbox` schema v2：純連結批次為 JSON；含圖片時為 ZIP，清單在根目錄 `inbox.json`，圖片路徑由各 item 的 `attachment.path` 指定。請逐項遵守：

1. 逐筆依 **CODEX-CONTENT-EVIDENCE.md** 先嘗試取得公開正文、實際貼文文字、合法可讀字幕或 ZIP 原圖像素，再判斷；對公開一般文章優先使用 `node scripts/collect-content-evidence.mjs <private-inbox.json|zip>` 取得有來源紀錄的內容摘錄（來源不可讀時不可虛構）。每筆**必須輸出 evidence**。如果僅有標題、網址、備註中的猜測、平台嵌入資訊，或需要登入／被封鎖／圖片不可解碼，使用 `insufficient_data`、低信心、空標籤及空摘要。
2. `type` 只有圖片／影片／社群／網頁，代表呈現形式，不是主題；`webpageKind` 是文章／網站／一般網頁的可選細分。不要輸出類型建議或修改人工確認。主題（遊戲、香水、工具、教學等）放入 `suggested_tags`（最多 8 個）；優先重用既有 tags 與非空 category 的用詞。新結果 `suggested_categories` 使用空陣列；App 仍相容讀取 v2.3.1 的非空 suggested_categories 並將其合併為標籤，不丟棄舊建議。避免只差字詞的近義標籤。
3. 不改寫 id，不輸出原始備註、token 或附件內容。摘要使用繁體中文、最多 200 字；reason 簡短說明證據。信心只能是 `low`、`medium`、`high`。
4. `source_export_id` 必須逐字複製輸入的 `export_id`。每個輸入 item 恰好輸出一次；未知 ID 不得加入。
5. 只建立一個 `organized.json`，格式必須是：

```json
{
  "format": "pocket-archive-organized",
  "schema_version": 2,
  "source_export_id": "逐字複製 inbox export_id",
  "items": [
    {
      "id": "逐字複製 item.id",
      "analysis_status": "completed",
      "suggested_categories": [],
      "suggested_tags": ["設計靈感", "配色", "排版"],
      "summary": "依實際可見內容撰寫的摘要",
      "reason": "根據可見標題、正文或圖片",
      "confidence": "medium",
      "evidence": { "status": "content_read", "kind": "article_body", "source_url": "與輸入該筆 item.url 完全一致", "excerpt": "至少 80 字元、實際讀到的文章正文（請替換此示例）", "observed_at": "2026-10-23T12:00:00.000Z" }
    }
  ]
}
```

無法分析的項目仍需輸出：

```json
{
  "id": "原 id",
  "analysis_status": "insufficient_data",
  "suggested_categories": [],
  "suggested_tags": [],
  "summary": "",
  "reason": "頁面需要登入，未取得可驗證內容",
  "confidence": "low",
  "evidence": { "status": "auth_required", "kind": "metadata", "source_url": "與輸入該筆 item.url 完全一致", "excerpt": "", "observed_at": "2026-10-23T12:00:00.000Z" }
}
```

完成後先執行：

```bash
node scripts/validate-organized.mjs organized.json pocket-archive-inbox-YYYY-MM-DD.json --require-evidence
```

若輸入是 ZIP，驗證器也接受 ZIP 作為第二個參數。只有驗證通過才把 `organized.json` 交回使用者；不要修改原始匯出檔。

Drive 批次必須使用 App 產生的 export_id 專用指令。開始前驗證 raw download／原 file ID 更新與回讀能力，任何缺少皆 fail closed。只更新既有 organized-<export_id>.json，不另建檔；回讀結果驗證後才報完成，App 仍先預覽與人工套用。
