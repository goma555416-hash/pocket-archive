# Windows ProbeOnly 驗收 — 2026-11-22

範圍：Draft PR #34、既有個人 Windows、固定假憑證與 .invalid origin。沒有讀取私人收藏、創建生產 token、部署 Worker、切換 AI_DISPATCH_MODE、停用 Claude、推送 main 或合併。管理員操作全部由使用者手動執行，Codex 工具只在 sandbox 執行。

## 實測結果

| 項目 | 結果 | 證據與限制 |
| --- | --- | --- |
| 獨立服務身分／SCM | PASS | 使用者管理員輸出：NT SERVICE\PocketArchiveBroker、Running、Manual。原 PID 6900，UpdateProbe 後 21304；不是桌面同 SID |
| 服務最小 privilege／DACL | PASS（設定核對） | qprivs 僅 SeChangeNotifyPrivilege；服務 DACL 僅 SYSTEM／Administrators。sandbox SCM 查詢拒絕，未嘗試升權或修改服務 |
| 檔案 owner／ACL | PASS（設定核對＋存取探針） | Program Files 專用目錄及 agent.secret owner SYSTEM；SYSTEM／BA Full、service RX，桌面無 ACE。舊安裝 hash 與本機舊 build 相符 |
| 憑證／origin／runner.sid／Broker.exe | PASS | sandbox 與一般桌面對四個檔案的 Read／ReadWrite handle 全拒絕；探針不讀取內容 |
| 記憶體及程序控制權限 | PASS | 兩個身分對 VM_READ、VM_WRITE、VM_OPERATION、DUP_HANDLE、CREATE_THREAD、WRITE_DAC、WRITE_OWNER、TERMINATE、SUSPEND_RESUME 全回 Access Denied |
| sandbox privilege／IPC | PASS（測得範圍） | whoami /priv 僅 SeChangeNotifyPrivilege；pipe Connect 拒絕。這不證明所有未測的提權途徑不存在 |
| 授權桌面 pipe | PASS（修正後） | 使用者回報 PID 21304、owner 為服務 SID、opcode 0 被關閉；沒有 claim／後端請求 |
| 實際服務更新／重啟 | PASS | 使用者執行 UpdateProbe：舊 PID 6900 → 21304、Running、Manual；重啟後兩身分檔案／程序拒絕與桌面 IPC 均重測通過 |
| Limited 排程執行／清理 | PASS | 使用者一般桌面執行 probe-schedule；Limited／Interactive／IgnoreNew 核對，排程內 IPC 與權限探針通過，finally 移除暫時 task。沒有啟用正式 Runner task |
| 強制停止／逾時／executor 失敗 | PASS（原生 fixture） | 三個情境 executor 與孫程序均退出，零 PATCH、running 保留；透過 Worker 既有逾時才釋放上一工作，沒有修改 Worker |
| 遠端 named pipe 拒絕 | 未驗證 | 程式有 PIPE_REJECT_REMOTE_CLIENTS 及 NETWORK deny ACE；沒有另一台電腦的實測，不把程式設定當作 PASS |
| 真開機／登出登入觸發 | 未驗證 | Broker 保持 Manual；暫時 task 只有手動 Start-ScheduledTask，沒有重開機／登出 |
| 真 Codex 在排程內的程序樹回收 | 未驗證 | 本輪只用合成 executor／孫程序，不重做已過的分類；前版真 Codex 公開批次不涵蓋本次 Job Object 修改 |
| 隔離 HTTPS Worker／D1／真 Drive | 未驗證 | ProbeOnly 不連後端；既有 in-memory Worker／Drive 測試不等於服務連真隔離後端 |

PID 是當次證據，之後重啟必須重新核對。安裝前的 executable SHA-256：`67CACC7173A223AE2703D79ECBC19B7ABAC4D0FD5C7DBC79D4BD244EF5665790`。本次更新來源 SHA-256：`1BCFF6C5840D2EBF69C4EF6F6D7E967F95C978FDF6CCCFC35AB4941E8C0E1ABF`；UpdateProbe 內部核對安裝 hash 一致才啟動，使用者輸出的表格沒有另顯示 hash，故不宣稱另取得外部 hash 證據。

## 找到並修正的問題

1. **桌面 pipe Access Denied**：設定 runner SID 與桌面 SID 一致，排除填錯帳號。把 fixture 中 server 的 full-control ACE 移除、只保留客戶端權限後，現有測試也失敗；補入 ReadAttributes 後通過。實際服務更新後桌面 probe 亦通過。最小 mask 從 0x120003 改為 0x120083，仍沒有 create-instance／改 ACL／任意操作。Microsoft reference source 說明 CreateFile 會額外要求 ReadAttributes：[Pipe.cs](https://github.com/microsoft/referencesource/blob/main/System.Core/System/IO/Pipes/Pipe.cs)。
2. **孤兒 executor／孫程序**：原 Runner 被強制終止後兩者仍存活，新回歸測試先失敗；加入 Job Object 後通過。executor 逾時或失敗亦退出 Runner，讓 OS 回收子程序樹。無 breakaway flag，未放寬 Codex sandbox。參考 [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)。

## 完整驗收與狀態

本輪 sandbox `npm run verify` 實際結果 **BLOCKED：已知存在阻斷性問題**：Windows Runner/Broker 33 秒、回收測試 6 秒、229 單元／整合、瀏覽器 E2E 26 秒通過；兩條核心流程因 Windows curl Schannel `SEC_E_NO_CREDENTIALS` 失敗，靜態資源測試因 sandbox 禁止寫 `.agents/skills/preflight-private.json` 失敗。未略過或降低 gate，需在一般桌面重跑。最終內容對應的桌面結果及 CI 記於 PR；舊版 41f4bd0 的 AUTOMATED 不代表本次內容通過。

PowerShell 語法檢查與正式 C# build 已通過。新增 Windows lifecycle gate；fixture 使用客戶端最小權限，避免再次被同 SID server 的 FullControl 掩蓋。固定規則測試只證明管線，不代表模型分類品質。

**尚未完成真實操作驗證**：上表未驗證項目、iPhone、真 Claude Routine、本版正式 Worker 部署。可繼續準備隔離後端與公開合成驗收；尚不能宣稱可信隔離完整通過，更不能正式切換。下一階段先補遠端拒絕與實際 Codex 排程回收證據，再以隔離測試帳號／限定後端憑證驗證 HTTPS、撤銷、逾時與同 ID SHA 讀回；不能用生產 token 補測。

## 保持與回滾

Claude Routine 及生產模式維持原樣。ProbeOnly 服務目前 Manual；無常駐 Runner task。暫時排程 probe 不領單且自行移除。管理員可按 WINDOWS-RUNNER.md 回復受保護的 Broker.previous.exe，或 Uninstall 停止並移除專用服務目錄；private-data 恢復證據保留。舊 Broker 有已知 pipe 權限缺漏，回復後不可作整合驗收通過依據。

未確認寫回仍依 CODEX-MIGRATION-PLAN.md 保持隔離；本輪無 Worker／App 改動，沒有重送／解鎖功能。
