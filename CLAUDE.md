# Claude Code 指示 — Pocket Archive

本專案原本在 Codex 使用，完整規則維持在 AGENTS.md（唯一來源，修改規則請改 AGENTS.md）：

@AGENTS.md

## 在 Claude Code 中的對應

- 文件中提到「Codex」執行 AI 分類、讀取來源、產生結果的地方，在此由 Claude Code 擔任，流程與限制完全相同（不另接 AI API、fail closed、不搜尋 Notion 或其他私人工作區）。
- `CODEX-*.md` 檔名保持不變，照樣閱讀並遵守。
- AI 整理前先讀 `CODEX-DRIVE-WORKFLOW.md` 的「Claude Code 執行時」：目前的 Google Drive 連接器 `update_file` 只能改 metadata，無法保留 file ID 覆寫內容，Drive 寫回必定 fail closed。不得改名／移動占位檔或另建結果檔代替；經使用者同意才改用 `private-data/` 本機交接。
- 讀取來源依 `CODEX-CONTENT-EVIDENCE.md` 的「Claude Code 執行時」：WebFetch／網路搜尋的摘要不能當正文 excerpt，圖片要先比對 SHA-256 再實際檢視。
- 專案 skills 位於 `.agents/skills/`（Claude Code 不會自動載入此資料夾），依 AGENTS.md 指示直接讀取對應的 `SKILL.md`；與全域同名 skill 衝突時以專案版為準。
- 開發驗證：`npm run test:all`（E2E 在 Windows 會自動找 Chrome／Edge）。
- 使用繁體中文與使用者溝通。
