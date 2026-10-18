# Pocket Archive — 開發交接摘要（v2）

`MASTER-TASK.md` 所列可自主完成的 P0／P1 已落實：IndexedDB、圖片、批次網址、分類與批次編輯、JSON/ZIP 完整備份、人工 Codex 整理與復原、iPhone 安全捷徑文件、PWA 離線及 Pages 部署準備。

開始維護前依序閱讀 `AGENTS.md`、`MASTER-TASK.md`、`README.md`、`DESIGN-SPEC.md`、`AI-BATCH-SPEC.md`。品牌配色與 A3 Icon 仍是不可重設的使用者決定。

快速驗證：

```bash
npm run test:all
node scripts/validate-organized.mjs examples/organized-example.json examples/inbox-example.json
```

主要模組：

- `lib.mjs`：資料/schema/URL/批次/AI 純邏輯。
- `db.mjs`：IndexedDB、附件與保留式 v1 遷移。
- `archive.mjs`：零依賴 ZIP store encoder、store/deflate reader、CRC 與安全路徑。
- `app.js`：UI 工作流。
- `tests/e2e.mjs`：無外部套件的 Chromium CDP 整合測試。

不要提交 Pocket Archive 備份、inbox 匯出、`organized.json` 或真實圖片；`.gitignore` 已提供防線，提交前仍需人工檢查。
