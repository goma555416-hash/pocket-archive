# v2.1.3 → v2.2 資料遷移與回滾 SOP

瀏覽器儲存以 origin 隔離；`https://goma555416-hash.github.io` 的 IndexedDB 不會自動出現在 `workers.dev` 或自訂網域。舊站不得被自動導向、刪資料或停用。完整切換前，先用匿名資料演練一次。

> **時間點要求：** 因 `main` 更新會自動重新部署 GitHub Pages，至少一份舊站完整 ZIP 必須在首次合併 PR #6 **之前**下載並驗證；以下「遷移前」步驟不是等 Cloudflare 部署時才開始。若尚未完成備份，停止合併。

## 一、遷移前

1. 在舊 iPhone 與 Windows 各自打開 Pocket Archive，記錄總收藏／待整理／圖片數與未解決衝突。
2. 兩端各下載一般「完整備份」，保存在不同位置；含圖片必須保留完整 ZIP。
3. 讓舊站兩端完成最後一次 Drive 同步，處理所有衝突，再停止新增、編輯與刪除。從此把舊站視為唯讀回滾點。
4. 選一台資料最新且附件完整的舊站裝置作為 primary，下載「跨網址遷移 ZIP」。匯出會逐一驗證附件 SHA-256；失敗時不可繼續。
5. 不刪除主畫面舊 App、不清除 Safari 網站資料、不刪 Drive 資料夾。

遷移 ZIP 包含 `backup.json`、`migration.json` 與附件。`migration.json` 只保存 causal clock、delete tombstone、AI `export_id`／工作索引與既有 Drive workspace ID；不含 Access/Refresh Token、Session、Client Secret、捷徑 token 或加密密碼。

## 二、先遷 iPhone

1. Safari 開新 v2.2 HTTPS 網址，但先不要登入 Google。
2. 「備份／還原」→「選擇 JSON／ZIP 還原或遷移」→ 選遷移 ZIP。
3. 預覽必須顯示正確來源 origin、待新增／重複／ID 衝突數及 tombstone 數。任何 SHA、附件、路徑或 schema 錯誤都要停止。
4. 確認匯入。新站保留自己的新 device ID；依每筆 clock 重建 journal，不把舊 device journal 冒充成新裝置。
5. 離線抽查收藏、圖片原檔、分類、標籤、備註、星號、AI 摘要與搜尋。已刪除的匿名測試項目不可復活。
6. 再登入 Google。優先沿用原 Google Cloud project/client；確認找到原本 `Pocket Archive` Drive workspace，先執行同步、再做一份新站完整備份。
7. 完全關閉並重開 PWA，確認 Session 自動恢復；只有 grant/session 失效才應要求登入。

舊主畫面 PWA 與新 origin 是兩個 App。確認新站後，從 Safari 對新網址「分享 → 加入主畫面」；不要期待舊 Icon 自動換 origin。

## 三、再遷 Windows

1. iPhone 新站同步完成後，Windows 開新 origin；同樣先匯入**同一份已驗證遷移 ZIP**。
2. Windows 會保留另一個新 device ID；重複項目略過，因果時鐘與 tombstone 仍保留。
3. 登入同一 Google 帳號，雙向同步。新增一筆匿名 URL，確認 iPhone ↔ Drive ↔ Windows 收斂後刪除它，再確認刪除也收斂。
4. 檢查 AI-Inbox/AI-Results 的既有 `export_id` 不被重建或套到錯誤工作。

不要在 iPhone 新站完成驗證前，讓 Windows 舊站繼續寫入；新舊 origin 同時寫入會形成兩條 journal 分支。

## 四、切換條件

只有以下全部成立，才把新站當主要入口：

- iPhone、Windows 的收藏／圖片數與抽查 SHA 正確。
- tombstone 測試未復活；衝突面板沒有未理解的項目。
- 新站登入重開可恢復、Drive 備份與同步成功。
- 快捷分享回 `accepted`，App 開啟後才顯示真正收入筆數，Windows 後續同步可見。
- 已保留舊站一般備份、遷移 ZIP 與至少一份 Drive 歷史備份。

GitHub Pages 工作流程保持啟用，舊網址不自動 redirect。至少觀察一週再考慮移除舊主畫面 Icon；仍不要主動清除舊 IndexedDB。

## 五、回滾

### 新站尚未產生正式變更

停止使用新站，回到舊 Icon／URL；不要刪新站資料。舊 IndexedDB 與 Drive 歷史備份仍完整。

### 新站已產生新收藏或刪除

1. 立即停止所有新舊站寫入與自動同步，只選一台新站裝置作 primary。
2. 從新站下載一般完整備份與跨網址遷移 ZIP。
3. 確認舊 URL 已載入含遷移功能的 v2.2 靜態相容版本；若仍是 v2.1.3 cache，先線上重新載入並確認版本，但不要清網站資料。
4. 在單一舊站裝置匯入新站遷移 ZIP，檢查預覽與衝突。完成後只讓這台舊站連結 Drive 並同步。
5. 驗證完成後才讓第二台舊站同步。不要盲目把兩端全量 ZIP 互相覆蓋。

若回滾匯入失敗，保留所有檔案與兩個 origin，不做清除；用遷移前一般 ZIP 還原到一個隔離瀏覽器設定檔，先比對再決定正式資料方向。

## 六、10 分鐘匿名回滾演練

1. 舊站建立兩個匿名 URL、一張小圖，刪除其中一筆並建立一個 AI export。
2. 匯出遷移 ZIP，在新 origin 匯入；確認 1 筆 URL＋1 張圖存在，刪除項目不存在。
3. 新站新增一筆匿名 URL，再匯出遷移 ZIP。
4. 回舊 origin 匯入第二份 ZIP，確認只新增新站那筆、圖片 hash 正確、刪除項目仍不存在。
5. 刪除所有匿名測試項目；不要用私人收藏做演練。
