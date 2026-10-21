# v2.3.2 UI/UX Skills 安裝與實際審查

2026-10-21。Node 24.19.0／npm 11.9.0。以專案 `.agents/skills/` 複製安裝，沒有全域安裝、失效 symlink 或 PWA 執行期依賴。

## 來源與審查

- UI/UX Pro Max：[官方來源](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill)，審查 commit `56ea9cf174ed86786187daa9de0e6247cb0747e4`；官方 MIT LICENSE 隨 Skill 保留。
- Web Design Guidelines：[官方來源](https://github.com/vercel-labs/agent-skills)，審查 commit `063bee94c3f4df8453406c830b0a7df0f2860278`；官方 README 標示 MIT，SKILL metadata 保留作者 vercel。
- 安裝前 clone 到 /tmp，檢查來源、授權、SKILL 與 Python scripts；安裝後對比官方目錄內容。search／core／design_system／reasoning_contract 僅使用 Python 標準函式庫，本機讀取 CSV；不含網路上傳、套件安裝或 shell 呼叫。design_system 的 persist 是明確參數功能，本次未使用。
- 使用原指定 `npx skills add ... --skill ... -a codex --copy`，加 `--yes`／`-y` 作非互動安裝，npm cache 改在 /tmp 以符合工作區權限。來源與 computed hashes 記於 skills-lock.json。沒有安裝其他 Skills。僅省略上游 scripts/tests（其 catalog-refresh 測試依賴來源儲存庫根目錄未隨 Skill 安裝的工具）；完整執行期腳本、資料與 references 保留；design_system.py 僅清理上游行尾空白。
- `.assetsignore` 排除 `.agents/`、skills-lock.json；Static Assets 預檢也實際檢查 Skill CSV 與 lock 不可公開讀取。Git 排除 pycache、測試輸出及私人素材。

## 實際使用

已讀取兩份 SKILL.md，以及 UI/UX 的 quick-reference、pro-rules。Web Guidelines 依 Skill 指示從 [公開 command.md](https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md) 取得最新規則後審查 index.html、app.js、styles.css、theme.css。

本機實際執行（全部成功，各查詢有 3 個結果；另執行 validate_data.py，驗證 12 個 domain、22 個 stack 及 ui-reasoning 資料通過）：

```bash
python .agents/skills/ui-ux-pro-max/scripts/search.py 'badge chip label wraps' --domain ux
python .agents/skills/ui-ux-pro-max/scripts/search.py 'error summary validation' --domain ux
python .agents/skills/ui-ux-pro-max/scripts/search.py 'touch target minimum mobile' --domain ux
```

採用的介面改善與已修正發現：

- `index.html`：四類選單、網頁內容形式、待確認／人工確認說明；舊 category 退入唯讀相容資訊。標籤用多行輸入，保留完整歷史超限值。搜尋與所有新增控制項有標籤；錯誤 role=alert、可聚焦並與輸入關聯；增加跳至主要內容連結。
- `app.js`：確認／重新自動判斷為明確操作。新增／編輯一致、metadata 不覆寫人工選擇、CORS 失敗仍能收藏。儲存時停用重複提交。移除延遲焦點競爭，行動版開表單先聚焦標題以避免自動彈出鍵盤。
- `styles.css`：卡片標題、來源與標籤可換行；固定長度類型標記維持緊湊，任意歷史長標籤優先完整揭露。375／390px 無橫向溢出，表單字級 16px、主要卡片／類型操作至少 44px；使用既有 safe-area、focus-visible、reduced-motion，modal 限制捲動串聯。
- `theme.css`：來源／備註／日期、標籤及表單輔助文字加深（實算對比依序 6.12:1、5.53:1、5.27:1），維持原色票。新增標記有文字說明，並非只靠顏色。
- AI 預覽顯示現有→新增標籤、資料不足狀態與超限保留項目，只有人工勾選後套用；本機原圖與外部連結使用不同文字。

未採納：另建設計系統／改色票字體／換 Icon、React／Tailwind、GSAP、裝飾陰影動畫、原圖轉碼；都與既有產品範圍或品牌要求不符。沒有將私人搜尋／篩選狀態放入 URL，避免網址記錄收藏資訊。未擴大重寫清單虛擬化或加入暗色模式。

## 驗證界線

Chromium 模擬涵蓋表單／四類篩選／批次標籤／375與390px／可存取名稱／焦點／XSS／metadata／離線快取。這不是 VoiceOver、iOS Safari、真 iPhone 大字體或 Windows 實機驗收，也不宣稱全站取得 WCAG 認證。實機清單見 UAT-V2.3.2.md。

公開 Guidelines 的本次 SHA-256：`d246b026f4f29b5823a9cc857f9edf3d2507002e055e32040cadeaf3b38e0234`。安裝後提交 49 個 Skill 原始檔，0 symlinks；Python cache 不提交。

## Codex 專案路徑修正（PR #14 後續修正）

相較上述上游 commit，本次僅調整 UI/UX Pro Max 的 SKILL.md 操作說明：

- 11 處搜尋、design-system、persist、design dials 與 stack 範例，統一使用儲存庫根目錄相對路徑 `.agents/skills/ui-ux-pro-max/scripts/search.py`，不再依賴 Claude plugin 環境變數。明確要求從儲存庫根目錄執行；其他工作目錄需先切回根目錄或解析腳本絕對路徑。
- persist 範例指定 `--output-dir "."`，對應根目錄執行方式；Python fallback 保留 `python3`／`py -3`，移除對未隨專案安裝之上游 README 的依賴。
- 檢查兩個 Skill 的全部 4 份 Markdown 文件，其他 SKILL／references 沒有同類錯誤，維持原檔。搜尋腳本、資料、功能、來源及 MIT 授權均未變更；未改動 App、版本、部署或私人資料。

### skills-lock.json 完整性核對

已檢查安裝時使用的 `skills` CLI 1.7.4 實作：`projectLockEntry` 的 `skillPath` 是上游來源路徑；`computedHash` 由 `sourceSkillHash` 對原始來源 Skill 目錄計算，並非修改後本機副本的雜湊。因此 lock 中 `.claude/skills/ui-ux-pro-max/SKILL.md` 是有效的上游定位，不能改為本機 `.agents/` 路徑，也不以本機修改後雜湊取代來源雜湊。

依 CLI 的相同規則（遞迴讀檔、相對路徑 `localeCompare` 排序、依序 SHA-256 更新路徑及內容，排除 `.git`／`node_modules`），對上述兩個已審查來源 commit 重新計算，均與 lock 完全一致：

- UI/UX Pro Max：`27b1e8c953e26f962e3314281601959b04787edf3fd7fccadce176ff844c688d`。
- Web Design Guidelines：`a6a44d5498f7e8f68289902f3dedfc6f38ae0cee1e96527c80724cf27f727c2a`。

因此保留 skills-lock.json 原內容。本次修正後本機 `.agents/skills/ui-ux-pro-max/SKILL.md` 的 SHA-256 另記為 `bb9689c8df442749ef73eb87ee494444258850998b9781ac9cb399f55ecbd928`，用來區分本機文件與上游原始內容；上游更新或重新安裝時須檢查是否保留本節記錄的 Codex 路徑修正。

### 本次實際驗證

以下均從儲存庫根目錄執行成功；三種呼叫均直接使用修正後範例路徑：

```bash
python ".agents/skills/ui-ux-pro-max/scripts/search.py" "keyboard focus modal" --domain ux
python ".agents/skills/ui-ux-pro-max/scripts/search.py" "suspense streaming bundle" --stack nextjs
python ".agents/skills/ui-ux-pro-max/scripts/search.py" "AI search tool modern minimal" --design-system -p "AI Search"
python .agents/skills/ui-ux-pro-max/scripts/validate_data.py
npm test
npm run test:assets
git diff --check
```

結果：domain／stack 各 3 筆結果，design-system 正常輸出，未使用 persist 或變更專案設計；資料驗證通過 12 個 domain、22 個 stack 與 ui-reasoning。npm test 共 121 個測試通過、0 失敗、0 略過，JS 語法檢查通過；Static Assets 預檢 15 個公開資產及 16 個私人哨兵通過，另驗證 Skill CSV／lock 為 404。未更動執行期程式，本次未另重跑本機 Chromium E2E；PR 的最新 CI 會重新執行既有 E2E 與其他檢查。
