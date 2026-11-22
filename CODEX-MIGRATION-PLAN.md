# Windows Codex 回遷：v2.6.0 工程與切換紀錄

後續自動 Runner／獨立服務 Broker 實作、隔離驗收與管理員操作見 [Windows Runner](WINDOWS-RUNNER.md)。既有寫回與隔離門檻繼續適用。

日期：2026-11-19；安全修正與 Windows 實測追加於 2026-11-20（Asia/Taipei）。這是可審查的工程候選版，**不是遷移完成或生產切換成功**。本輪未部署 Worker、未變更生產 vars、未停用 Claude Routine、未建立／撤銷生產憑證，沒有讀取私人收藏。

## 已核對的起點

| 項目 | 實際觀察 |
| --- | --- |
| 權威工作區 | `pocket-archive-main`；開始時乾淨，`fix/hide-pending-after-ai` / `14d49b4` |
| 分支基準 | fetch 後 `origin/main` = `585b157baae3f492438bc461cbf6b8168818ceac`；本次 `codex/windows-agent-poll` |
| 其他 clone | `pocket-archive-v23-deploy` = `41e4fcb`；`pocket-archive-v233-test` = `d0848fb` 且有 staged 修改，皆未改動；未讀私人資料資料夾 |
| 正式 Worker | 唯讀 `wrangler deployments list --json`：100% 版本 `76cbb21b-8fc3-49cc-b708-612f0317864a`，2026-11-15 14:26:44 +08:00；不能由 deployment ID 推定 Git commit |
| 公開 App | 讀取公開 `/sw.js`：`pocket-archive-v2.5.1-web-research`；本機 main 是 v2.5.3，有已知快取／部署落差 |
| 正式 D1 | 唯讀 `wrangler d1 migrations list pocket-archive --remote`：No migrations to apply；未查 ai_jobs、收藏或 credential 表內容 |
| 已授權範圍 | 一份集中 PR；本機合成資料、隔離 Worker/D1/Drive、公開部署 metadata 查核；不修改其他專案 |

沙盒第一次部署查詢因網路／登入刷新失敗；在獲准的唯讀本機命令下已取得上述紀錄。沒有手動讀取或輸出 Token／Secret。公開 `/sw.js` 不等於 iPhone 目前執行中的快取版本，也不能證明分類正確。

## 實作與相容性

- `AI_DISPATCH_MODE` 未設／空字串／`routine`：原 `/fire` 路徑；`poll`：create/retry/完成後的佇列推進／cron 均不觸發 Routine，也不先變 running。未知值禁止新工作與領單，避免 typo 意外觸發另一個執行端。
- `POST /api/ai/agent/claim` 沿用 scoped agent credential、撤銷／到期／限流及 query credential 禁令。單一 D1 `UPDATE … RETURNING` 同時選最早 `(created_at, export_id)` queued、限定 credential 的 user、排除同 user 的 running、增加 attempt。沒有 running 且沒有 queued 回 204；已有 running 回 409，不回傳該 binding、不續領。
- scope 仍是 **owner 層級 ai:agent**，不是單工作 credential。知道 binding 的另一把同 owner 憑證仍有既有讀寫權限；claim 防雙重派送不等於 credential 間的安全隔離。可信 runner 必須把 Codex 限於它這次領到的 binding。
- `routine-agent claim` 輸出最小 binding／null，保留 job/inbox/submit/fail 與 proxy transport；原 Routine 文件與 secrets 保留。
- 沒有 D1 schema、OAuth、Drive 資料結構、item ID 或 organized schema 變更。App 只改執行端中立文案並升 v2.6.0 快取；不改預覽／套用／Undo 行為。原 credential UI 仍專門指引 Claude Network Secret，不能用它推論已支援安全本機 Token 保存。
- 寫回新增 D1 原子鎖，修復同 attempt 並發雙寫。原 file ID／metadata version／md5／內容讀回 SHA-256 驗證保留。60 分鐘截止也在 agent API 強制執行，無需等下一次 cron。
- Drive 與 D1 不是跨服務交易。PATCH 發出後任何未確認結果（包含 200 後讀回失敗、SHA mismatch、metadata 缺漏）一律 `writeback_uncertain`，禁止 retry／重新 claim／第二次 PATCH；舊 `writeback_failed`／`writeback_mismatch` 也禁止 retry。程序中止留下 `writeback_in_progress` 不自動釋放。這是安全停止，不宣稱 exactly-once 外部寫入。
- PATCH 前已持久保存 recovery receipt：預期結果 `sha256Base64Url`、`beforeVersion`、`beforeMd5`，沿用 `failure_message`。完整 receipt 放不下時在 PATCH 前拒絕，不能截斷證據。原 file ID／attempt／inbox SHA／pending SHA 不變；收到完整 PATCH metadata 才保存寫後 version/md5。成功 SHA 讀回後才清除 receipt。確定 PATCH 前的暫時 metadata 失敗可釋放鎖、同 attempt 再交回；任何 PATCH 後例外皆不能因此獲得重送權。
- 外部操作者仍可能在 metadata 檢查與 PATCH 之間直接編輯同一 Drive 檔；未引入或宣稱 Drive compare-and-swap。切換／驗收時不得手動改動 AI-Results 占位檔。

