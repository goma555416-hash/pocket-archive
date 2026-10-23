# Agent instructions — Pocket Archive

- **Top-level task: `MASTER-TASK.md`.** Read it before implementing anything, then `CODEX-BRIEF.md`, `README.md`, `DESIGN-SPEC.md`, `AI-BATCH-SPEC.md`.
- This is an existing functioning PWA. Preserve data/migration compatibility and existing completed work; refactor only for demonstrated need.
- **Execution contract:** deliver all feasible features in one autonomous task, with self-run automated tests and a single final reviewable PR/branch. Do not stop after a plan or first feature; do not require user approval at every development milestone. Follow `MASTER-TASK.md` acceptance tests.
- Devices: **iPhone / iOS Safari + home-screen web app and Windows**. No Android-specific features unless separately requested.
- Brand: **Pocket Archive**, Minimal & Modern, Butter Yellow `#FFF2C9` × Periwinkle `#CBD7EF`, **A3 solid bookmark Icon**. Icon selection is final for now; do not reopen design exploration.
- AI categorization is **manually initiated by the user** and uses Codex without a separate AI API. v2.1 may exchange an explicitly selected batch through the user's authorized Drive `AI-Inbox`/pre-created `AI-Results` slot; it never runs a model in the PWA or uploads before the user initiates the job.
- When the user says **「整理 Pocket Archive 最新的待整理收藏」**, follow `CODEX-DRIVE-WORKFLOW.md`: use only the authorized Pocket Archive Drive folders, validate schema/IDs, and update the App-created result placeholder in place.
- Never commit private exports/images, tokens or credentials. Do not publicly deploy, delete user data, start paid services or access private accounts without authorization. Work around blocked external operations and document the necessary user action at the end.
- Test in browser or automate where possible, explain any untested iOS device-only steps, keep a concise final manual UAT checklist. No claims of successful tests without executing them.

- Content-first classification: read [CODEX-CONTENT-EVIDENCE.md](CODEX-CONTENT-EVIDENCE.md), attempt actual source reading per item and generate a validated evidence receipt before tagging. `metadata_only` must be `insufficient_data`; do not infer video text from oEmbed title. When network capability is absent, fail closed without guessing. Preserve no-extra-AI-API workflow.
- AI startup must follow the App’s batch-specific export_id. Read CODEX-DRIVE-WORKFLOW.md and CODEX-ORGANIZE-PROMPT.md first. Never search Notion or other private workspaces. Missing Drive raw JSON/ZIP download, in-place content update, or read-back capability is a fail-closed blocker; never substitute another source or create a replacement result file.

## v2.3.2 content model and project skills

- Read `CONTENT-MODEL.md` before changing types, tags, import/export or sync. The four presentation types are 圖片／影片／社群／網頁; topics belong in tags. Preserve manual classification and historical fields. Do not run bulk migrations on read. Keep schema v2 and the v2.3.1 AI handoff contract.
- For collection forms, cards, mobile layout and interaction work, read [ui-ux-pro-max](.agents/skills/ui-ux-pro-max/SKILL.md); use its local search script with a focused UX domain query. Keep the existing vanilla JavaScript stack and `DESIGN-SPEC.md` brand decisions.
- For UI implementation review, read [web-design-guidelines](.agents/skills/web-design-guidelines/SKILL.md), fetch its public guideline source, then review the affected HTML/CSS/JS for labels, keyboard/focus, feedback and responsive overflow. Resolve actionable findings within scope; do not force a framework, new palette or unrelated redesign.
- Skills are project copies, not global installations or PWA runtime assets. Sources, license evidence, audit and actual usage: `UI-UX-REVIEW-V2.3.2.md`. Do not upload private content in skill searches.
