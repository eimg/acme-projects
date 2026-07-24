import type Database from "better-sqlite3";
import {
  BOARD_COLUMNS,
  type Board,
  type Card,
  type CardComment,
  type ColumnId,
  type ImplementationAttempt,
  type ImplementationAttemptStatus,
  type Project,
} from "./types.js";

type ProjectRow = {
  id: number;
  name: string;
  description: string;
  repository_path: string;
  issues_url: string;
  created_at: number;
  updated_at: number;
};

type CardRow = {
  id: number;
  project_id: number;
  title: string;
  description: string;
  decisions: string;
  open_questions: string;
  acceptance_notes: string;
  column_id: ColumnId;
  position: number;
  comment_count: number;
  created_at: number;
  updated_at: number;
};

type CommentRow = {
  id: number;
  card_id: number;
  author: string;
  body: string;
  created_at: number;
};

type ImplementationAttemptRow = {
  id: number;
  card_id: number;
  issue_id: number;
  issue_url: string;
  issues_url: string;
  trigger_label: string;
  status: ImplementationAttemptStatus;
  snapshot: string;
  created_at: number;
  updated_at: number;
};

export function listProjects(db: Database.Database): Project[] {
  const rows = db.prepare("SELECT * FROM projects ORDER BY updated_at DESC, id DESC").all() as ProjectRow[];
  return rows.map(toProject);
}

export function getProject(db: Database.Database, id: number): Project | undefined {
  const row = db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined;
  return row ? toProject(row) : undefined;
}