單一 D1 查詢的序列執行依據：[Cloudflare D1 FAQ](https://developers.cloudflare.com/d1/reference/faq/)。本輪主要 Worker API 測試是既有 SQLite D1 adapter，並非生產 D1 併發壓力測試。

## 憑證隔離：正式啟用的阻斷門檻

領單策略更新：Windows 正式採用登入／解鎖／睡眠恢復事件，一次排空 queued 後退出；Worker 的 opt-in `poll` 名稱與 API 不變，不代表每 30 秒輪詢。事件、有限重試與睡眠逾時保護見 WINDOWS-RUNNER.md；下一階段所需獨立 Worker／D1／Google 授權與配置見 ISOLATED-E2E-READINESS.md。

2026-11-22 更新：獨立 ProbeOnly 服務已安裝；兩個非管理員身分的檔案／程序拒絕、授權桌面 IPC、服務更新重啟及 Limited 暫時排程已通過。[最新驗收與剩餘門檻](WINDOWS-PROBE-ACCEPTANCE.md) 優先於以下 11-20 的歷史觀察。遠端拒絕、真開機／登入、實際 Codex 排程回收及隔離 HTTPS／Drive 整合仍待驗。未使用生產 credential，未切換 poll。

**Windows broker 隔離未通過實測。** [2026-11-20 SID／ACL／程序／IPC 驗收](WINDOWS-AGENT-ISOLATION.md) 記錄了假憑證測試：一般 sandbox 可從預設 helper 程序讀出假 credential；明確程序 DACL 能擋住，但授權沙盒外的桌面 SID 仍可讀檔／記憶體。沒有啟用排程或把長期 Token 交給 Codex。

建議的可信 runner 必須以不同、不可由 agent 切換的 Windows service identity 執行；credential store、程序記憶體、設定與 runner 程式目錄對 agent 不可讀／寫，agent 也不能取得該身份或 elevation。IPC 使用明確 DACL 且只限本機，禁止依賴預設 named-pipe ACL。Microsoft 說明 named-pipe 存取由 security descriptor/DACL 控制；**同 SID 的兩個程序通常不能僅靠檔案或 pipe ACL 區分信任**，這是我們據此作出的安全判斷。[Microsoft Named Pipe Security](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights)

runner 固定功能應僅有 claim、read job/inbox、submit、fail；固定後端 origin 與方法／路徑，拒絕 redirect、任意 URL、任意 headers、arbitrary fetch、shell、外部檔案路徑。成功 claim 後只暴露該 exportId/attempt，submit 限 2 MiB 且先驗證，本地來源讀取程序不繼承 credential。將 credential 從命令列、環境 dump、exception、proxy/curl debug 日誌、剪貼簿及子程序環境隔離。

在一次性假 credential 下，至少必須證明：agent 不能讀 store／broker 設定／程序資訊、不能修改 runner、不能呼叫其他 origin 或其他 binding；公開來源程序沒有 credential；IPC 拒絕其他身份與網路；revoked/expired 回 401。身份／ACL／程序已實測且發現上述阻礙；最小 IPC 在 sandbox 回 Access Denied，沒有放寬 ACL。第三身份、遠端連線、來源子程序及獨立 service identity 仍待驗，**不可據 SID 不同宣稱隔離成立**。

若無法建立此邊界，可另外請使用者接受有限試行方案：建立全新、可撤銷、**1 日到期**的 Codex 專用 ai:agent credential（既有 API 最短 1 日），只排入公開合成測試批次，沒有其他 running/queued 私人批次，完成立即撤銷。殘餘風險仍是 agent 可取得並外傳 owner 層級 credential；它不是短至數分鐘或單工作 Token。**本輪未核准、未實施此備選方案，不沿用／替換 Claude 生產 credential。** 若無法接受，保持 Routine 或另經同意用手動檔案交接。

## 測試證據

2026-11-20 `npm run verify` 已報 `AUTOMATED`：228 項單元／整合、2 條完整 CLI 流程、靜態資源排除及 Windows 瀏覽器 E2E 全通過，沒有跳過項目。初版的 `npm run check`、`wrangler deploy --dry-run`、`npm run test:worker-runtime` 曾通過；本次另外重跑 check／dry-run。PR 推送前以最終內容重跑 gate，並檢查 commit tree 與驗收 stamp 相同。**自動 gate 不測 Windows 作業系統信任邊界，不能覆蓋隔離失敗的結論。**

測試環境：Windows、Node 24.20.0、本機 Chromium 獨立 profile。初次在受限 sandbox 的 Schannel TLS／資產 sentinel 寫入失敗，改在已授權的正常本機權限執行；未關閉 TLS 驗證。一次 Wrangler 測試日誌誤放工作區引發監看重載，停止該測試程序後改放系統 TEMP；另移除了不符合既有 JSON parser 的設定註解。上述失敗都不算通過，最終完整重跑才得到 AUTOMATED。

- **模擬分類**：`tests/cloud-flow.test.mjs` 在 routine/poll 各跑一遍真 CLI、local HTTPS proxy + CA、合成網頁、Worker 驗證、模擬 Drive 原 file ID 寫回、App 匯入與選擇套用。keyword stand-in 不代表 Codex 或 Claude 判斷。新增兩個 CLI 並行 claim／submit 與空佇列驗證。
- **回歸測試失敗證據**：新增並發 submit 測試在修正前回 `[200,200]`（預期 `[200,409]`）；修正後通過。暫時移除 poll 的 startNext guard，core flow 於 queued/running 斷言失敗，再還原。
- **本次寫回安全回歸**：先在舊程式跑新測試，5 項失敗（讀回 exception／HTTP error／mismatch／缺少 metadata／舊 failure code 重試），routine/poll core flow 皆在 retry 200≠409 失敗。修正後 Worker 34 項全過；兩條真 CLI flow 追加 PATCH 後讀回例外／mismatch、重複 retry／resubmit 拒絕且 PATCH 次數不變。單元測試另驗證 durable receipt、原 metadata／attempt／SHA 保留及逾時不能解除隔離。舊 mismatch 自動重試的測試預期已移除。
- **Claude Code 本機判斷**：本輪未執行。
- **真正的 Claude 雲端任務**：本輪未執行；歷史研究提供的成功紀錄不算本版通過。
- **真正的 Windows Codex 領單分類**：本輪未以生產 credential 執行；不把合成 proxy 注入當作 Windows broker 隔離證明。
- **2026-11-20 公開資料 Windows 實測**：實際正文／圖片判斷、fake poll claim／下載 ZIP SHA、結果驗證、模擬 Drive 同 ID PATCH／讀回 SHA、撤銷 credential 後 401；同份結果在獨立 Chromium 預覽／取消／選一筆套用／Undo 全過。詳見隔離驗收紀錄；真 Google Drive、遠端 Worker/D1、iPhone 及服務身分 broker 仍未通過。
- **Codex 本機公開資料判斷（額外 smoke）**：實際以 collector 讀取 [IANA Example Domains](https://www.iana.org/help/example-domains) 的正文；以本專案公開 Icon 建立合成 ZIP，解出原圖、核對 SHA-256 並用 `view_image` 檢視像素。手動產生 2 筆有 evidence 的結果，`validate-organized --require-evidence` 通過，再經隔離 Worker 的 poll claim／CLI inbox／submit、模擬 Drive 同 file ID 寫回讀回、App `readOrganized` 預覽與僅選 1 筆套用，全部斷言通過。這不是生產 Drive、Windows broker、iPhone 或真正 Claude 雲端 UAT。素材與結果只放 git-ignored `private-data/`，測後清理，不提交內容。
- 瀏覽器 E2E 用獨立 Chromium profile，涵蓋證據預覽、勾選套用、Undo、狀態／重試、375/390px、離線與快取更新；不是 iPhone Safari 裝置測試。
- UI 審查依專案 `ui-ux-pro-max` 的 `status feedback clarity` / ux 搜尋（Submit Feedback），及 [Web Interface Guidelines](https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md)：保留 native checkbox/label、按鈕、焦點與 aria-live；不改 CSS／配色。新文案消除未領單就聲稱執行、以及把 Codex 證據誤標 Claude 的問題。

## 正式切換前檢查（本輪不執行）

1. 審查集中 PR 與 CI；保存部署當下的版本 ID、vars 與 Routine 設定，秘密只留在可信管理工具，不放 repo。再次核對正式版本，不能沿用本文的歷史 ID 當最新值。
2. 完成上述 Windows runner／credential 隔離門檻，或取得對有限試行方案的明確同意。使用測試帳號／隔離 Worker + D1 + Drive，不先開生產 poll。
3. 在隔離部署用真正公開文章及授權測試圖片完成一次 Codex 領單、像素檢視、證據、驗證、同 file ID 寫回；不得使用真實私人收藏。確認沒有 runner 在線時保持 queued，兩 runner 不會領同一單。
4. iPhone Safari／主畫面 PWA 與 Windows 重新載入，核對 v2.6.0；兩端看到結果，取消預覽不改收藏，僅勾選項目套用，Undo 復原，原網址／備註／圖片／人工類型不變。記錄實際測試日期與操作者，不預填通過。
5. 明確取得正式部署／切換批准後，先部署此版本且維持 `routine`（沿用 Claude secrets，不改 D1 schema）。確認舊 App 可預覽既有結果；要求使用者 reload 以避免錯誤署名。監看 Routine 的真實 UAT。
6. 切換前停止新增測試／整理工作並排空 running；確認沒有 `writeback_in_progress`／`writeback_uncertain` 或舊 `writeback_failed`／`writeback_mismatch`。再將 vars 的 `AI_DISPATCH_MODE` 設為 `poll` 並部署，啟動已核准 runner。不可同時手動 fire 和 claim 同一工作。
7. 驗收第一個明確授權的批次；結果須由使用者預覽／選取套用。若排程／電腦離線，維持 queued；不得把它顯示為分類失敗或完成。

## 回滾（保留新版 Worker 的安全修復）

正常回滾只改一個設定：**停止本機 runner 的新 claim，將 `AI_DISPATCH_MODE` 改回 `routine`，儲存並部署**。保留 `AI_ROUTINE_FIRE_URL`／`AI_ROUTINE_FIRE_TOKEN` 與 Claude Network Secret／Routine；cron 最遲下一個 15 分鐘排程接續 queued。本輪未實際執行這個操作。

切回模式不重新 fire 已 running 的工作、不重設 attempt；讓既有 runner 完成，或滿 60 分鐘後由 App 明確重試。需要立即處理 queued 時，用受權管理方式觸發既有流程，不直接修改 job 狀態。先完成一個公開測試批次才恢復一般使用。

**不可把「回滾程式碼」當作清除寫入鎖的方法。** 舊 Worker 不認得本版寫入鎖／隔離碼。若要回滾到先前 deployment，必須先停 runner、停止新增工作、確認所有寫入已結束，且沒有任何鎖或隔離工作，再另行批准。正常模式回滾保留本版程式，不需 D1／Drive 還原，不撤銷 Claude 憑證。

異常復原：持續 `writeback_in_progress`／`writeback_uncertain`，或舊 `writeback_failed`／`writeback_mismatch`，都須停止該 runner、禁止重送／直接編輯占位檔／另建批次繞過，保留本次私有結果及 DB row。由授權管理操作核對 Worker 已結束、原 file ID／attempt、receipt 的寫前 version/md5／預期 SHA（base64url；不要與 inbox 的 hex 字串直接比較）、寫後 metadata、讀回 bytes、原 inbox／pending SHA 與 evidence。只有 bytes、metadata、binding、證據完整一致時才能審查是否僅修復 ready 狀態，**不再 PATCH**；不一致／仍無法讀回就維持隔離。舊 row 沒有 receipt 不能猜補，需原本私有結果及歷史證據，缺少即阻斷。單筆狀態修復是另行授權、受審查的管理操作；本 PR 沒有強制解鎖按鈕，逾時與恢復網路不會自動復原。
