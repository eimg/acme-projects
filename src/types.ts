export const DEFAULT_PORT = 8330;

export const BOARD_COLUMNS = [
  { id: "ideas", name: "Ideas", description: "Possibilities worth capturing" },
  { id: "exploring", name: "Exploring", description: "Questions, options, and discussion" },
  { id: "ready", name: "Ready", description: "Clear enough to implement" },
  { id: "in_progress", name: "In progress", description: "Authorized implementation work" },
  { id: "in_review", name: "In review", description: "Implementation awaiting review" },
  { id: "done", name: "Done", description: "Completed and merged" },
] as const;

export type ColumnId = (typeof BOARD_COLUMNS)[number]["id"];

export interface Project {
  id: number;
  name: string;
  description: string;
  repositoryPath: string;
  issuesUrl: string;
  createdAt: number;
  updatedAt: number;
}

export type ImplementationAttemptStatus = "issue_pending" | "withdrawn";

export interface ImplementationAttempt {
  id: number;
  cardId: number;
  issueId: number;
  issueUrl: string;
  issuesUrl: string;
  triggerLabel: string;
  status: ImplementationAttemptStatus;
  snapshot: string;
  createdAt: number;
  updatedAt: number;
}

export interface Card {
  id: number;
  projectId: number;
  title: string;
  description: string;
  decisions: string;
  openQuestions: string;
  acceptanceNotes: string;
  columnId: ColumnId;
  position: number;
  commentCount: number;
  activeImplementation?: ImplementationAttempt;
  createdAt: number;
  updatedAt: number;
}

export interface CardComment {
  id: number;
  cardId: number;
  author: string;
  body: string;
  createdAt: number;
}

export interface BoardColumn {
  id: ColumnId;
  name: string;
  description: string;
  cards: Card[];
}

export interface Board {
  project: Project;
  columns: BoardColumn[];
}
