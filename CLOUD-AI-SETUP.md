# 雲端 AI 整理：一次性設定（v2.5.0）

完成後，任一端按「AI 整理」→「送出整理」，Claude 就會在雲端自動整理，結果寫回 Drive，兩端都能預覽、勾選、套用。這些步驟涉及你的帳號與密鑰，請自己操作。

需要：Claude Pro／Max／Team／Enterprise 方案、已部署的 Pocket Archive Worker（`https://pocket-archive.goma555416.workers.dev`）、已在 App 登入 Google Drive。

## 1. 更新後端（Cloudflare）

在專案資料夾執行：

```bash
npx wrangler d1 migrations apply pocket-archive --remote
```

```bash
npx wrangler deploy
```

第一個指令建立 AI 工作與代理憑證的資料表；第二個部署新版 Worker 與 App。

## 2. 在 App 建立 Claude 代理憑證

打開 App →「Drive 同步」→「雲端 AI 整理」→「建立 Claude 代理憑證」。憑證只顯示一次（關閉視窗就會清除），先複製起來，下一步要貼到 Claude。

> **風險提醒**：Claude 雲端任務會讀取公開網頁，網頁內容可能夾帶誘導 AI 外洩資料的文字。若這把憑證外洩，持有者可以在有批次「整理中」時讀取該批內容（不能讀其他收藏或 Google 授權）。因此憑證預設 90 天到期；到期前在 App 建立新的、更新 Claude 環境，並撤銷舊的。若懷疑外洩，立刻撤銷。

## 3. 在 claude.ai 建立雲端環境與排程任務

1. 打開 `claude.ai/code/routines`，建立新的排程任務（scheduled task）。
2. 儲存庫選 `goma555416-hash/pocket-archive`。
3. 雲端環境：
   - 網路存取設為 **Full**（讀取公開文章需要）。
   - network secrets 新增：
     - `PA_AGENT_TOKEN` = 第 2 步複製的憑證
     - `PA_BACKEND_ORIGIN` = `https://pocket-archive.goma555416.workers.dev`
4. 任務提示（prompt）填：`依儲存庫根目錄 CLAUDE-ROUTINE.md 處理觸發內容中的 export_id 與 attempt。`
5. 不要加排程時間；新增 **API 觸發**，複製顯示的 `/fire` 網址與 token（token 只顯示一次）。

## 4. 把觸發金鑰放進 Worker

```bash
npx wrangler secret put AI_ROUTINE_FIRE_URL
```

貼上第 3 步的 `/fire` 完整網址。

```bash
npx wrangler secret put AI_ROUTINE_FIRE_TOKEN
```

貼上第 3 步的 token。這把金鑰只存在 Cloudflare，App 和瀏覽器都拿不到。

## 5. 確認

App →「Drive 同步」→「雲端 AI 整理」應顯示「後端已設定 Claude 雲端任務觸發」。選一兩筆收藏按「送出整理」，狀態會變成「整理中…」，完成後「AI 整理」按鈕出現圓點。

## 撤銷與停用

- 代理憑證外洩：在 App 撤銷，再建立新的並更新 Claude 環境的 `PA_AGENT_TOKEN`。
- 觸發 token 外洩：在 claude.ai 任務設定重新產生，再執行 `npx wrangler secret put AI_ROUTINE_FIRE_TOKEN`。
- 想暫停雲端整理：刪除 Worker 的 `AI_ROUTINE_FIRE_TOKEN`（`npx wrangler secret delete AI_ROUTINE_FIRE_TOKEN`）。App 會顯示「雲端整理尚未設定」，備用手動流程照常可用。

## 用量

每次送出會觸發一次 Claude 雲端任務，使用你的 Claude 訂閱額度（API 觸發每小時最多 100 次）。同一時間只跑一批，其餘排隊；超過 60 分鐘未回報會標為失敗，可按「重試」。
