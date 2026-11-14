# Windows 本機 AI 整理流程（Claude Code）— 設計

日期：2026-11-14　狀態：使用者已核准

## 目的

使用者在 iPhone 收藏網頁、圖片等，交給 AI 整理分類，兩端都要看到結果。分工已定案：

- **iPhone**：只負責收藏，以及查看已分類的結果。
- **Windows**：建立待整理批次、交給 Claude Code 整理、預覽並套用建議。

## 為什麼不做 Drive 寫回

Claude Code 的 Google Drive 連接器無法保留 file ID 覆寫內容，Drive 自動交換在它身上必定 fail closed。原本考慮讓 App 代為寫回占位檔，但那只在「批次在 iPhone 建立、結果在 Windows 產生」時才需要。現在批次的建立和套用都在 Windows，App 既有的「離線／手動檔案流程」就足夠，收藏則靠既有的自動同步（回到前景、收藏變動後自動觸發）在兩端更新。

## 考慮過的做法

| 做法 | 取捨 | 結果 |
| --- | --- | --- |
| Windows 本機檔案流程 | 不改交接規則，不需新授權；使用者在 Windows 多選一次檔案 | **採用** |
| Windows App 把結果寫回 Drive 占位檔，iPhone 套用 | 套用要在 iPhone 進行，不符合新的分工；需要新的上傳入口 | 不採用 |
| Windows App 放寬「只收本機匯出批次」檢查 | 削弱防錯檢查，iPhone 的工作狀態會不一致 | 不採用 |
| Claude 以本機腳本直接寫 Drive | `drive.file` 權限看不到 App 建的檔案，需要更大範圍的權限 | 不可行 |

## 流程

1. iPhone 收藏，自動同步到 Windows。
2. Windows App：AI 整理視窗 →「離線／手動檔案流程」→「下載待整理批次」（JSON 或 ZIP，存到下載資料夾）。
3. 使用者請 Claude 整理該批次。Claude 依 `CODEX-ORGANIZE-PROMPT.md`、`CODEX-CONTENT-EVIDENCE.md` 逐筆取得內容與證據後分類，把結果寫到 `private-data/organized-<export_id>.json`，並以 `node scripts/validate-organized.mjs <organized> <inbox> --require-evidence` 驗證通過。原始批次檔不修改、不提交。
4. Windows App：「匯入結果」選該檔，逐項預覽、勾選、套用（可單次復原）。
5. 自動同步，iPhone 看到分類結果。

## 要改的地方

### 文件
- `CLAUDE.md`：把上述流程寫成 Claude 的標準 AI 整理做法；Drive 自動交換改為選用（目前會 fail closed）。
- `CODEX-DRIVE-WORKFLOW.md`「Claude Code 執行時」：指向本機流程為建議做法。
- `README.md` 批次整理段：補上 Windows 本機流程步驟。

### 程式小修：本機匯入也要結束對應的雲端工作
目前 `applyOrganized`（`app.js`）只把狀態為 `ready` 的雲端 AI 工作標成 `applied`；`ready` 只有在「檢查 Drive 結果」時才會設定。若使用者曾在 Windows 用「送到 Drive」建立批次、後來改用本機匯入套用同一個 export_id，該工作會永遠顯示待處理。

修正：套用成功後，與 `sourceExportId` 相同、且狀態不是 `applied` 的雲端工作一律標成 `applied`。不改變其他行為，不動 schema、export_id 檢查或 Drive 驗證。補上對應測試（單元或 E2E，由實作決定最合適的層級）。

## 目標與非目標

- 目標：Windows 一台完成整理與套用，iPhone 只需同步查看。
- 非目標：Drive 寫回、修改 iPhone 收藏流程、App 畫面「Codex」字樣改名（另案）。
- 反目標：放寬任何匯入驗證、讓 AI 結果未經人工勾選就套用、把私人批次或結果提交到 Git。

## 留給實作者

- 「本機匯入結束雲端工作」測試放在哪一層。
- 文件用詞細節。
