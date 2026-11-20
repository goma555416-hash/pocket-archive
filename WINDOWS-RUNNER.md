# Windows 自動 Runner 與 Broker 候選版

此階段延續 Draft PR #34。安裝尚未執行，獨立服務身分的安全條件仍待驗收。適用隔離 HTTPS 後端；程式拒絕目前正式 Worker hostname。

## 執行架構

- Broker 使用 Windows SCM 與虛擬帳號 NT SERVICE\PocketArchiveBroker，開機可啟動，無服務密碼需保存。讀取 Program Files 下受保護的固定 origin、runner SID 與 scoped credential。
- Runner 使用桌面使用者的登入工作階段及既有 Codex ChatGPT 登入。每 30 秒輪詢，領到工作才啟動 codex exec。選擇登入觸發是因為 Codex 身分與工作環境屬於桌面使用者；**開機但尚未登入時不啟動分類**。
- named pipe 只接受一次領單及該次結果。Broker 自行取得 binding、metadata、inbox，校驗 SHA，再將資料交給 Runner。結果限 2 MiB，Worker 沿用既有驗證及同 file ID 寫回。
- Runner 把驗證過的 inbox 與證據規則透過 stdin 傳給 Codex；圖片先核對附件 SHA，再以固定本機檔名傳給 CLI。Codex 無法閱讀公開來源時須回報 insufficient_data，結果仍須通過既有 evidence validator。
- 斷線、離線、撤銷或啟動失敗後延遲重連。已領工作保留 Worker running，只有既有逾時／人工 retry 可再排隊。Runner 不重送舊結果，不清除隔離狀態。
- mutex 與排程 IgnoreNew 限制本機並行；Broker 單一持續 pipe instance 與 Worker 原子 claim 共同防止雙領。
- 新資料放 private-data/runner-隨機ID。submission-started 與 ready 記錄交回進度。未確認結果保留供核對；成功結果也保留，請使用者確認後依批次清理。
- Stop 是完成目前批次後停止；DisableRunner 中止排程。中斷後應核對該批次，避免把未知寫回結果當未寫入。

## 安全邊界

Broker 使用固定操作與後端，HTTP redirect、proxy 與 cookie 停用。IPC 拒絕網路客戶端，DACL 只授予指定桌面 SID data read/write/read-control/synchronize，沒有 create-instance。Runner 核對 pipe owner 必須是服務 SID，防止接受冒名服務。

Program Files 安裝目錄取消繼承，SYSTEM／Administrators 完整權限，服務 SID 僅 RX，所有者強制 SYSTEM。這避免建立目錄的桌面使用者以 owner 權限改回 ACL。服務程序 DACL 也限制為服務 SID／SYSTEM／Administrators。服務設定與啟停權限限制 SYSTEM／Administrators，服務 privilege 清單僅 SeChangeNotifyPrivilege。

桌面 Runner 與 Codex 共享使用者身分，兩者之間沒有安全隔離承諾。它們能看到批次資料及本次 pipe，但帳號層級 token 僅在獨立服務。具真正 Administrator／SeDebugPrivilege 的程序仍能突破此邊界；Codex 不應獲得這種權限。

已編譯服務與 Runner。fixture build 使用編譯期 FIXTURE 才有 loopback HTTP 與固定假 credential。正式 service build 必須以指定服務 SID 執行。fixture 的同 SID 通訊成功不證明跨身分安全。

尚待服務安裝後測試的條件包括實際服務 SID、Program Files 與 executable ACL、預設及沙盒外桌面身分均無法讀取 token／程序記憶體、IPC owner／遠端拒絕、服務重啟、開機／登入排程、Codex 異常退出子程序清理。未通過前不得置入生產憑證。

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

只有兩個身分的檔案／程序拒絕及 IPC／服務驗收完成後，管理員設定開機啟動。一般桌面設定登入 Runner。

    sc.exe config PocketArchiveBroker start= delayed-auto
    .\scripts\windows\manage.ps1 EnableRunner
    .\scripts\windows\manage.ps1 Start

EnableRunner／Start 在一般桌面執行，使用 Limited interactive task。Codex CLI 必須已在 PATH 並登入。Start 允許自動領取隔離後端已由 App 送出的批次。

    .\scripts\windows\manage.ps1 Stop
    .\scripts\windows\manage.ps1 DisableRunner

解除安裝先於一般桌面 DisableRunner，再由 Administrator 執行以下指令。這會停服務、刪服務註冊及專用 Program Files 目錄（含測試 credential），保留 private-data 恢復證據。另在隔離後端撤銷測試 credential。

    .\scripts\windows\manage.ps1 Uninstall

## 測試命令與狀態

2026-11-20 實際執行了正式版 Broker／Runner 編譯、假分類器的 Windows pipe 整合測試，以及 --codex 真 CLI 自動流程。真 CLI 處理 IANA 公開合成批次後，驗證器接受結果、Worker ready、同 file ID 只 PATCH 一次。第一次的本機檔案讀取拒絕及第二次的 pages evidence 格式錯誤皆在寫回前阻擋；改為 stdin 交接完整批次／規則並提供現有 evidence validator contract 後通過。沒有修改 Worker 的驗證或既有分類要求。

fixture 測試另確認第二個同名 broker 無法啟動、第二個 Runner 退出、離線 503 恢復後自行領單、stop marker 正常退出。完整 verify 在 Windows 增加原生 Runner／Broker gate，既有 core flow 繼續驗證 Worker 並發、逾時、撤銷及寫回隔離。真 CLI 使用同機 fixture broker，獨立服務 SID 的拒絕測試仍未執行。

2026-11-21 重啟測試曾因只等待 exitCode 而逾時。補上 signalCode 結束條件後，原生流程已通過 Broker／Runner 重啟及 ready 工作不重送斷言；此失敗與修正未涉及 Worker 或資料驗證規則。

本機完整驗收已取得 AUTOMATED，229 項單元／整合、2 條核心流程、Windows 原生流程、靜態資源與瀏覽器 E2E 均通過。追加的重啟斷言要求已 ready 的工作在 Broker／Runner 重啟後保持一次寫回，推送前會再次執行最終 gate。強制中止時 Codex 孫程序的完整回收仍需服務／排程環境驗證，無法確認前應人工核對相關程序與 running 工作。

    node --test tests/runner.test.mjs
    node tests/windows-runner.mjs
    node tests/windows-runner.mjs --codex
    npm run verify

Windows verify 額外執行原生 C# Broker／Runner 測試。預設使用 deterministic executor，驗證離線後自動重連、排他程序、受限 pipe、批次 binding、驗證與一次寫回。--codex 才啟動實際 Codex CLI，以 IANA 公開頁面建立合成批次；仍使用 in-memory Worker/Drive。Windows 服務與管理員安裝的驗收不由此測試代替。

真 Google Drive／遠端 Worker、iPhone、Claude Routine 與生產部署仍屬尚未完成真實操作驗證。整體可信服務隔離仍有阻斷性驗收項目。
