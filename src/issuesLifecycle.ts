import type Database from "better-sqlite3";
import type { Card, ColumnId, ImplementationAttempt } from "./types.js";
import {
  getCard,
  getImplementationAttemptByIssueId,
  moveCard,
} from "./store.js";

export type IssuesLifecycleEvent =
  | "implementation.started"
  | "implementation.in_review"
  | "implementation.completed";

export interface IssuesLifecyclePayload {
  event: IssuesLifecycleEvent;
  issueId: number;
  sourceCardId: string;
  projectId?: number;
  projectSlug?: string;
  externalEventId?: string;
  pullRequestId?: number;
}

const COLUMN_RANK: Record<ColumnId, number> = {
  ideas: 0,
  exploring: 1,
  ready: 2,
  in_progress: 3,
  in_review: 4,
  done: 5,
};

export function columnForLifecycleEvent(event: IssuesLifecycleEvent): ColumnId {
  switch (event) {
    case "implementation.started":
      return "in_progress";
    case "implementation.in_review":
      return "in_review";
    case "implementation.completed":
      return "done";
  }
}

/**
 * Project an Issues lifecycle fact onto the linked card.
 * Only moves forward; already-at-or-past target is a no-op success.
 */
export function projectIssuesLifecycle(
  db: Database.Database,
  payload: IssuesLifecyclePayload,
): {
  card: Card;
  attempt: ImplementationAttempt;
  columnId: ColumnId;
  moved: boolean;
} {
  const attempt = getImplementationAttemptByIssueId(db, payload.issueId);
  if (!attempt) {
    throw new LifecycleNotFoundError("No implementation attempt found for this issue");
  }
  if (attempt.status !== "issue_pending") {
    throw new LifecycleConflictError("Implementation attempt is no longer active");
  }

  const card = getCard(db, attempt.cardId);
  if (!card) {
    throw new LifecycleNotFoundError("Linked card was not found");
  }
  if (String(card.id) !== String(payload.sourceCardId).trim()) {
    throw new LifecycleConflictError("sourceCardId does not match the linked implementation card");
  }

  const columnId = columnForLifecycleEvent(payload.event);
  if (COLUMN_RANK[card.columnId] >= COLUMN_RANK[columnId]) {
    return { card, attempt, columnId: card.columnId, moved: false };
  }

  const moved = moveCard(db, card.id, columnId, Number.MAX_SAFE_INTEGER);
  if (!moved) {
    throw new LifecycleNotFoundError("Linked card was not found");
  }
  return {
    card: getCard(db, card.id)!,
    attempt,
    columnId,
    moved: true,
  };
}

export class LifecycleNotFoundError extends Error {}
export class LifecycleConflictError extends Error {}

export function parseIssuesLifecyclePayload(body: unknown): IssuesLifecyclePayload {
  if (!body || typeof body !== "object") {
    throw new Error("Lifecycle payload must be an object");
  }
  const value = body as Record<string, unknown>;
  const event = value.event;
  if (
    event !== "implementation.started" &&
    event !== "implementation.in_review" &&
    event !== "implementation.completed"
  ) {
    throw new Error("event must be implementation.started, implementation.in_review, or implementation.completed");
  }
  const issueId = Number(value.issueId);
  if (!Number.isInteger(issueId) || issueId <= 0) {
    throw new Error("issueId must be a positive integer");
  }
  if (typeof value.sourceCardId !== "string" || !value.sourceCardId.trim()) {
    throw new Error("sourceCardId is required");
  }
  return {
    event,
    issueId,
    sourceCardId: value.sourceCardId.trim(),
    projectId: typeof value.projectId === "number" ? value.projectId : undefined,
    projectSlug: typeof value.projectSlug === "string" ? value.projectSlug : undefined,
    externalEventId: typeof value.externalEventId === "string" ? value.externalEventId : undefined,
    pullRequestId: typeof value.pullRequestId === "number" ? value.pullRequestId : undefined,
  };
}
