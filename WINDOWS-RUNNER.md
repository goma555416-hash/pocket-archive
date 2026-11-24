# Windows 自動 Runner 與 Broker 候選版

此階段延續 PR #34。ProbeOnly 服務已由使用者安裝並啟動；最新實測見 [Windows ProbeOnly 驗收紀錄](WINDOWS-PROBE-ACCEPTANCE.md)。預設拒絕正式 hostname；只有管理員在受保護服務目錄寫入固定正式 origin 的啟用檔，才允許正式接入。現行授權與操作見 [正式切換](PRODUCTION-CUTOVER.md)。

## 執行架構

- Broker 使用 Windows SCM 與虛擬帳號 NT SERVICE\PocketArchiveBroker，開機可啟動，無服務密碼需保存。讀取 Program Files 下受保護的固定 origin、runner SID 與 scoped credential。
- Runner 使用桌面使用者的登入工作階段及既有 Codex ChatGPT 登入。正式採用「登入／解鎖／睡眠恢復」事件：每次連續處理 queued 批次，收到明確 HTTP 204 後退出；無工作不啟動 Codex，沒有每 30 秒輪詢。**開機但尚未登入時不啟動分類**。
- named pipe 只接受一次領單及該次結果。Broker 自行取得 binding、metadata、inbox，校驗 SHA，再將資料交給 Runner。結果限 2 MiB，Worker 沿用既有驗證及同 file ID 寫回。
- Runner 把驗證過的 inbox 與證據規則透過 stdin 傳給 Codex；圖片先核對附件 SHA，再以固定本機檔名傳給 CLI。Codex 無法閱讀公開來源時須回報 insufficient_data，結果仍須通過既有 evidence validator。
- 尚未收到 binding 的連線錯誤／離線／忙碌最多嘗試 4 次，間隔 15／30／60 秒，仍失敗以 code 5 退出，等下一次事件或手動 RunOnce；不把 409、401、503 或 EOF 當空佇列。收到 binding 後任何異常以 code 4 停止並保留證據，不自動重送。已領工作沿用 Worker running／逾時及人工 retry 規則。
- mutex 與排程 IgnoreNew 限制本機並行；Broker 單一持續 pipe instance 與 Worker 原子 claim 共同防止雙領。
- 事件啟動另以 mutex 保護的 60 秒時間窗去重，避免上一輪已退出後緊接而來的解鎖／喚醒又啟動。手動 RunOnce 不受去重限制。摘要日誌只記 UTC 時間與固定事件碼於 private-data/runner-events.log，不記 token／收藏內容。
- 新資料放 private-data/runner-隨機ID。submission-started 與 ready 記錄交回進度。未確認結果保留供核對；成功結果也保留，請使用者確認後依批次清理。
- Stop 是完成目前批次後停止；DisableRunner 中止排程。中斷後應核對該批次，避免把未知寫回結果當未寫入。

## 安全邊界

