# Intended implementation workflow

**Status:** The manual Ready-card → Acme Issues handoff is implemented.
Automatic triggering and Helix/PR lifecycle projection are planned.

Acme Projects owns collaborative feature intent for repositories that already
exist. Brand-new project inception belongs to **Prelude**, which drafts freeform
docs and exports bootstrap artifacts for Helix empty-workspace bootstrap;
Prelude does not call Acme Projects, Acme Issues, or Helix today.

Acme Issues owns concrete implementation issues and the human-facing
pull-request lifecycle. Helix owns repository-local implementation and
independent PR-review execution.

The intended relationship is:

```text
Acme Projects card
  → human marks the card Ready
  → human selects Submit as issue
  → Acme Projects asks Acme Issues to create a linked implementation issue
  → human adds the trigger label in Acme Issues
  → Acme Issues triggers Helix in the project repository
  → accepted Helix run moves the card to In progress
  → Helix registers the resulting PR in Acme Issues
  → PR creation moves the card to In review
  → human-recorded merge closes the implementation issue and moves the card to Done
```

Acme Projects does not call Helix directly. Acme Issues is the implementation
and PR intermediary, giving Helix one consistent companion integration and
preserving issue, run, continuation, PR, review, and merge lineage.

## Work-object ownership

| Work object or decision | Owner |
|---|---|
| Feature idea, discussion, and evolving intent | Acme Projects |
| Decisions, open questions, and acceptance notes | Acme Projects |
| Whether the feature is ready for implementation | Acme Projects |
| Concrete implementation attempt | Acme Issues |
| Helix run and repository-local agent execution | Helix |
| Local PR record, review history, and human merge record | Acme Issues |
| Overall feature completion | Acme Projects |

The generated implementation issue is a thin execution envelope, not a copy of
the project card. It should reference the source project and card, preserve a
concise implementation snapshot and acceptance notes, and identify the project
repository. Exploration and product discussion remain on the card.

One card may produce multiple sequential implementation issues and PRs. The
current integration allows only one active attempt at a time, but its identity
model does not assume one card equals one issue.

## Trigger semantics

`Ready` means the card is eligible for implementation. `In progress` means
Acme Issues has successfully created the execution record and Helix has accepted
a run.

The current integration is manual:

```text
Ready card
  → Submit as issue
  → linked issue labeled acme-projects
  → human adds trigger
  → accepted Helix run
  → In progress (planned projection)
```

A later project-level policy may automatically request implementation when a
card enters `Ready` through Acme Issues. The same acceptance rule still applies:
the card moves to `In progress` only after Helix accepts the run.

If issue creation or run submission fails, the card remains `Ready`, records
no active attempt, and waits for an explicit retry. A later automatic mode must
not loop on a system-driven return to `Ready`.

Once a linked issue exists, arbitrary cross-column movement is disabled. A
pending, untriggered issue can be closed through **Return to exploration**,
which records the attempt as withdrawn and moves the card to `Exploring`. If a
human already added the configured trigger label, withdrawal fails closed
rather than pretending the external work stopped.

## Repository scope

One Acme Projects board is an exploration space. An optional `repositoryPath`
may be stored for later multi-repo routing; cards do not pick their own path.

Today's Submit as issue handoff does **not** route Helix by that path. Acme
Issues triggers whichever Helix instance its webhook points at, and that Helix
runs in its serve workspace. Keep `repositoryPath` for future multi-project
Issues surfaces; leave it blank for the current single-Helix test flow.
