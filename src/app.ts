import express, { type Express } from "express";
import type { Server } from "node:http";
import type Database from "better-sqlite3";
import { BOARD_COLUMNS, type ColumnId } from "./types.js";
import { attachHmr, webAssets, webFromSource, webIndex } from "./webAssets.js";
import {
  createProjectIssue,
  IntegrationConflict,
  normalizeIssuesProjectRef,
  normalizeIssuesUrl,
  type FetchFn,
  withdrawProjectIssue,
} from "./acmeIssues.js";
import {
  LifecycleConflictError,
  LifecycleNotFoundError,
  parseIssuesLifecyclePayload,
  projectIssuesLifecycle,
} from "./issuesLifecycle.js";
import { issuesLifecycleWebhookUrl, setPublicBaseUrl } from "./publicUrl.js";
import {
  createCard,
  createComment,
  createImplementationAttempt,
  createProject,
  deleteCard,
  deleteComment,
  deleteProject,
  getBoard,
  getActiveImplementationAttempt,
  getCard,
  getProject,
  listImplementationAttempts,
  listComments,
  listProjects,
  moveCard,
  updateCard,
  updateProject,
  withdrawImplementationAttempt,
} from "./store.js";

const columnIds = new Set<string>(BOARD_COLUMNS.map((column) => column.id));
const manualColumnIds = new Set<ColumnId>(["ideas", "exploring", "ready"]);

