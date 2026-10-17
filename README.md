# Pocket Archive — 個人收藏收件匣

**交接版 v1.3（2026-10-17；全功能 Codex 任務更新）** · iPhone／iOS ＋ Windows · Local-first PWA · 不需要帳號或付費 API。

此版本重新整理了既有可運作 MVP，並**實際套用了**目前選定的 Butter Yellow × Periwinkle 配色、A3 實心書籤 App Icon 和 iPhone touch icon。它同時包含未來 Codex 批次分類的清楚開發規格，**但尚未實作 AI 整理或圖片附件**。

## 現在已能使用
- 逐筆保存 HTTP(S) 網址，可自訂標題、類型、標籤、備註與狀態。
- 搜尋、篩選、排序、網址追蹤參數去除與重複網址提醒。
- 完整收藏 JSON 備份／匯入（合併時保留既有紀錄）。
- iPhone 和 Windows 響應式畫面、PWA manifest、離線快取。
- 新版品牌配色和 Apple 主畫面 Icon 素材。

## 尚未完成（Codex 下一階段）
- 一次貼上多筆網址與待整理專用匯出。
- Codex 分類 JSON 結果的匯入、差異預覽、確認套用及復原。
- **圖片檔案**收藏、AI 看圖分析、社群貼文完整內容抓取。
- iOS 分享捷徑、iPhone↔Windows 同步、線上部署與 iPhone 實機驗收。

## 本機啟動
在本專案資料夾執行：

```bash
python -m http.server 5173
```

開啟 `http://localhost:5173`。請勿直接以 `file://` 雙擊 HTML，否則 JavaScript module 與 PWA 可能受限制。

Node.js 18+：

```bash
node --test tests/*.test.mjs
node --check app.js
```

所有收藏目前保存在**目前瀏覽器／目前網址的 localStorage**，無跨裝置同步。Localhost 與未來 GitHub Pages 網址各有獨立資料，若要遷移請先匯出 JSON，再匯入新網址。

## 上傳 GitHub 並交給 Codex
1. 建立新的 **Private** GitHub Repository，名稱建議 `pocket-archive`。
2. ZIP 解壓縮後，把此資料夾內的檔案放在 Repository **根目錄**；不要上傳 ZIP 本身。保留隱藏的 `.gitignore`。
3. Codex Cloud 選擇 `pocket-archive` 儲存庫並建立環境，讓 Codex 先閱讀 `AGENTS.md` 和 `CODEX-BRIEF.md`。
4. **一次執行完整開發任務**：在 Codex 新任務貼上 `CODEX-START.md` 的文字，讓它依 `MASTER-TASK.md` 自主完成主要功能、測試與最終 PR；不再每個階段等待核准。

## 在 iPhone 使用
需要先把網站部署到可經 iPhone 存取的 **HTTPS** 網址；本機 `localhost:5173` 僅供這台 Windows 電腦測試。部署後，用 iPhone Safari 開啟網址 → 分享 → 加入主畫面。這是 Web App，不需要先做 App Store 原生 App。iOS 分享捷徑仍待開發。

若使用 GitHub Pages，請確認該儲存庫所在的方案支持所選 Pages 設定；部署出來的網站本身可被其他人訪問，不要把私人收藏或密鑰放入公開程式碼。私人儲存庫不等於網站訪問權限已受保護。

## 隱私與資料安全
- 無後端與同步；localStorage 不是可靠的永久備份，請定期匯出 JSON。
- 目前不會自動擷取網頁內容、封面圖片，且不自動使用 AI。
- 既有程式仍可解析 `?url=`、`?title=` 等網址參數預填；**不要把私人連結、憑證、token 經由 GET 查詢參數分享**。Codex 下一階段需安全處理此風險。
- `.gitignore` 已排除常見收藏備份、Codex 整理中間檔和私人資料資料夾，仍須人工檢查 `git status`。
- iOS 網頁 App 與 Safari 的儲存可能不完全共用；建議固定入口並定期備份。

## 其他文件
- `DESIGN-SPEC.md`：已選定品牌視覺、色票、Icon 與後續驗收。
- `AI-BATCH-SPEC.md`：**尚未實作**的資料匯出 → Codex 分類 → 建議匯入流程與 schema 提案。
- `MASTER-TASK.md`：**一次開發大部分功能**的完整需求、驗收與安全邊界。
- `CODEX-START.md`：可直接複製到 Codex 的單次啟動訊息。
- `CODEX-BRIEF.md`：新的簡明交接摘要。
- `AGENTS.md`：Codex 行為和隱私邊界。

## 專案結構
```
index.html            現有 UI / Apple Icon 連結
styles.css            原版 CSS（兼容基底）
theme.css             新版視覺配色覆蓋層
app.js / lib.mjs      現有收藏、備份功能
manifest.webmanifest  PWA 設定
sw.js                 離線資源快取
icons/                icon.svg (原始圖)、180/192/512/1024 PNG
tests/                原有 Node 測試
AGENTS.md / MASTER-TASK.md / CODEX-START.md / CODEX-BRIEF.md
DESIGN-SPEC.md / AI-BATCH-SPEC.md
.gitignore            避免誤提交私人備份
```

> v1.3 **僅更新 Codex 任務與文件**，應用程式仍沿用 v1.2 的現有功能；請讓 Codex 依完整任務實作。不是已經完成 AI 分類、圖片附件或同步的全功能版本。
