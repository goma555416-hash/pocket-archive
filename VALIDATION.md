# Pocket Archive v1.2 — 驗證紀錄（2026-10-17）

## 已驗證
- `node --test tests/*.test.mjs`：7 項既有單元測試通過。
- `node --check app.js`、`node --check lib.mjs`、`node --check sw.js`：語法檢查通過。
- `manifest.webmanifest`：有效 JSON，未包含 Android Web Share Target。
- Icon：180、192、512、1024 PNG 尺寸正確；SVG 可轉換為 PNG。
- ZIP：結構及 CRC 檢查正常，重要檔案在 ZIP 根目錄。

## 尚未驗證
- 嘗試使用自動化 Chromium 連線至執行環境的 localhost 時，被執行環境管理政策阻擋（`ERR_BLOCKED_BY_ADMINISTRATOR`）；因此 **沒有完成真實瀏覽器互動 / 視覺驗收**。
- iPhone Safari / 主畫面安裝及 PWA 快取更新需用實機驗證。
- 專案未部署到公開 HTTPS；也未測試 iPhone / Windows 同步（目前不存在）。

## Codex 下一輪建議手動驗收
1. Windows 透過 `python -m http.server 5173` 開啟網站，新建 2 筆網址，確認編輯、搜尋、去重、狀態變更。
2. 匯出 JSON 備份，重新開啟另一個測試瀏覽器設定檔匯入，確認資料一致。
3. 檢查完整 UI，包括 iPhone 寬度、表單和底部導覽列，確認無水平溢出、主按鈕可操作。
4. 發佈至 HTTPS 測試位置，用 iPhone Safari 加入主畫面並檢查 A3 icon 的大小、顏色、裁切和離線啟動。
5. 每次修改快取資產時更新 `sw.js` 中的 CACHE 版本。

## v1.3 文件更新紀錄（已重新驗證）
- 新增 `MASTER-TASK.md`、`CODEX-START.md`，並調整 `CODEX-BRIEF.md`、`AGENTS.md`、`README.md`：從逐階段等待核准改為 Codex 完成主要功能後再供使用者最後實機驗收。
- **沒有宣稱新增功能已實作**；原來的 v1.2 功能、程式碼、配色、Icon、測試維持不變。
- 重新執行 `node --test tests/*.test.mjs`：7/7 通過；`node --check app.js`、`node --check lib.mjs`、`node --check sw.js`：通過；ZIP 完整性檢查：通過。