執行中睡眠不等於新 attempt。Runner 用 UTC 截止檢查（含睡眠時間）限制 executor 45 分鐘，且在 child 剛結束時再檢查一次；Broker 讀取結果同樣在 wait 返回後檢查截止。Worker 的 60 分鐘限制仍是最終權威，沒有延長或解除鎖。若成功 PATCH 但 ready 回覆遺失，Runner 保留 submission-started 並退出；下一事件只 claim queued，不讀取舊結果重送。若讀回不確定，維持 writeback_uncertain，即使恢復網路／超過逾時也不重新 PATCH。[Windows wait 可能排除睡眠時間](https://learn.microsoft.com/en-us/windows/win32/api/synchapi/nf-synchapi-waitforsingleobject)

Broker 使用固定操作與後端，HTTP redirect、proxy 與 cookie 停用。IPC 拒絕網路客戶端，DACL 只授予指定桌面 SID data read/write/read-attributes/read-control/synchronize，沒有 create-instance。Runner 核對 pipe owner 必須是服務 SID，防止接受冒名服務。ReadAttributes 是 Windows CreateFile 額外要求的權限；未授予時一般桌面也無法連線。

Program Files 安裝目錄取消繼承，SYSTEM／Administrators 完整權限，服務 SID 僅 RX，所有者強制 SYSTEM。這避免建立目錄的桌面使用者以 owner 權限改回 ACL。服務程序 DACL 也限制為服務 SID／SYSTEM／Administrators。服務設定與啟停權限限制 SYSTEM／Administrators，服務 privilege 清單僅 SeChangeNotifyPrivilege。

桌面 Runner 與 Codex 共享使用者身分，兩者之間沒有安全隔離承諾。它們能看到批次資料及本次 pipe，但帳號層級 token 僅在獨立服務。具真正 Administrator／SeDebugPrivilege 的程序仍能突破此邊界；Codex 不應獲得這種權限。

Codex CLI 雖以桌面使用者啟動，模型的 shell 命令使用 `windows.sandbox="elevated"` 的既有受限執行身分；這個設定名稱不代表給模型管理員權限。因啟動時有 `--ignore-user-config`，必須明確傳入該設定，不能依賴桌面 config.toml。安裝或修復 sandbox 仍須由使用者另行執行，Runner 不自動執行 setup，不退回 unelevated／full-access。

已編譯服務與 Runner。fixture build 使用編譯期 FIXTURE 才有 loopback HTTP 與固定假 credential。正式 service build 必須以指定服務 SID 執行。fixture 的同 SID 通訊成功不證明跨身分安全。

實際服務 SID、Program Files owner／ACL、兩個身分的檔案／程序權限拒絕、桌面 IPC owner／PID、服務更新重啟、Limited 排程執行已通過 ProbeOnly 實測。強制停止／executor 逾時或失敗的子孫程序回收已通過原生 fixture。遠端身分拒絕、真開機／登入觸發及實際 Codex 子程序在排程下的回收仍待驗；不得置入生產憑證。

參考 [Microsoft service accounts](https://learn.microsoft.com/windows/security/identity-protection/access-control/service-accounts) 與 [named-pipe security](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights)。

## 安裝、驗證、解除安裝

先在一般 PowerShell、repo 根目錄執行。Build 不修改系統設定。

    .\scripts\windows\manage.ps1 Build
    whoami /user

檢閱 Broker.cs 與安裝腳本、記錄 build SHA-256。以下由使用者親自於 Administrator PowerShell 執行，填入隔離 HTTPS 後端與上一步的桌面 SID。憑證透過 SecureString 提示輸入，僅可使用隔離帳號的測試 credential。

第一輪只驗證 Windows 邊界時，可先使用下列 ProbeOnly 安裝，不需要準備帳號或 token。它寫入固定假 credential 及保留的 .invalid 網域，可啟動服務供 ACL／記憶體拒絕測試。完成後 Uninstall，再依後面的隔離後端指令安裝，才進行服務整合流程。

    .\scripts\windows\manage.ps1 Install -ProbeOnly -RunnerSid YOUR-DESKTOP-SID
    .\scripts\windows\manage.ps1 Inspect

    .\scripts\windows\manage.ps1 Install -Origin https://YOUR-ISOLATED-BACKEND -RunnerSid YOUR-DESKTOP-SID
    .\scripts\windows\manage.ps1 Inspect

Install 建立服務但保持 disabled。它寫入 Program Files、服務註冊與 ACL；失敗可能留下部分安裝，先 Inspect，勿重複覆寫。確認檔案 owner 為 SYSTEM、權限只包含上述主體，且服務帳號與 executable 路徑正確，再手動啟動供驗證。

    sc.exe config PocketArchiveBroker start= demand
    sc.exe start PocketArchiveBroker
    sc.exe queryex PocketArchiveBroker

把 queryex 的 PID 提供給一般桌面 PowerShell 與 Codex sandbox，兩者各跑一次。不讀取憑證內容。

    .\scripts\windows\verify-isolation.ps1 -BrokerPid PID

一般桌面另執行以下 probe。IPC 只送會被拒絕的 opcode 0，不會領單；排程 probe 使用暫時的 Limited interactive task，執行相同檔案／程序／IPC 探針後自動移除。它不證明真登出登入或開機觸發。

    .\scripts\windows\probe-ipc.ps1 -ExpectedPid PID
    .\scripts\windows\probe-schedule.ps1 -ExpectedPid PID

已安裝本版之前的 ProbeOnly 候選版時，先一般桌面 Build，再由管理員執行以下更新。腳本核對服務身分／路徑／Manual 模式、固定 .invalid origin 與假憑證；短暫停止後備份舊 executable、替換並比對 hash、設 SYSTEM owner、重啟。它不改憑證／origin／SCM DACL。中途失敗可能保持停止，勿跳過檢查重複覆寫。

    .\scripts\windows\manage.ps1 UpdateProbe

更新回滾由管理員停止服務，將受保護的 `C:\Program Files\PocketArchiveBroker\Broker.previous.exe` 複製回同目錄 `Broker.exe`、確認 owner 仍為 SYSTEM，再啟動。舊版有桌面 IPC 權限缺漏，回滾後須保持 ProbeOnly，不得連真後端。解除安裝仍使用下方 Uninstall。

只有兩個身分的檔案／程序拒絕及 IPC／服務驗收完成後，管理員設定開機啟動。一般桌面設定登入 Runner。

    sc.exe config PocketArchiveBroker start= delayed-auto
    .\scripts\windows\manage.ps1 EnableRunner
    .\scripts\windows\manage.ps1 Start

EnableRunner／Start 在一般桌面執行，使用 Limited interactive task。Codex CLI 必須已安裝並登入（可使用 Desktop 內附版本）。Start 允許自動領取隔離後端已由 App 送出的批次。

目前 EnableRunner 設定三個原生觸發：Logon（15 秒延遲）、SessionUnlock（15 秒）、System／Microsoft-Windows-Power-Troubleshooter Event ID 1（30 秒）。不設定週期、RestartOnFailure 或 WakeToRun。此機 powercfg /a 為 S3／休眠，系統已有恢復事件；不只依賴解鎖，因此不要求喚醒後一定出現密碼畫面。Modern Standby 裝置未驗證；若換機且沒有 Event 1，保留登入／解鎖與 RunOnce，不宣稱涵蓋所有喚醒來源。[Task Scheduler schema](https://learn.microsoft.com/en-us/windows/win32/taskschd/task-scheduler-schema)

Windows 工作排程的 PATH 與互動式終端可能不同；啟用排程時解析 Codex 的完整路徑，找不到 PATH 時使用 Codex Desktop 的本機 bin 安裝目錄。路徑經 Runner 傳給 executor，沒有依賴手動開 Codex 終端。若 Desktop 更新移除該 executable，執行會明確失敗，須重新 DisableRunner／EnableRunner 更新路徑，不降級到其他模型或付費 API。

手動「只執行一次佇列排空」備用入口：

    .\scripts\windows\manage.ps1 RunOnce

Stop marker 仍會阻止新領單；若先前已 Stop，先用 Start 恢復，或由使用者明確移除該 marker。長期不鎖定、不睡眠、不重新登入的使用者，新送出的工作會留 queued 到下一事件；這是採用本策略的預期取捨。

    .\scripts\windows\manage.ps1 Stop
    .\scripts\windows\manage.ps1 DisableRunner

解除安裝先於一般桌面 DisableRunner，再由 Administrator 執行以下指令。這會停服務、刪服務註冊及專用 Program Files 目錄（含測試 credential），保留 private-data 恢復證據。另在隔離後端撤銷測試 credential。

    .\scripts\windows\manage.ps1 Uninstall

## 測試命令與狀態

2026-11-20 實際執行了正式版 Broker／Runner 編譯、假分類器的 Windows pipe 整合測試，以及 --codex 真 CLI 自動流程。真 CLI 處理 IANA 公開合成批次後，驗證器接受結果、Worker ready、同 file ID 只 PATCH 一次。第一次的本機檔案讀取拒絕及第二次的 pages evidence 格式錯誤皆在寫回前阻擋；改為 stdin 交接完整批次／規則並提供現有 evidence validator contract 後通過。沒有修改 Worker 的驗證或既有分類要求。

fixture 測試另確認第二個同名 broker 無法啟動、第二個 Runner 退出、離線 503 恢復後自行領單、stop marker 正常退出。完整 verify 在 Windows 增加原生 Runner／Broker gate，既有 core flow 繼續驗證 Worker 並發、逾時、撤銷及寫回隔離。真 CLI 使用同機 fixture broker，獨立服務 SID 的拒絕測試仍未執行。

2026-11-21 重啟測試曾因只等待 exitCode 而逾時。補上 signalCode 結束條件後，原生流程已通過 Broker／Runner 重啟及 ready 工作不重送斷言；此失敗與修正未涉及 Worker 或資料驗證規則。

上一版 commit 41f4bd0 完整驗收為 AUTOMATED。2026-11-22 新增最小權限 IPC 回歸，以及 Runner 強制終止／逾時／executor 失敗的子孫程序回收回歸。Runner 在啟動 executor 前加入不可 breakaway 的 Job Object；停止 Runner 時 OS 關閉唯一 handle 並回收整棵一般子程序樹。executor 逾時／失敗會退出 Runner（code 4），避免留孤兒程序；排程可按既有設定重新啟動，新 claim 不重送 running 工作。這不是對同 SID 惡意程序經其他系統服務建立程序的隔離承諾。[Microsoft Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)

本輪 sandbox 完整 verify 的核心流程受到 Schannel SEC_E_NO_CREDENTIALS、資源測試受到 .agents 寫入 ACL 阻擋，其餘 229 項、原生測試與 E2E 通過。該次結果是 BLOCKED；一般桌面對最終內容的完整 gate 結果另記於 PR，不沿用上一版 AUTOMATED。

    node --test tests/runner.test.mjs
    node tests/windows-runner.mjs
    node tests/windows-runner-lifecycle.mjs
    node tests/windows-runner.mjs --codex
    npm run verify

Windows verify 額外執行原生 C# Broker／Runner 測試。預設使用 deterministic executor，驗證離線後自動重連、排他程序、受限 pipe、批次 binding、驗證與一次寫回。--codex 才啟動實際 Codex CLI，以 IANA 公開頁面建立合成批次；仍使用 in-memory Worker/Drive。Windows 服務與管理員安裝的驗收不由此測試代替。

真 Google Drive／遠端 Worker、iPhone、Claude Routine 與生產部署仍屬尚未完成真實操作驗證。整體可信服務隔離仍有阻斷性驗收項目。

## 事件式驗收與後續階段

新增原生回歸：三個批次依建立順序各寫回一次、空佇列退出、連續事件去重、離線／409 有限重試、提交前跨越 Worker 60 分鐘截止、寫回成功但回覆遺失、PATCH 後讀回失敗與恢復後不得解隔離／重送。模擬時間只在測試 Worker 中前進，沒有修改正式時鐘或 Worker。

`probe-events.ps1 Prepare` 建立暫時的 Limited 解鎖／登入／喚醒探針，以及真 Codex 排程驗收。探針只連空的 loopback 假後端；真 CLI 只處理公開合成批次，之後驗證 CLI 與實際 shell 子程序的中止回收。Collect 讀本機結果，Cleanup 移除四個驗收 task，保留證據。現有 ProbeOnly 服務沒有轉成生產或改憑證。

真正隔離 HTTPS／D1／Google Drive 的資源清單、占位設定及最少核准操作已集中在 [隔離端到端準備](ISOLATED-E2E-READINESS.md)。後續工作聚焦此驗收，不再擴充本機常駐監看架構。
