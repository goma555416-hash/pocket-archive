# Windows 接手安全驗收｜2026-11-20

對象：`codex/windows-agent-poll`、同一 Draft PR #34。**憑證隔離未通過，正式切換仍有阻斷性問題。** 沒有生產 Token、部署、模式切換、私人收藏或 Claude Routine 變更。

## 實際身分與能力

已執行 `whoami /user`、`whoami /groups`、`whoami /priv`，並以桌面身分查閱本機帳號名稱、SID、Enabled；沒有讀憑證庫、環境秘密或其他程序的 command line。完整 SID 只留本機忽略的測試紀錄，公開文件記同一 machine SID 的末碼：

| 執行路徑 | 實際結果 |
| --- | --- |
| 一般 Codex sandbox | `CodexSandboxOffline`，SID …-1005，`CodexSandboxUsers` …-1004，Medium integrity，無 Administrators／SeDebugPrivilege |
| 經授權 `require_escalated` | 桌面使用者，SID …-1001，Medium integrity；Administrators 是 deny-only，IsAdmin=false，沒有 SeDebugPrivilege |
| 其他帳號 | Online sandbox …-1006 存在；未用它執行探測。沒有已配置的 Pocket Archive service identity |

「沙盒外」不是 Windows UAC Administrator，卻已可取得桌面 SID。批准審查是政策層防線，不能描述成 agent 在作業系統層永遠無法取得該身分。本輪沒有繞過批准、啟用 Administrator、建立帳號／服務、修改 UAC 或索取生產憑證。

## 假憑證邊界實測

可重跑探針：`tests/windows-agent-boundary.ps1`（PowerShell 7，手動 Windows 測試，不納入跨平台 verify）。它是**假資料探針，不能當 runner 安裝或持有真 Token**。host 無後端存取，不提供 claim／submit，也不讀真憑證。試驗只針對本輪啟動的 helper PID 與隨機 TEMP 子目錄。

- 假憑證與 runner surrogate 檔：關閉繼承，directory DACL 只有桌面 SID 與 SYSTEM 的 FullControl。read 實際開檔讀一 byte；write 僅測 ReadWrite handle，不改內容。
- 預設程序 DACL 先測，再以 `SetKernelObjectSecurity` 設桌面 SID／SYSTEM 專用 DACL 重測。只對 helper 指定的假 credential memory address 使用 `ReadProcessMemory`，比對 SHA，不掃描其他記憶體。
- named pipe 明確 DACL：NETWORK deny；桌面 SID FullControl；sandbox SID 僅 `0x100003`（data read/write/synchronize，沒有 create-instance）。只接受完全相符的 `{"op":"status"}`，URL／shell 請求拒絕。沒有為了連線成功放寬 ACL。
- host 隱藏啟動，6 次 probe 後關閉並刪除自己的假資料目錄。首次 IPC 遇到 disconnect/drain race；補上 drain 後重跑成功。兩輪最終皆確認 process exited、fake directory removed。

| 實測項目 | sandbox，預設程序 ACL | sandbox，明確程序 ACL | 授權桌面 SID，明確程序 ACL |
| --- | --- | --- | --- |
| 假憑證檔 read／ReadWrite handle | 拒絕／拒絕 | 拒絕／拒絕 | **允許／允許** |
| 受限 runner surrogate read／ReadWrite handle | 拒絕／拒絕 | 拒絕／拒絕 | **允許／允許** |
| PROCESS_VM_READ | **允許** | 拒絕 | **允許** |
| 假憑證 memory read，SHA 確認 | **成功讀出** | 無法讀出 | **成功讀出** |
| VM_WRITE／VM_OPERATION／DUP_HANDLE | 均拒絕 | 均拒絕 | **均允許** |
| QUERY_LIMITED_INFORMATION | 允許 | 拒絕 | 允許 |
| 最小權限 IPC | Access Denied (5) | Access Denied (5) | status 成功；fetch／shell 拒絕 |

**檔案 ACL 正確，不代表程序中的 Token 不可見。** 明確程序 DACL 修補了此 helper 的一般沙盒記憶體暴露，但無法限制相同桌面 SID。IPC 的 sandbox usability、第三身份／遠端拒絕、server impersonation／搶名、來源子程序環境隔離均未完整驗證；NETWORK deny ACE 不是遠端攻擊測試的替代品。不以某一項拒絕結果推論整個 broker 安全。