export function createProject(
  db: Database.Database,
  input: { name: string; description?: string; repositoryPath?: string; issuesUrl?: string },
): Project {
  const now = Date.now();
  const result = db.prepare(`
    INSERT INTO projects (
      name, description, repository_path, issues_url, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    input.name.trim(),
    input.description?.trim() ?? "",
    input.repositoryPath?.trim() ?? "",
    input.issuesUrl?.trim() ?? "",
    now,
    now,
  );
  return getProject(db, Number(result.lastInsertRowid))!;
}

export function updateProject(
  db: Database.Database,
  id: number,
  input: { name?: string; description?: string; repositoryPath?: string; issuesUrl?: string },
): Project | undefined {
  const project = getProject(db, id);
  if (!project) return undefined;
  db.prepare(`
    UPDATE projects
    SET name = ?, description = ?, repository_path = ?, issues_url = ?, updated_at = ?
    WHERE id = ?
  `).run(
    input.name?.trim() ?? project.name,
    input.description?.trim() ?? project.description,
    input.repositoryPath?.trim() ?? project.repositoryPath,
    input.issuesUrl?.trim() ?? project.issuesUrl,
    Date.now(),
    id,
  );
  return getProject(db, id);
}

export function deleteProject(db: Database.Database, id: number): boolean {
  return db.prepare("DELETE FROM projects WHERE id = ?").run(id).changes > 0;
}

export function projectHasActiveImplementation(
  db: Database.Database,
  projectId: number,
): boolean {
  const row = db.prepare(`
    SELECT EXISTS(
      SELECT 1
      FROM implementation_attempts
      JOIN cards ON cards.id = implementation_attempts.card_id
      WHERE cards.project_id = ? AND implementation_attempts.status = 'issue_pending'
    ) AS active
  `).get(projectId) as { active: number };
  return row.active === 1;
}

export function getBoard(db: Database.Database, projectId: number): Board | undefined {
  const project = getProject(db, projectId);
  if (!project) return undefined;
  const rows = db.prepare(`
    SELECT cards.*, COUNT(card_comments.id) AS comment_count
    FROM cards
    LEFT JOIN card_comments ON card_comments.card_id = cards.id
    WHERE cards.project_id = ?
    GROUP BY cards.id
    ORDER BY cards.column_id, cards.position, cards.id
  `).all(projectId) as CardRow[];
  const cards = rows.map((row) => withActiveImplementation(db, toCard(row)));
  return {
    project,
    columns: BOARD_COLUMNS.map((column) => ({
      ...column,
      cards: cards.filter((card) => card.columnId === column.id),
    })),
  };
}

export function getCard(db: Database.Database, id: number): Card | undefined {
  const row = db.prepare(`
    SELECT cards.*, COUNT(card_comments.id) AS comment_count
    FROM cards
    LEFT JOIN card_comments ON card_comments.card_id = cards.id
    WHERE cards.id = ?
    GROUP BY cards.id
  `).get(id) as CardRow | undefined;
  return row ? withActiveImplementation(db, toCard(row)) : undefined;
}

export function createCard(
  db: Database.Database,
  projectId: number,
  input: { title: string; description?: string; columnId?: ColumnId },
): Card {
  const now = Date.now();
  const columnId = input.columnId ?? "ideas";
  const max = db.prepare(`
    SELECT COALESCE(MAX(position), -1) AS position FROM cards
    WHERE project_id = ? AND column_id = ?
  `).get(projectId, columnId) as { position: number };
  const result = db.prepare(`
    INSERT INTO cards (
      project_id, title, description, column_id, position, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    projectId,
    input.title.trim(),
    input.description?.trim() ?? "",
    columnId,
    max.position + 1,
    now,
    now,
  );
  touchProject(db, projectId);
  return getCard(db, Number(result.lastInsertRowid))!;
}

export type CardUpdate = Partial<Pick<
  Card,
  "title" | "description" | "decisions" | "openQuestions" | "acceptanceNotes"
>>;

export function updateCard(
  db: Database.Database,
  id: number,
  input: CardUpdate,
): Card | undefined {
  const card = getCard(db, id);
  if (!card) return undefined;
  db.prepare(`
    UPDATE cards SET
      title = ?,
      description = ?,
      decisions = ?,
      open_questions = ?,
      acceptance_notes = ?,
      updated_at = ?
    WHERE id = ?
  `).run(
    input.title?.trim() ?? card.title,
    input.description?.trim() ?? card.description,
    input.decisions?.trim() ?? card.decisions,
    input.openQuestions?.trim() ?? card.openQuestions,
    input.acceptanceNotes?.trim() ?? card.acceptanceNotes,
    Date.now(),
    id,
  );
  touchProject(db, card.projectId);
  return getCard(db, id);
}

export function moveCard(
  db: Database.Database,
  id: number,
  columnId: ColumnId,
  index: number,
): Card | undefined {
  const card = getCard(db, id);
  if (!card) return undefined;
  const move = db.transaction(() => {
    const sourceIds = card.columnId === columnId
      ? columnCardIds(db, card.projectId, columnId).filter((cardId) => cardId !== id)
      : columnCardIds(db, card.projectId, card.columnId).filter((cardId) => cardId !== id);
    const targetIds = card.columnId === columnId
      ? sourceIds
      : columnCardIds(db, card.projectId, columnId).filter((cardId) => cardId !== id);
    const boundedIndex = Math.max(0, Math.min(index, targetIds.length));
    targetIds.splice(boundedIndex, 0, id);

    db.prepare("UPDATE cards SET column_id = ?, updated_at = ? WHERE id = ?")
      .run(columnId, Date.now(), id);
    renumber(db, card.projectId, columnId, targetIds);
    if (card.columnId !== columnId) {
      renumber(db, card.projectId, card.columnId, sourceIds);
    }
    touchProject(db, card.projectId);
  });
  move();
  return getCard(db, id);
}

export function deleteCard(db: Database.Database, id: number): boolean {
  const card = getCard(db, id);
  if (!card) return false;
  const deleted = db.prepare("DELETE FROM cards WHERE id = ?").run(id).changes > 0;
  touchProject(db, card.projectId);
  return deleted;
}

export function listComments(db: Database.Database, cardId: number): CardComment[] {
  const rows = db.prepare(`
    SELECT * FROM card_comments WHERE card_id = ? ORDER BY created_at, id
  `).all(cardId) as CommentRow[];
  return rows.map(toComment);
}

export function createComment(
  db: Database.Database,
  cardId: number,
  input: { author?: string; body: string },
): CardComment {
  const result = db.prepare(`
    INSERT INTO card_comments (card_id, author, body, created_at)
    VALUES (?, ?, ?, ?)
  `).run(cardId, input.author?.trim() || "You", input.body.trim(), Date.now());
  const row = db.prepare("SELECT * FROM card_comments WHERE id = ?")
    .get(Number(result.lastInsertRowid)) as CommentRow;
  const card = getCard(db, cardId)!;
  touchProject(db, card.projectId);
  return toComment(row);
}

export function deleteComment(db: Database.Database, cardId: number, commentId: number): boolean {
  return db.prepare("DELETE FROM card_comments WHERE id = ? AND card_id = ?")
    .run(commentId, cardId).changes > 0;
}

export function listImplementationAttempts(
  db: Database.Database,
  cardId: number,
): ImplementationAttempt[] {
  const rows = db.prepare(`
    SELECT * FROM implementation_attempts
    WHERE card_id = ?
    ORDER BY created_at DESC, id DESC
  `).all(cardId) as ImplementationAttemptRow[];
  return rows.map(toImplementationAttempt);
}

export function getActiveImplementationAttempt(
  db: Database.Database,
  cardId: number,
): ImplementationAttempt | undefined {
  const row = db.prepare(`
    SELECT * FROM implementation_attempts
    WHERE card_id = ? AND status = 'issue_pending'
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `).get(cardId) as ImplementationAttemptRow | undefined;
  return row ? toImplementationAttempt(row) : undefined;
}

export function createImplementationAttempt(
  db: Database.Database,
  cardId: number,
  input: {
    issueId: number;
    issueUrl: string;
    issuesUrl: string;
    triggerLabel: string;
    snapshot: string;
  },
): ImplementationAttempt {
  const now = Date.now();
  const result = db.prepare(`
    INSERT INTO implementation_attempts (
      card_id, issue_id, issue_url, issues_url, trigger_label,
      status, snapshot, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'issue_pending', ?, ?, ?)
  `).run(
    cardId,
    input.issueId,
    input.issueUrl,
    input.issuesUrl,
    input.triggerLabel,
    input.snapshot,
    now,
    now,
  );
  touchProjectForCard(db, cardId);
  const row = db.prepare("SELECT * FROM implementation_attempts WHERE id = ?")
    .get(Number(result.lastInsertRowid)) as ImplementationAttemptRow;
  return toImplementationAttempt(row);
}

export function withdrawImplementationAttempt(
  db: Database.Database,
  attemptId: number,
): ImplementationAttempt | undefined {
  const now = Date.now();
  const changed = db.prepare(`
    UPDATE implementation_attempts
    SET status = 'withdrawn', updated_at = ?
    WHERE id = ? AND status = 'issue_pending'
  `).run(now, attemptId).changes;
  if (!changed) return undefined;
  const row = db.prepare("SELECT * FROM implementation_attempts WHERE id = ?")
    .get(attemptId) as ImplementationAttemptRow;
  touchProjectForCard(db, row.card_id);
  return toImplementationAttempt(row);
}

function columnCardIds(
  db: Database.Database,
  projectId: number,
  columnId: ColumnId,
): number[] {
  return (db.prepare(`
    SELECT id FROM cards WHERE project_id = ? AND column_id = ?
    ORDER BY position, id
  `).all(projectId, columnId) as { id: number }[]).map((row) => row.id);
}

function renumber(
  db: Database.Database,
  projectId: number,
  columnId: ColumnId,
  ids: number[],
): void {
  const statement = db.prepare(`
    UPDATE cards SET position = ? WHERE id = ? AND project_id = ? AND column_id = ?
  `);
  ids.forEach((id, position) => statement.run(position, id, projectId, columnId));
}

function touchProject(db: Database.Database, projectId: number): void {
  db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(Date.now(), projectId);
}

function touchProjectForCard(db: Database.Database, cardId: number): void {
  const row = db.prepare("SELECT project_id FROM cards WHERE id = ?")
    .get(cardId) as { project_id: number } | undefined;
  if (row) touchProject(db, row.project_id);
}

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    repositoryPath: row.repository_path,
    issuesUrl: row.issues_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function withActiveImplementation(db: Database.Database, card: Card): Card {
  const activeImplementation = getActiveImplementationAttempt(db, card.id);
  return activeImplementation ? { ...card, activeImplementation } : card;
}

function toCard(row: CardRow): Card {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    description: row.description,
    decisions: row.decisions,
    openQuestions: row.open_questions,
    acceptanceNotes: row.acceptance_notes,
    columnId: row.column_id,
    position: row.position,
    commentCount: row.comment_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toComment(row: CommentRow): CardComment {
  return {
    id: row.id,
    cardId: row.card_id,
    author: row.author,
    body: row.body,
    createdAt: row.created_at,
  };
}

function toImplementationAttempt(row: ImplementationAttemptRow): ImplementationAttempt {
  return {
    id: row.id,
    cardId: row.card_id,
    issueId: row.issue_id,
    issueUrl: row.issue_url,
    issuesUrl: row.issues_url,
    triggerLabel: row.trigger_label,
    status: row.status,
    snapshot: row.snapshot,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
