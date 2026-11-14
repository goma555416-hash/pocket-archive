# UAT：雲端 AI 整理（v2.5.0）

自動測試已涵蓋後端工作佇列、代理 API、結果驗證、寫回與 App 畫面狀態（模擬後端）。以下需要真實 Claude 雲端任務、Google Drive 與 iPhone，只能人工驗收。先完成 [CLOUD-AI-SETUP.md](./CLOUD-AI-SETUP.md)。

| # | 步驟 | 預期 |
| --- | --- | --- |
| 1 | iPhone 收藏 2 筆公開文章、1 張圖片，等同步；在 iPhone 按「AI 整理」→「送出整理」 | 狀態「整理中…」；Windows 打開 App 也顯示整理中 |
| 2 | 等 Claude 完成（claude.ai 可看到任務執行） | 兩端「AI 整理」按鈕出現圓點，狀態「有結果可查看」 |
| 3 | 在 Windows 打開「AI 整理」 | 預覽清單出現，有證據摘錄；讀到內容的預設勾選，資料不足的不勾 |
| 4 | 勾選後按「套用勾選建議」 | 標籤加上；圓點消失；iPhone 同步後看到同樣標籤 |
| 5 | 反向：Windows 送出，iPhone 預覽套用 | 同上 |
| 6 | 在 Drive `AI-Results` 打開該批 `organized-<export_id>.json` | 內容已是整理結果，不再是 pending；沒有多出其他結果檔 |
| 7 | 在 App 撤銷 Claude 代理憑證後送出一批 | Claude 任務無法領取，約 60 分鐘後顯示「整理失敗」；可重新建立憑證並「重試」 |
| 8 | 刪除 Worker 的 `AI_ROUTINE_FIRE_TOKEN` 後按「送出整理」 | 顯示「雲端整理尚未設定」；Drive 沒有新建批次檔 |
| 9 | 連續送出兩批 | 第二批顯示「排隊中」，第一批完成後自動開始 |
| 10 | 在 GitHub 儲存庫檢查 | Claude 雲端任務沒有建立分支、commit 或 PR |
| 11 | 「備用：手動檔案流程」下載批次、匯入 organized.json | 照舊可用 |

結果與日期請記在下方：

- 驗收日期：
- 結果：
