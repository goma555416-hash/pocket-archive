# HTTPS 靜態部署

v2.2 正式持續登入與快捷收件使用 Cloudflare Worker + Static Assets + D1，設定見 [CLOUDFLARE-SETUP.md](./CLOUDFLARE-SETUP.md)。本頁 GitHub Pages 方案保留為舊 origin、遷移工具與安全回滾入口，不提供 Refresh Token 後端。

本專案不需要建置步驟或伺服器。GitHub Pages 工作流程會把儲存庫中的靜態檔案原樣發布；啟用部署會建立可公開存取的網站，因此必須由儲存庫擁有者確認。

## 第一次合併 v2.2 前（不可後補）

`main` 更新會自動重新部署現有 GitHub Pages。合併 PR #6 前，先在目前 v2.1.3 舊站下載「完整 ZIP」備份，確認 ZIP 可開啟，並保存第二份副本。記錄舊 Pages URL 與 Google OAuth 設定，保持舊 Authorized JavaScript origin 可用。此步驟必須早於任何 v2.2 合併，而不是 Cloudflare 正式部署前才做。

合併後的靜態 Pages origin 沒有 Worker API 時，App 會由 `/api/owner/status` 的非 JSON 404 判定後端不存在，繼續使用原本的瀏覽器 GIS OAuth、收藏、ZIP 備份與 Drive 同步路徑。這個 fallback 不會清除、重新建立或自動遷移 IndexedDB。仍應先備份，因為 Pages 自動發布與 Service Worker 更新本身不是資料搬移工具。

## GitHub Pages

1. 確認上述舊站完整備份已完成，且 `git status` 沒有任何備份、圖片、`organized.json`、token 或私人資料。
2. 依序合併後端、快速收藏、遷移 PR；每次都等待 Pages workflow 通過並做本機功能 smoke test。
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

正式搬移必須依 [MIGRATION-ROLLBACK.md](./MIGRATION-ROLLBACK.md) 使用遷移 ZIP。不要在 PR 合併時設定 redirect、停用 Pages 或清除舊站資料。
