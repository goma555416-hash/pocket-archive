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

> **安全說明**：這把憑證放在 claude.ai 的「Network secrets」，由 Anthropic 的代理伺服器在請求送出後才加上，Claude 在工作環境裡看不到它，所以就算網頁內容想誘導 AI 外洩，也拿不到。即使如此，憑證仍預設 90 天到期；到期前在 App 建立新的、在 claude.ai 換掉舊的，並撤銷舊憑證。若懷疑外洩，立刻撤銷。

## 3. 在 claude.ai 建立雲端環境與排程任務

1. 打開 `claude.ai/code/routines`，建立新的排程任務（scheduled task）。
2. 儲存庫選 `goma555416-hash/pocket-archive`。
3. 雲端環境照下面的「3a」設定（網路與憑證）。
4. 任務提示（prompt）填：`依儲存庫根目錄 CLAUDE-ROUTINE.md 處理觸發內容中的 export_id 與 attempt。`
5. 不要加排程時間；新增 **API 觸發**，複製顯示的 `/fire` 網址與 token（token 只顯示一次）。

### 3a. 設定雲端環境：網路與憑證（照著點）

已經建立過排程任務的話，直接從這裡開始。

1. 打開 `claude.ai/code/routines`，點你的 Pocket Archive 排程任務。
2. 按任務名稱旁邊的選單（⋯），選 **Edit**。
3. 往下展開 **Advanced settings** → **General** → **Cloud environment**，點顯示環境名稱的雲朵圖示（例如 **Default**）。
4. 滑鼠移到那個環境上，點右邊出現的設定圖示（齒輪），會打開 **Edit cloud environment**。
5. **Network access** 選 **Full**（Claude 要讀公開文章）。
6. 點 **Network secrets** 那一列 → **Add secret**：
   - **Secret type**：保持 **Bearer**。
   - **Host**（或 Hosts）：`pocket-archive.goma555416.workers.dev`（只填網域，不要加 `https://`）。
   - 值（Token）：貼上第 2 步在 App 複製的憑證（`pa_agent_` 開頭那一長串）。
   - 按 **Add**。存好後看不到值是正常的。
   - 如果你看到的是比較短的表單（Team／Enterprise 方案、非管理員）：**Host** 一樣填上面的網域，**Secret type** 選 **Token**，把憑證貼到 **Token** 欄位，按 **Add secret**。
7. 按 **Save changes** 存檔（網路設定需要這一步）。

不需要設定任何環境變數：後端網址已經寫在程式裡。

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

- 代理憑證外洩：在 App 撤銷，再建立新的；到 claude.ai 環境的 **Network secrets** 刪掉舊的、照 3a 新增新的。
- 觸發 token 外洩：在 claude.ai 任務設定重新產生，再執行 `npx wrangler secret put AI_ROUTINE_FIRE_TOKEN`。
- 想暫停雲端整理：刪除 Worker 的 `AI_ROUTINE_FIRE_TOKEN`（`npx wrangler secret delete AI_ROUTINE_FIRE_TOKEN`）。App 會顯示「雲端整理尚未設定」，備用手動流程照常可用。

## 用量

每次送出會觸發一次 Claude 雲端任務，使用你的 Claude 訂閱額度（API 觸發每小時最多 100 次）。同一時間只跑一批，其餘排隊；超過 60 分鐘未回報會標為失敗，可按「重試」。
