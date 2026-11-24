# Pocket Archive 正式 Windows 接手

2026-11-24 使用者授權：沿用同一 Worker、D1、Google OAuth、Drive 與 PWA；合併 PR #34、部署、切換與停用舊 Routine。取消新增測試雲端環境。這份文件是可執行程序，完成與否以 PR 最新實際結果為準。

## 已核對及保留

- 切換前正式版本：`76cbb21b-8fc3-49cc-b708-612f0317864a`（100%），2026-11-15 部署；目前沒有 AI_DISPATCH_MODE，等同 routine。
- 原 Worker `pocket-archive`、origin `https://pocket-archive.goma555416.workers.dev`，原 D1 binding DB 與 database ID 保持 `wrangler.jsonc` 的既有值。沒有 schema migration 或資料複製需求。
- 僅查 ai_jobs 的狀態／failure_code 聚合：2 applied、0 queued、0 running、0 uncertainty；查詢 rows_written=0。這是當次快照，切換前必須再查，不能據舊快照操作。
- GOOGLE_CLIENT_ID、GOOGLE_CLIENT_SECRET、TOKEN_ENCRYPTION_KEY、AI_ROUTINE_FIRE_URL、AI_ROUTINE_FIRE_TOKEN 在 Cloudflare 保留；只核對 secret 名稱，不下載或另存值。Google 授權與 Drive workspace 沿用，不重建、不重命名結果檔。
- Broker 仍為獨立虛擬服務帳號，服務／檔案／程序 ACL、固定 HTTP 操作、redirect/proxy 禁用及本機 pipe 限制不變。正式標記 production.enabled 只在 SYSTEM-owned 服務目錄內，內容必須精確匹配固定 origin。標記存在時其他 HTTPS origin 也被拒絕；缺標記時正式 hostname（含 IDN／尾端點別名）仍被拒絕。

## 部署順序

1. 完整 verify 與現有 PR CI 通過，確認提交樹等於驗收戳記；合併同一 PR。先停止新本機領單（`manage.ps1 Stop`），不改任何工作 row。
2. 首次部署新版安全寫回機制但維持 Claude：`npx wrangler deploy --config wrangler.jsonc --var AI_DISPATCH_MODE:routine --keep-vars`。即使設定檔的目標是 poll，此階段必須明確覆寫。秘密、D1、origin 與 cron 保留，勿執行 migrations apply／資料還原。
3. 驗證 `/api/session` 未登入為 JSON 401、公開 App／sw.js 為本版、未知 agent credential 為 401；保存新版 routine 部署 ID 作安全回滾基準。不以 HTTP 200 的首頁冒充端到端成功。
4. 使用者在原 App 的 Drive 同步區建立**新**的代理憑證，名稱填 Windows Codex；舊版介面按鈕仍名為「建立 Claude 代理憑證」。只把新值輸入下列管理員 SecureString 提示，不貼進對話、不存 repo／環境變數／一般檔案、不使用 Claude 舊憑證。預設 90 日期限到期前需要可信管理員輪替；不承諾無限期免維護。
5. 管理員 PromoteProduction 備份固定假憑證 ProbeOnly 的四個檔案到受保護 `probe-backup`，核對 SYSTEM owner／ACL／服務 SID／已審查 build SHA 後換入正式設定。程序在同一 Runner mutex 下執行；有執行中的 Runner 或缺 stop marker 就拒絕。保持 Manual 並啟動，只持有憑證，沒有 Runner 時不領單。中途失敗保留備份與停止狀態，不能跳過檢查繼續。
6. 一般桌面及實際 Codex sandbox 重新驗證檔案／程序權限拒絕，桌面 opcode 0 核對 pipe PID／owner。只有這些通過，才啟用 Limited 事件 Runner。遠端 pipe 實測未完成需明列；既有 remote-reject flag／NETWORK deny 不移除。
7. 再次查狀態聚合，若存在 running／writeback_in_progress／writeback_uncertain／舊 writeback_failed 或 mismatch，停止切換，先核對原工作。不要 reset attempt／retry／PATCH／重建占位檔。沒有執行中工作後部署 `npx wrangler deploy --config wrangler.jsonc --var AI_DISPATCH_MODE:poll --keep-vars`。
8. 一般桌面 EnableRunner／Start。登入與解鎖延遲 15 秒、睡眠恢復延遲 30 秒，60 秒事件去重，逐批排空直到 204 後退出。無週期輪詢，無工作不啟動 Codex；開機尚未登入時只有 Broker 可運作。
9. 真實公開合成批次確認原 Drive file ID、attempt、寫前 metadata／SHA、寫後 bytes 的 SHA、ready、手機預覽／選擇套用／Undo；只看 ready 不代表 iPhone 操作通過。新工作在睡眠時留 queued，喚醒後由排程處理。不得把既有模擬管線改列為此項 PASS。
10. Windows 真領單與寫回確認後停用 Claude Routine 的自動／API 觸發，保留定義及 secrets 供回滾，不永久刪除。Worker poll 已不再呼叫 fire，D1 的 running 排他與寫回鎖繼續避免同批雙寫。

## 唯一必要的本機管理員設定

一般桌面先執行 Build 取得已審查 executable SHA，並執行 Stop。管理員在專案資料夾使用 Windows PowerShell 5.1（不是未提升的終端），將下列 HASH 替換為交付紀錄的 SHA；新憑證只在提示時輸入：

```powershell
.\scripts\windows\manage.ps1 PromoteProduction -BrokerHash HASH
```

腳本自動保存 fake ProbeOnly 備份，不改服務 SID／SCM DACL／權限清單。使用者可在同一管理員視窗執行 `sc.exe config PocketArchiveBroker start= delayed-auto`，供下次開機啟動服務；在後續一般桌面權限驗收通過前，不啟用 Runner 排程。清除當前剪貼簿，不將憑證或管理員 transcript 貼回；只提供 State／PID／SHA。秘密輸入及管理員權限不能由 Codex 代辦。

## 停止與回滾

1. 一般桌面 `manage.ps1 Stop`：完成目前批次後不再領新單。必要時 `DisableRunner` 回收程序樹，但此時提交結果可能未知，先保留恢復證據。
2. 不直接回復舊 Worker：保留新版寫回鎖／隔離碼。等待 running 清空；不確定寫入必須人工比對原 file ID、attempt、receipt、metadata 與 SHA，禁止以重送或改 row 清除問題。
3. 安全模式回滾使用本版程式部署 `--var AI_DISPATCH_MODE:routine --keep-vars`，重新啟用原 Claude Routine。保留舊 secrets，因此無須讀出再輸入；queued 可由既有 cron 推進，running 不重新派發。
4. Broker 若需回假憑證，由管理員 `manage.ps1 RestoreProbe`；前置是 stop marker、Runner 不在執行、task 已移除／Disabled。恢復已驗證假設定並刪除 production.enabled，保持 Manual。備份保留，下次 PromoteProduction 只有備份與恢復後檔案完全相同才可重用。不自動刪除 Drive、D1 或本機結果。

## 尚不能宣稱完成的項目

部署、真服務正式憑證、首次正式 batch 同 ID／SHA、手機操作、Routine 停用與最新 CI 結果逐項記於 PR。真正登入與遠端 SMB pipe 尚缺證據；不因執行政策問題放寬沙盒或把本機 transport failure 當 remote ACL 通過。
