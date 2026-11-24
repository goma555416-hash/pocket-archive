# 隔離端到端驗收準備

> 2026-11-24：使用者取消此隔離資源計畫，改授權直接正式遷移。盤點時僅有正式 Worker／D1 與正式 OAuth client，沒有建立任何隔離資源；內建瀏覽器的建立草稿未送出。本文件保留歷史參考，現行入口為 [PRODUCTION-CUTOVER.md](PRODUCTION-CUTOVER.md)。

本階段只接續 PR #34。Windows 改成登入／解鎖／喚醒事件啟動一次佇列排空；`poll` 仍是既有 Worker 的「由 agent claim」模式名稱，不代表 Windows 必須固定輪詢。

目前已進入隔離端到端的資源／安全驗收準備，尚未獲准建立外部資源。真解鎖／喚醒去重、Limited 排程公開批次、實際睡眠回收（事後核對）已有證據。真正 shell 子程序回收仍被 CLI 的有效 read-only／exec policy 阻擋；遠端 pipe 無可達測試路徑，獨立登出後登入亦未取得證據。這些是明確待補條件，不能把本機自動測試通過當成全面安全通過。

## 現有資源與缺口

| 資源 | 現況 | 下一步／影響 |
| --- | --- | --- |
| 分支與 Worker 程式／D1 migrations | 已有，沿用格式及原子領單／隔離寫回 | 不新增 schema，不重寫既有流程 |
| Windows Broker | 已安裝 ProbeOnly、假憑證、.invalid、Manual | 保持此用途；隔離後端須另經核准安裝／設定，不能直接變生產服務 |
| 本機假 Worker／Drive | 已可多批排空、離線、逾時、未確認寫回回歸 | 不是遠端 HTTPS／真 Drive 的證據 |
| 隔離 Cloudflare Worker／D1 | 未發現已核准的設定；現有 wrangler.jsonc 指向生產 | 需批准新建一個獨立 Worker 與獨立 D1，確認帳戶及方案容量；不可使用生產 database_id |
| 隔離 HTTPS origin | 尚未配置 | Worker 的獨立 workers.dev 網址即可，無需新購網域 |
| 測試 Google 帳號／OAuth client | 尚未提供授權 | 專用測試帳號，只放公開／合成收藏；獨立 OAuth client 與 callback，不連私人收藏帳號 |
| 隔離 owner 與加密 key | 尚未建立 | 可信管理者設定 OWNER_GOOGLE_SUB 或一次性 OWNER_BOOTSTRAP_TOKEN、全新 TOKEN_ENCRYPTION_KEY；不放 Git 或交給 Codex |
| 測試 agent credential | 尚未建立 | 隔離 App 建立最短 1 日期限、完成立即撤銷；只由可信服務保管，不能沿用生產 Token |
| iPhone 測試入口 | 待上述 HTTPS origin | 以獨立網址與測試帳號開啟，避免覆蓋目前生產 PWA／資料 |

已提供 `worker/wrangler.isolated.example.jsonc`，只有占位值，不能直接部署。它位於已排除的 worker/ 目錄，不是公開 App 資產。未建立外部資源、未取得帳號授權，也未執行部署；這是目前真正 HTTPS／Drive 端到端驗收的具體資源阻礙。

## 核准後的最少操作

1. 使用者指定可建立隔離資源的 Cloudflare 帳戶，批准一個 Worker／D1；選定專用 Google 測試帳號及 OAuth client。此步會新增外部資源／可能占用配額，沒有授權前不執行。
2. 用獨立設定檔填入新 D1 ID、HTTPS origin，套用既有 migrations。所有 wrangler 指令必須明確 `--config` 指向隔離檔，不能使用預設生產設定。OAuth callback 使用新 origin 的 `/api/auth/callback`（實施前再核對 Worker route）。可信管理者以 secret prompt 設定 GOOGLE_CLIENT_ID、GOOGLE_CLIENT_SECRET、TOKEN_ENCRYPTION_KEY 及 owner 設定，不將值貼進對話／腳本／PR。
3. 管理員安裝隔離後端的 Broker 設定前，保存現有 ProbeOnly 驗收與回滾檔，確認檔案 owner／ACL、服務 SID、憑證來源。現有 ProbeOnly 不直接改成生產服務；本 PR 不包含這一步的執行授權。一般桌面使用新版事件排程，無需手動輸入 claim 或開 Codex。
4. 使用者只需在 iPhone／測試入口送出兩個公開合成批次，再睡眠／恢復一次。其餘由 Runner 排空、驗證及回報，人工只驗預覽／勾選／Undo。不得用私人收藏填補測試素材。

## 端到端通過條件

- 兩筆批次在睡眠時保持 queued；恢復事件啟動 Runner，一批完成後接下一批，最後 HTTP 204 才視為空佇列，沒有工作不啟動 Codex。
- 保存兩批 export_id／attempt、原 Drive file ID、寫前 metadata／SHA、寫後 metadata／讀回 SHA。每批最多一個被確認的 PATCH，不另建結果檔。
- 工作進入 running 後超過 60 分鐘，舊 attempt 交回被拒；恢復不自動 retry 舊工作。PATCH 已送出而讀回不確定時保留隔離，重新事件／重新啟動不得第二次 PATCH。
- 在隔離後端撤銷測試 credential，服務收到拒絕且有限重試後退出，不能把拒絕當空佇列；換測試憑證須另由可信管理者操作。
- Windows／iPhone 預覽取消不改收藏；只套用勾選項目；Undo 復原且來源／圖片／手動類型不變。
- 比對服務隔離、事件觸發、真 Codex 執行與真 Drive 證據，不能用 fixture 或歷史測試替代。未通過的項目逐項保留，不擴大本機架構來迴避外部驗收。

## 結束／回滾

移除驗收用事件排程、撤銷隔離 agent credential、解除測試 Google 授權；保留必要的合成恢復證據。是否刪除隔離 Worker／D1／Drive 測試檔由使用者明確決定，不自動刪除。生產 Claude Routine、Worker vars 與憑證從始至終維持原樣。