export function createApp({
  db,
  fetchFn = fetch,
}: {
  db: Database.Database;
  fetchFn?: FetchFn;
}): Express {
  const app = express();
  app.use(express.json());
  app.use(webAssets());

  app.get("/api/health", (_req, res) => res.json({ ok: true }));
  app.get("/api/columns", (_req, res) => res.json(BOARD_COLUMNS));

  app.get("/api/projects", (_req, res) => res.json(listProjects(db)));

  app.post("/api/projects", (req, res) => {
    const body = req.body as Record<string, unknown>;
    const name = text(body.name);
    if (!name) return res.status(400).json({ error: "name is required" });
    if (typeof body.issuesUrl === "string" && body.issuesUrl.trim()) {
      try {
        normalizeIssuesUrl(body.issuesUrl);
      } catch (error) {
        return res.status(400).json({ error: errorMessage(error) });
      }
    }
    if (typeof body.issuesProjectRef === "string" && body.issuesProjectRef.trim()) {
      try {
        normalizeIssuesProjectRef(body.issuesProjectRef);
      } catch (error) {
        return res.status(400).json({ error: errorMessage(error) });
      }
    }
    res.status(201).json(createProject(db, {
      name,
      description: text(body.description) ?? "",
      repositoryPath: text(body.repositoryPath) ?? "",
      issuesUrl: text(body.issuesUrl) ?? "",
      issuesProjectRef: text(body.issuesProjectRef) ?? "",
    }));
  });

  app.patch("/api/projects/:id", (req, res) => {
    const id = numberId(req.params.id);
    const body = req.body as Record<string, unknown>;
    if (body.name !== undefined && !text(body.name)) {
      return res.status(400).json({ error: "name cannot be empty" });
    }
    if (body.issuesUrl !== undefined && typeof body.issuesUrl === "string" && body.issuesUrl.trim()) {
      try {
        normalizeIssuesUrl(body.issuesUrl);
      } catch (error) {
        return res.status(400).json({ error: errorMessage(error) });
      }
    }
    if (
      body.issuesProjectRef !== undefined &&
      typeof body.issuesProjectRef === "string" &&
      body.issuesProjectRef.trim()
    ) {
      try {
        normalizeIssuesProjectRef(body.issuesProjectRef);
      } catch (error) {
        return res.status(400).json({ error: errorMessage(error) });
      }
    }
    const project = updateProject(db, id, {
      name: text(body.name),
      description: typeof body.description === "string" ? body.description : undefined,
      repositoryPath: typeof body.repositoryPath === "string" ? body.repositoryPath : undefined,
      issuesUrl: typeof body.issuesUrl === "string" ? body.issuesUrl : undefined,
      issuesProjectRef: typeof body.issuesProjectRef === "string" ? body.issuesProjectRef : undefined,
    });
    if (!project) return res.status(404).json({ error: "Project not found" });
    res.json(project);
  });

  app.delete("/api/projects/:id", (req, res) => {
    const id = numberId(req.params.id);
    if (!deleteProject(db, id)) {
      return res.status(404).json({ error: "Project not found" });
    }
    res.status(204).end();
  });

  app.get("/api/projects/:id/board", (req, res) => {
    const board = getBoard(db, numberId(req.params.id));
    if (!board) return res.status(404).json({ error: "Project not found" });
    res.json(board);
  });

  app.post("/api/projects/:id/cards", (req, res) => {
    const projectId = numberId(req.params.id);
    if (!getProject(db, projectId)) return res.status(404).json({ error: "Project not found" });
    const body = req.body as Record<string, unknown>;
    const title = text(body.title);
    if (!title) return res.status(400).json({ error: "title is required" });
    const columnId = parseColumn(body.columnId) ?? "ideas";
    if (!manualColumnIds.has(columnId)) {
      return res.status(400).json({
        error: "Cards can only be created in Ideas, Exploring, or Ready",
      });
    }
    res.status(201).json(createCard(db, projectId, {
      title,
      description: text(body.description) ?? "",
      columnId,
    }));
  });

  app.get("/api/cards/:id", (req, res) => {
    const card = getCard(db, numberId(req.params.id));
    if (!card) return res.status(404).json({ error: "Card not found" });
    res.json(card);
  });

  app.patch("/api/cards/:id", (req, res) => {
    const id = numberId(req.params.id);
    const body = req.body as Record<string, unknown>;
    if (body.title !== undefined && !text(body.title)) {
      return res.status(400).json({ error: "title cannot be empty" });
    }
    const card = updateCard(db, id, {
      title: text(body.title),
      description: typeof body.description === "string" ? body.description : undefined,
      decisions: typeof body.decisions === "string" ? body.decisions : undefined,
      openQuestions: typeof body.openQuestions === "string" ? body.openQuestions : undefined,
      acceptanceNotes: typeof body.acceptanceNotes === "string" ? body.acceptanceNotes : undefined,
    });
    if (!card) return res.status(404).json({ error: "Card not found" });
    res.json(card);
  });

  app.post("/api/cards/:id/move", (req, res) => {
    const id = numberId(req.params.id);
    const existing = getCard(db, id);
    if (!existing) return res.status(404).json({ error: "Card not found" });
    const body = req.body as Record<string, unknown>;
    const columnId = parseColumn(body.columnId);
    if (!columnId) return res.status(400).json({ error: "valid columnId is required" });
    const index = typeof body.index === "number" && Number.isFinite(body.index)
      ? Math.floor(body.index)
      : Number.MAX_SAFE_INTEGER;
    if (columnId !== existing.columnId) {
      if (existing.activeImplementation) {
        return res.status(409).json({
          error: "Use Return to exploration while this card has a linked implementation issue",
        });
      }
      if (!manualColumnIds.has(columnId)) {
        return res.status(409).json({
          error: "In progress, In review, and Done are controlled by implementation events",
        });
      }
    }
    const card = moveCard(db, id, columnId, index);
    if (!card) return res.status(404).json({ error: "Card not found" });
    res.json(card);
  });

  app.delete("/api/cards/:id", (req, res) => {
    const id = numberId(req.params.id);
    if (getActiveImplementationAttempt(db, id)) {
      return res.status(409).json({
        error: "Withdraw the linked implementation issue before deleting this card",
      });
    }
    if (!deleteCard(db, id)) {
      return res.status(404).json({ error: "Card not found" });
    }
    res.status(204).end();
  });

  app.get("/api/cards/:id/implementation-attempts", (req, res) => {
    const cardId = numberId(req.params.id);
    if (!getCard(db, cardId)) return res.status(404).json({ error: "Card not found" });
    res.json(listImplementationAttempts(db, cardId));
  });

  app.post("/api/cards/:id/submit-issue", async (req, res) => {
    const cardId = numberId(req.params.id);
    const card = getCard(db, cardId);
    if (!card) return res.status(404).json({ error: "Card not found" });
    if (card.columnId !== "ready") {
      return res.status(409).json({ error: "Only a Ready card can be submitted as an issue" });
    }
    if (card.activeImplementation) {
      return res.status(409).json({ error: "This card already has an active implementation issue" });
    }
    const project = getProject(db, card.projectId)!;
    if (!project.issuesUrl) {
      return res.status(409).json({ error: "Set the Acme Issues URL before submitting" });
    }
    if (!project.issuesProjectRef.trim()) {
      return res.status(409).json({ error: "Set the Acme Issues project slug before submitting" });
    }

    try {
      const { issue, snapshot, triggerLabel, issuesProjectRef } = await createProjectIssue(
        fetchFn,
        project,
        card,
        { projectsCallbackUrl: issuesLifecycleWebhookUrl() },
      );
      const attempt = createImplementationAttempt(db, card.id, {
        issueId: issue.id,
        issueUrl: issue.url,
        issuesUrl: normalizeIssuesUrl(project.issuesUrl),
        issuesProjectRef,
        triggerLabel,
        snapshot,
      });
      res.status(201).json({ attempt, card: getCard(db, card.id) });
    } catch (error) {
      const status = error instanceof IntegrationConflict ? 409 : 502;
      res.status(status).json({ error: errorMessage(error) });
    }
  });

  app.post("/api/webhooks/issues", (req, res) => {
    let payload;
    try {
      payload = parseIssuesLifecyclePayload(req.body);
    } catch (error) {
      return res.status(400).json({ error: errorMessage(error) });
    }
    try {
      const result = projectIssuesLifecycle(db, payload);
      res.status(200).json({
        ok: true,
        moved: result.moved,
        columnId: result.columnId,
        card: result.card,
        attemptId: result.attempt.id,
      });
    } catch (error) {
      if (error instanceof LifecycleNotFoundError) {
        return res.status(404).json({ error: errorMessage(error) });
      }
      if (error instanceof LifecycleConflictError) {
        return res.status(409).json({ error: errorMessage(error) });
      }
      return res.status(500).json({ error: errorMessage(error) });
    }
  });

  app.post("/api/cards/:id/return-to-exploration", async (req, res) => {
    const cardId = numberId(req.params.id);
    const card = getCard(db, cardId);
    if (!card) return res.status(404).json({ error: "Card not found" });
    const attempt = card.activeImplementation;
    if (!attempt) {
      return res.status(409).json({ error: "This card has no active implementation issue" });
    }
    if (card.columnId !== "ready") {
      return res.status(409).json({ error: "Only a Ready card can return to exploration" });
    }

    try {
      await withdrawProjectIssue(
        fetchFn,
        attempt.issuesUrl,
        attempt.issuesProjectRef,
        attempt.issueId,
        attempt.triggerLabel,
      );
      withdrawImplementationAttempt(db, attempt.id);
      const updated = moveCard(db, card.id, "exploring", Number.MAX_SAFE_INTEGER);
      res.json({ attempt: { ...attempt, status: "withdrawn" }, card: updated });
    } catch (error) {
      const status = error instanceof IntegrationConflict ? 409 : 502;
      res.status(status).json({ error: errorMessage(error) });
    }
  });

  app.get("/api/cards/:id/comments", (req, res) => {
    const cardId = numberId(req.params.id);
    if (!getCard(db, cardId)) return res.status(404).json({ error: "Card not found" });
    res.json(listComments(db, cardId));
  });

  app.post("/api/cards/:id/comments", (req, res) => {
    const cardId = numberId(req.params.id);
    if (!getCard(db, cardId)) return res.status(404).json({ error: "Card not found" });
    const body = req.body as Record<string, unknown>;
    const commentBody = text(body.body);
    if (!commentBody) return res.status(400).json({ error: "body is required" });
    res.status(201).json(createComment(db, cardId, {
      body: commentBody,
      author: text(body.author) ?? "You",
    }));
  });

  app.delete("/api/cards/:cardId/comments/:commentId", (req, res) => {
    if (!deleteComment(db, numberId(req.params.cardId), numberId(req.params.commentId))) {
      return res.status(404).json({ error: "Comment not found" });
    }
    res.status(204).end();
  });

  app.get("*path", webIndex());
  return app;
}

export function startServer({
  db,
  port,
  host,
  fetchFn,
}: {
  db: Database.Database;
  port: number;
  host: string;
  fetchFn?: FetchFn;
}): Server {
  setPublicBaseUrl(process.env.ACME_PROJECTS_BASE_URL ?? `http://${host}:${port}`);
  const server = createApp({ db, fetchFn }).listen(port, host, () => {
    console.log(
      `Acme Projects running at http://${host}:${port}${webFromSource() ? "  (web from source)" : ""}`,
    );
  });
  attachHmr(server);
  return server;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberId(value: string | string[] | undefined): number {
  return Number(Array.isArray(value) ? value[0] : value);
}

function parseColumn(value: unknown): ColumnId | undefined {
  return typeof value === "string" && columnIds.has(value) ? value as ColumnId : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
