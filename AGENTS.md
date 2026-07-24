# Acme Projects agent guide

Acme Projects is a local board for collaborative feature exploration. It is intentionally not a general project-management platform. Its current integration slice creates non-triggering linked issues in Acme Issues; it does not call Helix directly.

## Related projects

| Project | Local path | Responsibility |
|---|---|---|
| Primer | `~/Desktop/acme/primer` | Knowledge product and fictional Acme evidence corpus; outside the Issues → Helix runtime loop. |
| Prelude | `~/Desktop/acme/prelude` | New-project inception and bootstrap artifact export before a Helix repo exists. |
| Helix | `~/Desktop/acme/helix` | Agent workflow control plane that will eventually receive authorized implementation work. |
| Acme Issues | `~/Desktop/acme/acme-issues` | Concrete bug, issue, local PR, and review lifecycle. |
| Acme Projects | `~/Desktop/acme/acme-projects` | Feature ideas, collaborative exploration, decisions, and implementation intent for existing Helix repos. |
| Acme Todo | `~/Desktop/acme/acme-todo` | Disposable target application for agent implementation and verification. |

Acme Projects assumes a repository already exists. Brand-new project inception belongs to Prelude until a Helix-ready workspace has been bootstrapped.

## Product boundaries

- Cards are collaborative product intent, not issues.
- `repositoryPath` is optional metadata for a later multi-repo Issues surface.
  Today's Submit as issue → Acme Issues → Helix path uses the Helix serve
  workspace; do not require a repository path for handoff.
- The fixed flow is `Ideas → Exploring → Ready → In progress → In review → Done`.
- `Ready` is the implementation handoff boundary. The current manual **Submit
  as issue** action creates an `acme-projects` issue without Acme Issues'
  configured trigger label.
- Acme Projects does not call Helix directly. It requests a thin linked
  implementation issue from Acme Issues, which triggers Helix and owns the PR
  lifecycle.
- A human currently adds the configured trigger label in Acme Issues. Automatic
  triggering and callbacks that project `In progress`, `In review`, and `Done`
  remain planned.
- Manual moves are limited to Ideas, Exploring, and Ready. A linked issue locks
  cross-column movement; Return to exploration closes only an open issue that
  does not yet contain the configured trigger label.
- Keep discussion, decisions, questions, and acceptance context central.
- Do not add sprints, capacity planning, time tracking, Gantt views, resource allocation, or workflow builders without an explicit product decision.
- Preserve the Acme Issues intermediary; do not add a direct Projects → Helix
  trigger path.

The current and intended contract is documented in
[`docs/workflow-model.md`](./docs/workflow-model.md).

## Architecture

- Node.js 20.19+, TypeScript, ESM.
- Express serves a React/Vite browser UI.
- SQLite state lives in `data/projects.db`, configurable through `ACME_PROJECTS_DATA_DIR`.
- Projects own their repository scope and cards; cards own comments. Foreign-key
  cascades preserve cleanup.
- `implementation_attempts` owns durable card-to-issue linkage and withdrawal
  history. At most one `issue_pending` attempt may be active per card.
- Board columns are a fixed application contract in `src/types.ts`.

## Working rules

1. Inspect the implementation and tests before editing.
2. Preserve the distinction between board stage and a future external execution state.
3. Keep the app runnable without credentials, network access, Helix, Acme Issues, or GitHub.
4. Keep the visual style light and distinct while retaining the typography and compact spacing conventions shared with Acme Issues.
5. Preserve unrelated user changes.
6. Before committing cross-cutting changes, run:

```bash
npm test
npm run build
```