本機原始結果（git-ignored）：`test-results/windows-boundary-{sandbox,owner}.json`、`windows-boundary-hardened-{sandbox,owner}.json`；state 檔包含實際 SID／ACL，不含 credential 本文。不提交 GitHub。

重跑：桌面使用者以 hidden `Start-Process pwsh` 執行 `-File tests/windows-agent-boundary.ps1 -Mode host -StatePath <ignored-state.json> -SandboxSid <實測SID>`，另一次加 `-HardenProcess`；待 state 出現，在 sandbox 與授權桌面各執行 `-Mode probe -StatePath <同檔>`。若 sandbox 無法連線，以桌面 probe 再執行一次補足 6 次請求讓 host 清理。輸出 true 表示存取成功，不表示隔離通過。不可帶入生產 credential。

依據：[Microsoft process access rights](https://learn.microsoft.com/en-us/windows/win32/procthread/process-security-and-access-rights)、[named-pipe DACL 與 generic-write/create-instance](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights)。上表是本機執行結果，不由文件推定。

## 可行性與批准條件

目前權限下**不能交付已驗證的可信 broker**。這不代表 Windows 永遠不可行：需可信管理者建立獨立非互動服務身分、保護 credential／程式／設定／程序 DACL、禁止 agent 及其批准路徑切到該 SID，並完成可用的最小 IPC。repo 內可由 agent 修改的程式不能直接作為可信服務 executable。還須驗證固定 origin／binding／大小限制、redirect 拒絕、revocation、啟動／更新供應鏈及來源子程序不繼承秘密。本輪未自行建立服務或啟用排程。

| 方案 | 風險與條件 | 需要批准 |
| --- | --- | --- |
| 繼續 Claude Routine（目前保留） | 保留既有 Network Secret／模式；新 Worker 的真 Routine UAT 仍待驗 | 保持現狀不需新批准；任何部署另行批准 |
| 可撤銷 1 日試行 credential | 既有 API 最短 1 日、owner 級 ai:agent，非單工作；agent 可能讀取／外傳。只用隔離帳號／後端與公開合成資料，沒有私人佇列，試後立即撤銷；不解決隔離 | 明確接受暴露風險，指定隔離帳號／範圍、期限、撤銷負責人後才能建立。本輪未建立或使用 |

現況保持 Routine。試行或配置服務身分須先審查以上具體風險，不把等待批准當作已有批准，不沿用現成生產 Token。

## 流程實測與未完成項目

2026-11-20 以公開 [IANA Example Domains](https://www.iana.org/help/example-domains) 及專案公開 `icons/icon-192.png` 建兩筆合成收藏：

1. poll claim、CLI ZIP 下載／SHA、collector 正文讀取；Codex 閱讀公開正文及 `view_image` 原圖像素後給出本次分類。
2. 補上 `attached_image` evidence（collector 正確回報不能自行看像素）；`validate-organized --require-evidence` 通過兩筆。Worker 驗證、**模擬 Drive** 原 file ID 一次 PATCH、讀回 SHA 一致、ready。
3. 撤銷 fake agent credential，後續 claim 回 401。
4. 獨立 Windows Chromium profile，禁止瀏覽器外部 HTTPS；預覽兩筆、取消不變、只套用一筆、未選圖片不變、原 URL／note 保留、Undo 復原 type／tags／status／attachment。全部斷言通過，沒有關閉 Chromium sandbox。

這是 **Codex 本機公開證據判斷 + 隔離模擬後端 + 真 Windows 瀏覽器**，不是固定規則分類，也不是透過安全 broker 的真 Google Drive 寫回。本機忽略的 `test-results/public-smoke.mjs` 驅動本次 smoke；收藏／evidence／結果只在 `private-data/`，成功後清理。

**已通過完整自動驗收**：`npm run verify` = `AUTOMATED`，228 項單元／整合、2 條 routine/poll 核心流程、static assets、Windows 瀏覽器 E2E，0 skip。核心流程用 deterministic classifier 與真 CLI／HTTPS proxy／CA，不代表 Claude 或 Codex 分類品質。timeout／expired／revoked／並發鎖／異常恢復由整合測試驗證；人工 Windows 邊界失敗不會被這個 gate 自動偵測。

**尚未完成真實操作驗證**：真 Google Drive 隔離帳號與遠端 Worker/D1 同 file ID 寫回、真程序崩潰跨服務恢復、獨立服務身分 broker、真 Claude Routine、iPhone Safari／主畫面 PWA、正式 Worker 部署與兩端同步。未取得可安全使用的隔離服務／憑證，不用生產帳號補測。
