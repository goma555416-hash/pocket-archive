# v2.3.2 開發驗證紀錄

2026-10-21；Linux Codex 雲端環境，Node 24.19.0／npm 11.9.0，Chromium headless。全部測試只使用匿名 URL、合成圖片、暫存 IndexedDB、SQLite 記憶體 D1 與模擬 Google 回應；沒有操作正式 D1／Drive、改 OAuth／Secrets 或執行真實 AI 批次。

## 實際結果

| 指令 | 結果 |
| --- | --- |
| `npm test` | 14 個測試檔全部通過，0 失敗；包含 JS 語法檢查。 |
| `node --test --test-isolation=none tests/*.test.mjs` | 121 個個別測試通過，0 失敗、0 略過。補充展開結果，預設隔離 runner 在此環境以檔案總數顯示。 |
| `npm run test:security` | 4 個安全測試檔全部通過。展開同四檔為 17 個測試，0 失敗、0 略過。 |
| `npm run test:assets` | 15 個公開資產正常提供、16 個合成私人哨兵不可公開讀取；另驗證既有 Skill CSV 與 skills-lock.json 為 404。測試自行清理，不覆寫既有碰撞檔。 |
| `npm run test:e2e` | Chromium 完整流程 1 套通過、0 失敗，包含原有回歸及新增 v2.3.2 流程。 |
| `npm run test:all` | 最後依序執行 test、assets、e2e，全部成功。 |
| `node scripts/validate-organized.mjs examples/organized-example.json examples/inbox-example.json` | 既有 schema v2 匿名範例 2 筆通過，保留 v2.3.1 相容 fixture。 |
| `XDG_CONFIG_HOME=/tmp/pa-wrangler-config WRANGLER_SEND_METRICS=false npm exec -- wrangler deploy --dry-run --outdir /tmp/pocket-archive-v232-worker` | Worker 本機 bundle 預檢成功，沒有正式部署。 |
| `python .agents/skills/ui-ux-pro-max/scripts/validate_data.py` | 12 個 domain、22 個 stack 與 ui-reasoning 資料驗證通過。3 個 UX 搜尋 smoke tests 成功。 |
| `git diff --check` | 通過。 |

## 範圍與證據

- `tests/content-model.test.mjs`：新增 45 個純邏輯／相容測試，包括 YouTube 影片／Shorts／頻道、IG Reels／圖片／混合、X／Threads／TikTok／Pinterest、原始媒體 URL、偽裝網域、不可信 metadata、人工優先、八種舊類型、標籤上限／冪等、舊 JSON／ZIP 原圖、網頁形式、跨版本 journal 與 AI 預覽套用復原。
- `tests/capture.test.mjs`：九種合成來源實際經 Worker POST／測試 D1 佇列／租約領取／client commit 介面／ack，檢查 URL、分享文字、缺標題 fallback、穩定 ID 與重送去重。client repository 在該測試中為記憶體替身；真 IndexedDB 原子收件另由既有 Chromium 測試涵蓋。這不是 iPhone 分享測試。
- `tests/db.test.mjs`：確認未變動舊紀錄不被改寫，保留未知歷史欄位；原子交易、附件失敗及容量不足回滾均通過。
- `tests/e2e.mjs`：新增／編輯四類、網站形式、人工確認／重新自動判斷／重新載入、24／25 標籤邊界、整批超限不改資料、批次來源／標籤、XSS、CORS 失敗仍可保存、同頁主要媒體 metadata 與人工優先、長標題、375／390px、名稱與焦點、AI 套用復原、原圖與離線啟動。實際註冊新版 SW 並檢查舊 v2.3.1 快取清除、新分類模組進離線快取。
- 修正 E2E 重新載入使用一般 reload：Chromium 的 ignoreCache force reload 會暫時繞過已啟用 SW，不能用它冒充一般 PWA 離線重開。最終一般 reload + 網路離線驗證通過。
- 初次執行遇到沙箱禁止 loopback listener（EPERM）與預設 npm cache 不可寫；改用工具支援的網路權限及 /tmp cache 後完成全部所需驗證，沒有繞過封鎖目的地、停用 TLS 或修改憑證。
- JS 靜態檢查已由 npm test 執行；此專案沒有 TypeScript，未虛報 TS 型別檢查。

## 未執行與發布界線

iPhone Safari／主畫面 PWA、各 App 實際分享面板、Windows 真機、VoiceOver／Dynamic Type 以及真實 Drive 原 ID 寫回仍待使用者驗收，見 UAT-V2.3.2.md。沒有宣稱各社群 App 的真機收件全部通過。既知圖片刪除再收藏問題不在本次修復範圍。

維持 IndexedDB v2、AI／備份 schema v2、sync v1，不需要額外 D1 migration；不重跑歷史 migration。PR 建立後不合併、不部署；CI 結果以 GitHub 最新提交顯示為準。
