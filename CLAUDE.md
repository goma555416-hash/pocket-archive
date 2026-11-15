# Claude Code 指示 — Pocket Archive

本專案原本在 Codex 使用，完整規則維持在 AGENTS.md（唯一來源，修改規則請改 AGENTS.md）：

@AGENTS.md

## 在 Claude Code 中的對應

- **若你是被觸發的雲端整理任務**（觸發內容為 `export_id=… attempt=…`）：只照 `CLAUDE-ROUTINE.md` 做，它優先於本檔與 AGENTS.md 的其他段落；不寫程式、不開分支、不 commit／push、不使用 Drive 連接器。

- 文件中提到「Codex」執行 AI 分類、讀取來源、產生結果的地方，在此由 Claude Code 擔任，流程與限制完全相同（不另接 AI API、fail closed、不搜尋 Notion 或其他私人工作區）。
- `CODEX-*.md` 檔名保持不變，照樣閱讀並遵守。
- **AI 整理的標準做法是雲端自動整理（v2.5.0）**：使用者在任一端按「送出整理」，Worker 觸發 Claude 雲端排程任務，任務依 `CLAUDE-ROUTINE.md` 處理（禁止 commit／push）；一次性設定見 `CLOUD-AI-SETUP.md`。修改 Worker 的 `/api/ai/*`、`organized-shape.mjs` 或 App AI 視窗前，先讀 `docs/superpowers/specs/2026-11-14-cloud-ai-routine-design.md`。
- **備用：Windows 本機檔案流程**（雲端整理無法使用時）：使用者在 Windows App「下載待整理批次」→ Claude 依 `CODEX-ORGANIZE-PROMPT.md`、`CODEX-CONTENT-EVIDENCE.md` 逐筆取得內容與證據後分類，結果寫到 `private-data/organized-<export_id>.json`，並以 `node scripts/validate-organized.mjs <organized> <inbox> --require-evidence` 驗證通過 → 告訴使用者檔案路徑，由使用者在 App「匯入 organized.json」預覽、勾選、套用 → 自動同步到 iPhone。批次檔通常在使用者的「下載」資料夾，找不到就問，不要自行搜尋其他位置。
- Drive 自動交換為選用，在 Claude Code 中目前必定 fail closed（Google Drive 連接器 `update_file` 只能改 metadata，無法保留 file ID 覆寫內容），細節見 `CODEX-DRIVE-WORKFLOW.md` 的「Claude Code 執行時」。不得改名／移動占位檔或另建結果檔代替。
- 讀取來源依 `CODEX-CONTENT-EVIDENCE.md` 的「Claude Code 執行時」：WebFetch／網路搜尋的摘要不能當正文 excerpt，圖片要先比對 SHA-256 再實際檢視。
- 專案 skills 位於 `.agents/skills/`（Claude Code 不會自動載入此資料夾），依 AGENTS.md 指示直接讀取對應的 `SKILL.md`；與全域同名 skill 衝突時以專案版為準。
- 開發驗證與交付：`npm run verify`（含模擬雲端代理的核心流程測試與瀏覽器 E2E；E2E 在 Windows 會自動找 Chrome／Edge）。只有顯示 `AUTOMATED` 才算完成；規則見 AGENTS.md「Delivery gate」。推送／開 PR 前 hook 會檢查這一點。
- 使用繁體中文與使用者溝通。
