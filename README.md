# Acme Projects

A small, local project board for exploring feature ideas collaboratively before they become implementation work.

Acme Projects deliberately sits between an idea and an issue tracker. Projects define the repository scope; their cards hold an evolving description, decisions, open questions, acceptance notes, and discussion. Ready cards can be submitted manually to Acme Issues, but Acme Projects does not call Helix or trigger implementation automatically.

## Acme development testbed

Acme Projects is one of six related projects. They remain separate products
with separate responsibilities.

| Project | Role |
|---|---|
| **[Primer](https://github.com/eimg/primer)** | Knowledge product and fictional Acme evidence corpus; currently outside the Issues → Helix runtime loop. |
| **[Prelude](https://github.com/eimg/prelude)** | New-project inception; drafts freeform docs and exports bootstrap artifacts before a Helix repo exists. |
| **[Helix](https://github.com/eimg/helix)** | Agent workflow control plane that receives work and orchestrates changes. |
| **[Acme Issues](https://github.com/eimg/acme-issues)** | Concrete issue, local PR, and review lifecycle; the planned implementation intermediary for Acme Projects. |
| **[Acme Projects](https://github.com/eimg/acme-projects)** | Feature ideas, collaborative exploration, decisions, and implementation readiness for existing Helix repos. |
| **[Acme Todo](https://github.com/eimg/acme-todo)** | Disposable target application used for agent implementation and verification. |

Acme Projects assumes a repository already exists. Brand-new project inception
belongs to Prelude until a Helix-ready workspace has been bootstrapped.

## Quick start

Requirements: Node.js 20.19 or newer.

```bash
npm install
npm run dev
```

Open [http://127.0.0.1:8330](http://127.0.0.1:8330).

Data is stored in `./data/projects.db`. Override the location with:

```bash
ACME_PROJECTS_DATA_DIR=/path/to/data npm run dev
```

## Board model

Every project uses the same intentionally simple flow:

```text
Ideas → Exploring → Ready → In progress → In review → Done
```

- **Ideas** captures possibilities without requiring a complete proposal.
- **Exploring** is active collaboration: alternatives, questions, and shaping.
- **Ready** means the intent is clear enough to implement.
- **In progress** records that implementation has been authorized.
- **In review** represents implementation awaiting review or merge.
- **Done** represents completed work.

Cards can be dragged and reordered among **Ideas**, **Exploring**, and **Ready**.
**In progress**, **In review**, and **Done** are reserved for later external
lifecycle events. Once a card has a linked implementation issue, cross-column
dragging is locked; use **Return to exploration** to close an untriggered issue
and move the card back safely.

## Collaboration

Each card provides:

- A shared current description
- Decisions
- Open questions
- Acceptance notes
- A chronological discussion

Each project can optionally record a repository path for later multi-repo
routing. Today's handoff does not need it: Submit as issue → Acme Issues →
Helix runs in whatever workspace `helix serve` was started in.

This is not intended to become a general project-management platform. The focus is the conversation and decisions that turn an uncertain feature idea into implementable intent.

## Acme Issues handoff

`Ready` is the implementation handoff boundary. A Ready card exposes a manual
**Submit as issue** action. It saves the current card context and creates an
Acme Issues issue labeled `acme-projects`; it deliberately omits `trigger`, so
the normal default does not run Helix.

For manual testing, open the linked issue in Acme Issues and add its configured
trigger label (normally `trigger`). Acme Issues then uses its existing Helix
delivery path. Submission is refused if Acme Issues is configured to use
`acme-projects` as its trigger label.
Configure the Acme Issues URL and Issues project slug in **Project settings**
(repository path is optional and unused by the current Helix handoff).

```text
Ready card
  → human selects Submit as issue
  → Acme Issues issue labeled acme-projects
  → human adds trigger in Acme Issues
  → Acme Issues triggers Helix
```

Automatic triggering remains planned. After Submit as issue, Acme Issues
callbacks project the card forward:

```text
Helix run accepted → In progress
PR registered → In review
Human merge / issue completed → Done
```

Acme Projects does not call Helix directly. See [`docs/workflow-model.md`](./docs/workflow-model.md).

## Commands

```bash
npm run dev           # serve with auto-restart; UI is served from web/ over HMR
npm run dev:web       # standalone Vite development server; proxies /api to port 8330
npm run typecheck
npm test              # API and persistence tests
npm run build         # build server and browser UI
npm run verify        # typecheck + test + build
npm start             # run the compiled CLI
```

The compiled CLI also accepts:

```bash
acme-projects serve [--port 8330] [--host 127.0.0.1]
```

## Technology

- TypeScript and Node.js
- Express
- SQLite through `better-sqlite3`
- React and TanStack Query
- Vite

## API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/health` | Health check |
| `GET` | `/api/projects` | List projects |
| `POST` | `/api/projects` | Create a project |
| `PATCH` | `/api/projects/:id` | Update a project |
| `DELETE` | `/api/projects/:id` | Delete a project and its cards |
| `GET` | `/api/projects/:id/board` | Read the complete board |
| `POST` | `/api/projects/:id/cards` | Create a card |
| `GET` | `/api/cards/:id` | Read a card |
| `PATCH` | `/api/cards/:id` | Update collaboration fields |
| `POST` | `/api/cards/:id/move` | Move or reorder a card |
| `POST` | `/api/cards/:id/submit-issue` | Create a non-triggering linked Acme Issues issue |
| `POST` | `/api/cards/:id/return-to-exploration` | Close an untriggered linked issue and return the card |
| `GET` | `/api/cards/:id/implementation-attempts` | List linked implementation attempts |
| `DELETE` | `/api/cards/:id` | Delete a card |
| `GET` | `/api/cards/:id/comments` | List discussion |
| `POST` | `/api/cards/:id/comments` | Add a comment |
| `DELETE` | `/api/cards/:cardId/comments/:commentId` | Delete a comment |
