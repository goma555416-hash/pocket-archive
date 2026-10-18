# HTTPS 靜態部署

本專案不需要建置步驟或伺服器。GitHub Pages 工作流程會把儲存庫中的靜態檔案原樣發布；啟用部署會建立可公開存取的網站，因此必須由儲存庫擁有者確認。

## GitHub Pages

1. 確認 `git status` 沒有任何備份、圖片、`organized.json`、token 或私人資料。
2. 把此分支合併到預設分支。
3. GitHub Repository → **Settings → Pages → Build and deployment → Source** 選 **GitHub Actions**。
4. 在 **Actions** 查看 `Deploy Pocket Archive to GitHub Pages`。成功後 Pages 畫面會顯示 HTTPS 網址。
5. 用 Windows 測試新增一筆匿名資料、重新整理及離線啟動，再用 iPhone Safari 加入主畫面。

若要啟用 v2.1 Google Drive，部署完成後還必須把 Pages 的 **origin**（例如 `https://goma555416-hash.github.io`，不含 repository path）加入 Google OAuth Web Client 的 Authorized JavaScript origins，再依 [GOOGLE-DRIVE-SETUP.md](./GOOGLE-DRIVE-SETUP.md) 驗證。Client ID 可貼入 App；Client Secret 不可放進 GitHub Pages。

工作流程只需要 GitHub 內建的 Pages 權限，不需要把 Personal Access Token 寫入前端。私人儲存庫是否能使用 Pages 取決於 GitHub 方案；而 Pages 網站本身不等同私人存取控制。

## 自訂靜態主機

也可把以下檔案按原目錄部署到任何支援 HTTPS 的靜態主機：`index.html`、CSS、JavaScript modules、manifest、Service Worker 與 `icons/`。主機必須：

- 以正確 MIME 提供 `.mjs` / `.js`；
- 不重寫或快取 `sw.js` 很長時間；
- 讓 Service Worker 的 scope 覆蓋 App 目錄；
- 全站 HTTPS。

部署網址與 `localhost` 是不同儲存來源。先在舊網址下載完整備份，再到新網址匯入；不要期待瀏覽器自動搬移 IndexedDB。
