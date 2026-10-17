# Agent instructions — Pocket Archive

- **Top-level task: `MASTER-TASK.md`.** Read it before implementing anything, then `CODEX-BRIEF.md`, `README.md`, `DESIGN-SPEC.md`, `AI-BATCH-SPEC.md`.
- This is an existing functioning PWA. Preserve data/migration compatibility and existing completed work; refactor only for demonstrated need.
- **Execution contract:** deliver all feasible features in one autonomous task, with self-run automated tests and a single final reviewable PR/branch. Do not stop after a plan or first feature; do not require user approval at every development milestone. Follow `MASTER-TASK.md` acceptance tests.
- Devices: **iPhone / iOS Safari + home-screen web app and Windows**. No Android-specific features unless separately requested.
- Brand: **Pocket Archive**, Minimal & Modern, Butter Yellow `#FFF2C9` × Periwinkle `#CBD7EF`, **A3 solid bookmark Icon**. Icon selection is final for now; do not reopen design exploration.
- AI categorization is a **manually initiated batch workflow using Codex**, without separate AI API, automatic cloud upload or background model execution.
- Never commit private exports/images, tokens or credentials. Do not publicly deploy, delete user data, start paid services or access private accounts without authorization. Work around blocked external operations and document the necessary user action at the end.
- Test in browser or automate where possible, explain any untested iOS device-only steps, keep a concise final manual UAT checklist. No claims of successful tests without executing them.
