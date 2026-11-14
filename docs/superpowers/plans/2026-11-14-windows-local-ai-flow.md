# Windows 本機 AI 整理流程 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓 Claude Code 在 Windows 用本機檔案流程完成 AI 整理，並修正本機匯入套用後雲端 AI 工作仍顯示待處理的問題。

**Architecture:** 新增一個純函式 `markCloudJobApplied`（`ai-launch.mjs`，與 `cloudAiJobForReview` 同處），由 `app.js` 的 `applyOrganized` 呼叫，取代目前只處理 `ready` 狀態的內嵌邏輯。其餘為文件更新。

**Tech Stack:** Vanilla ES modules、`node:test`、既有 CDP E2E。

**Spec:** `docs/superpowers/specs/2026-11-14-windows-local-ai-flow-design.md`

## Global Constraints

- 不改 schema v2、export_id 檢查（`lib.mjs` `readOrganized`）、Drive 驗證或匯入驗證；不放寬任何檢查。
- AI 結果必須經人工勾選才套用；不新增自動套用。
- 不提交私人批次、`organized*.json` 或證據紀錄；Claude 的輸出位置固定為 `private-data/organized-<export_id>.json`。
- 繁體中文文件；`CODEX-*.md` 檔名不變。
- 完成前跑 `npm run test:all`。

## Review Focus

- 其他 export_id 的工作不可被改動 → Task 1 測試 `leaves other jobs untouched`。
- 已是 `applied` 的工作再次套用時不應報告有變更（避免多餘的 `setMeta`）→ Task 1 測試 `already applied is unchanged`。
- `sourceExportId` 為空字串或 undefined 時不可改動任何工作 → Task 1 測試 `empty export id changes nothing`。
- 本機匯入的批次根本不在雲端工作清單（純離線流程）時應無事發生 → 同上「leaves other jobs untouched」涵蓋（清單無匹配）。
- 原陣列不可被就地修改，回傳新陣列 → Task 1 測試斷言原陣列物件狀態不變。

---

### Task 1: 本機匯入套用後結束對應的雲端 AI 工作

**Files:**
- Modify: `ai-launch.mjs`（在 `cloudAiJobForReview` 後新增匯出）
- Modify: `app.js:533-534`（`applyOrganized` 內 `readyJob` 兩行）
- Test: `tests/cloud.test.mjs`（新增 test，放在現有 `cloudAiJobForReview` 測試附近，約 241 行）

**Interfaces:**
- Produces: `export function markCloudJobApplied(jobs: Array<{exportId: string, status: string}>, exportId: string): { jobs: Array, changed: boolean }` — 回傳新陣列；`exportId` 相符且 `status !== 'applied'` 的工作複製並設為 `status: 'applied'`，其他工作保持原物件；`changed` 表示是否有任何工作被改。`exportId` 為假值時回傳 `{ jobs, changed: false }`（同一陣列可接受）。

- [ ] **Step 1: Write the failing test**

```js
test('markCloudJobApplied closes pending or ready job for the imported export only', async () => {
  const { markCloudJobApplied } = await import('../ai-launch.mjs');
  const jobs = [
    { exportId: 'export-a', status: 'pending' },
    { exportId: 'export-b', status: 'ready' },
    { exportId: 'export-c', status: 'applied' }
  ];
  // pending -> applied, others untouched
  let out = markCloudJobApplied(jobs, 'export-a');
  assert.equal(out.changed, true);
  assert.deepEqual(out.jobs.map(j => j.status), ['applied', 'ready', 'applied']);
  assert.equal(out.jobs[1], jobs[1]);
  assert.equal(jobs[0].status, 'pending'); // input not mutated
  // ready -> applied
  out = markCloudJobApplied(jobs, 'export-b');
  assert.deepEqual(out.jobs.map(j => j.status), ['pending', 'applied', 'applied']);
  // already applied is unchanged
  assert.equal(markCloudJobApplied(jobs, 'export-c').changed, false);
  // leaves other jobs untouched (no match, e.g. pure offline export)
  out = markCloudJobApplied(jobs, 'export-zzz');
  assert.equal(out.changed, false);
  assert.deepEqual(out.jobs.map(j => j.status), ['pending', 'ready', 'applied']);
  // empty export id changes nothing
  assert.equal(markCloudJobApplied(jobs, '').changed, false);
  assert.equal(markCloudJobApplied(jobs, undefined).changed, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/cloud.test.mjs`
Expected: FAIL，`markCloudJobApplied is not a function`

- [ ] **Step 3: Implement `markCloudJobApplied` in `ai-launch.mjs`**

- [ ] **Step 4: 改用新函式於 `app.js` `applyOrganized`**

把 `const readyJob = ...; if (readyJob) {...}` 兩行換成：以 `state.pendingSuggestions.sourceExportId` 呼叫 `markCloudJobApplied(state.cloudJobs, ...)`；`changed` 為真時才 `state.cloudJobs = out.jobs` 並 `await state.repository.setMeta('cloud-ai-jobs', state.cloudJobs)`。同時把 `markCloudJobApplied` 加入第 4 行既有的 `./ai-launch.mjs` import。

- [ ] **Step 5: Run tests to verify pass**

Run: `npm test` 然後 `npm run test:e2e`
Expected: 全部 pass；E2E 仍印出「E2E：Codex 預覽、套用與復原通過」。

- [ ] **Step 6: Commit**

```bash
git add ai-launch.mjs app.js tests/cloud.test.mjs
git commit -m "fix(ai): close cloud AI job when its batch is applied via local import"
```

---

### Task 2: 文件：Windows 本機流程為 Claude 標準做法

**Files:**
- Modify: `CLAUDE.md`（AI 整理那一條）
- Modify: `CODEX-DRIVE-WORKFLOW.md`（「Claude Code 執行時」段落末尾）
- Modify: `README.md`（「Codex 批次整理」第 3 點下的 Claude Code 子項）

- [ ] **Step 1: 更新三份文件**

內容依 spec「流程」五步驟：iPhone 收藏自動同步 → Windows App「下載待整理批次」→ 請 Claude 整理（輸出 `private-data/organized-<export_id>.json`，以 `--require-evidence` 驗證）→ Windows App「匯入結果」預覽、勾選、套用 → 自動同步到 iPhone。`CLAUDE.md` 寫明這是 Claude 的標準做法、Drive 自動交換為選用且目前會 fail closed；`CODEX-DRIVE-WORKFLOW.md` 補一句指向本機流程為建議做法；`README.md` 用一般使用者看得懂的步驟。不重複貼上整段規則，連到既有文件。

- [ ] **Step 2: Verify**

Run: `npm test` 與 `npm run test:assets`
Expected: pass；assets 仍顯示 private sentinels excluded（`.md` 不進入公開資產）。

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md CODEX-DRIVE-WORKFLOW.md README.md
git commit -m "docs: make Windows local file flow the Claude Code AI organize path"
```

---

### Final

- [ ] `npm run test:all` 全過，推送分支 `feat/windows-local-ai-flow` 並開 PR（使用者同意後）。
