# Acme Projects agent guide

Acme Projects is a local board for collaborative feature exploration. It is intentionally not a general project-management platform. Its current integration slice creates non-triggering linked issues in Acme Issues; it does not call Helix directly.

Treat the Acme suite as an executable reference architecture, not a universal platform. Preserve Projects' local operation, focused ownership, and replaceable public seam; add breadth to demonstrate collaborative exploration, not to anticipate every organization's project-management needs.

## Related projects

| Project | Local path | Responsibility |
|---|---|---|
| Acme Identity | `~/Desktop/acme/acme-identity` | Shared suite principals, browser sessions, roles, and capability permissions. |
| Primer | `~/Desktop/acme/primer` | Knowledge product and fictional Acme evidence corpus; outside the Issues → Helix runtime loop. |
| Prelude | `~/Desktop/acme/prelude` | New-project inception and bootstrap artifact export before a Helix repo exists. |
| Helix | `~/Desktop/acme/helix` | Agent workflow control plane reached through Acme Issues for authorized implementation work. |
| Acme Issues | `~/Desktop/acme/acme-issues` | Concrete bug, issue, local PR, and review lifecycle. |
| Acme Projects | `~/Desktop/acme/acme-projects` | Feature ideas, collaborative exploration, decisions, and implementation intent for existing Helix repos. |
| Acme Steering | `~/Desktop/acme/acme-steering` | Optional decision inbox and delegation-policy coordinator; may invoke only Projects' narrow Issues-submission action. |
| Acme Intel | `~/Desktop/acme/acme-intel` | Optional think-lab; does not currently study Projects directly and must not mutate cards. |
| Acme Todo | `~/Desktop/acme/acme-todo` | Disposable target application for agent implementation and verification. |

Acme Projects assumes a repository already exists. Brand-new project inception belongs to Prelude until a Helix-ready workspace has been bootstrapped.

## Product boundaries

- Cards are collaborative product intent, not issues.
- `repositoryPath` is optional metadata for a later multi-repo Issues surface.
  Today's Submit as issue → Acme Issues → Helix path uses the Helix serve
  workspace; do not require a repository path for handoff.
- Each board stores an issues system base URL plus a project slug/id
  (`issuesProjectRef`) so Submit as issue targets nested
  `/api/projects/:ref/issues` routes.
- The fixed flow is `Ideas → Exploring → Ready → In progress → In review → Done`.
- `Ready` is the implementation handoff boundary. The default manual **Submit
  as issue** action creates an `acme-projects` issue without Acme Issues'
  configured trigger label.
- Acme Projects does not call Helix directly. It requests a thin linked
  implementation issue from Acme Issues, which triggers Helix and owns the PR
  lifecycle.
- A human normally adds the configured trigger label in Acme Issues. Optional
  Steering can request Projects submission and Issues triggering only through
  their separate public actions; both remain human-authorized in the current
  reference policy. Lifecycle projection is implemented via Issues →
  Projects webhooks: Helix accepts trigger → `In progress`, PR registered →
  `In review`, merge/close → `Done`.
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
6. Before committing cross-cutting changes, run `npm run verify` (typecheck, test, and build).
7. Keep `ACME_AUTH_MODE=off` as the standalone/test default. In `local`, gate
   reads on `projects.read` or `projects.write`, ordinary mutations on `projects.write`,
   and never branch on fixed role names. Require `projects.write` on
   `POST /api/webhooks/issues` and `projects.steering.submit` only on the narrow
   Steering action endpoint; machine callers use scoped bearer tokens, and
   outbound tokens are attached only for configured trusted Issues origins.
8. Require `projects.steering.receive` on the Steering decision endpoint. Record
   the decision durably and append one system comment without moving the card or
   bypassing the Issues handoff.
9. **Settings** owns local board identity; **Connections** owns sibling links
   (per-board Acme Issues URL/project ref and the instance-wide Steering URL).
   A saved Steering URL overrides `ACME_STEERING_URL`; clearing the override
   returns to startup configuration. Tokens remain server-side and may be sent
   only to trusted origins.
