# Windows ProbeOnly 驗收 — 2026-11-22

## 後續：事件觸發領單（以此段更新目前狀態）

從 commit 9f9f368 接續；事件策略、有限重試及睡眠截止已實作。Worker／D1 schema／App 沒有改動，既有 ProbeOnly 安裝仍保持假憑證、.invalid 與 Manual，沒有更新成生產服務。

| 項目 | 結果 | 實際證據 |
| --- | --- | --- |
| 原生工作排程 XML | PASS | Windows Task Scheduler COM parser 接受 Logon／SessionUnlock／EventTrigger；Limited、IgnoreNew、無週期／RestartOnFailure／WakeToRun；加入 Windows 自動測試 |
| 真解鎖觸發 | PASS | 2026-11-22 22:12:37 +08:00，Unlock.json：Runner 領取空佇列一次、退出，沒有啟動 Codex |
| 真睡眠恢復觸發及去重 | PASS | 22:12:39 Resume.json：系統喚醒事件啟動 probe；被 60 秒去重抑制，claims=0；Windows System Event ID 1 亦存在 |
| 真登出後登入觸發 | 未驗證 | 沒有 Logon.json；使用者描述的「登入」尚不能替代獨立 Logon 證據 |
| 多批排空／空佇列／重複啟動 | PASS（原生假後端） | 3 批依建立順序各一次同 ID 寫回，接到 204 才退出；mutex、事件去重、重啟不重送 |
| 離線／忙碌 | PASS（原生假後端） | 503 恢復後排空；持續 503 或 409 恰好 4 次後 code 5，不能被誤判為空佇列 |
| 恢復時已過 Worker 截止 | PASS（邏輯時間回歸） | 提交前測試時鐘前進 61 分鐘，舊 attempt 被拒、零 PATCH；並非真正睡滿一小時 |
| 寫回後失去回覆／讀回失敗 | PASS（原生假後端） | ready 回覆遺失仍只有一個 PATCH；讀回失敗保持 writeback_uncertain，跨逾時／新事件不重送、不解隔離 |
| 真 Codex 在 Limited 排程執行 | PASS（公開單批＋模擬 Drive） | 修正排程 PATH 缺漏後，一個公開 IANA 合成批次經真 CLI、既有驗證器、一次同 ID 模擬寫回、空佇列退出。沒有使用額外 AI API |
| 真 Codex shell 子程序回收 | FAIL／阻斷 | CLI 0.169.1 實際顯示 read-only；exec_command 在建立程序前被 policy 拒絕，沒有生成 tool PID marker。不是證明程序洩漏，也不能宣稱回收通過 |
| 真執行中睡眠回收 | PASS（事後交叉核對；縮短的本機截止） | 第二次 Runner 22:19:18 啟動，System Record 61320 記錄 22:19:28 睡眠、22:21:14 喚醒。使用者輸出已越過退出碼 4／子孫全退出／零 PATCH／running 保留的斷言；最後讀事件時尚未發佈新紀錄而失敗。22:21:16 事件入庫後比對合成 PID marker 時間與完整時窗一致，保存 Sleep-reconciled.json。不是完整自動 Sleep.json，也不是實際睡滿 60 分鐘 |
| 遠端 pipe | 未驗證 | sandbox 對本機主機名 TCP 445 不通；不能把 transport failure 當成 Broker remote ACL 已通過，不為測試開放防火牆 |

真正 CLI 的失敗被保留，未改用 danger-full-access、unelevated 或移除 approval/sandbox 保護，也未修改使用者 Codex config／Windows 管理原則。CLI help 與 [官方 Windows sandbox 文件](https://developers.openai.com/codex/windows) 顯示 Windows sandbox 實作另有設定；目前沒有證據證明是設定缺漏或管理政策所致，因此不猜測後放寬。下一階段應先由可信管理者確認可用的受限 Windows sandbox，再補這一項，不重做已過分類。

排程啟動器亦修正 Windows PowerShell 將預期 stderr 當例外的問題：stdout／stderr 分開保存，以原生 exit code 判斷。CLI 路徑在 PATH 找不到時改從 Codex Desktop 安裝目錄解析並傳給 executor。已取得的證據放 git-ignored test-results/windows-events；未提交原始 CLI 日誌、機器 SID 或批次內容。

睡眠探針暴露了兩個測試時序問題：第一次約 188 秒睡眠超過 180 秒觀察 watchdog；第二次程序斷言已通過，但 Power-Troubleshooter 延遲至程序退出後才入庫。已加入長暫停後 10 秒觀察寬限、保留程序斷言 receipt、最多 60 秒等待與本輪開始時間相符的新事件；Runner 的 45 分鐘正式截止與 60 秒編譯期 sleep fixture 截止沒有放寬。時間跳躍回歸證明舊觀察行為會失敗、新行為通過。第二次實際結果由使用者堆疊、PID marker、Runner UTC 日誌與 Windows Event 交叉核對，不將修正後尚未重跑的完整腳本冒充 AUTOMATED。

本階段完整 npm run verify／CI 的最終結果記於 PR，不能沿用下方 9f9f368 的舊戳記。**尚未完成真實操作驗證／已知存在阻斷性問題** 如上；本機事件架構到此收斂，後續資源與端到端矩陣見 ISOLATED-E2E-READINESS.md。未建立新雲端資源或 Google 授權。

---

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
