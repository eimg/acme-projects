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
import {
  authenticateRequests,
  authorizeProjectsRequest,
  authMode as resolveAuthMode,
  authRequest,
  createAuthAdapterFromEnv,
  handleSessionSignIn,
  handleSessionSignOut,
  principalFrom,
  sameOriginWrites,
  type AuthMode,
  type ProjectsAuthAdapter,
} from "./auth.js";
import {
  clearSteeringUrl,
  createSteeringNotifier,
  ensureSteeringDecisionStore,
  listSteeringDecisions,
  parseSteeringActionRequest,
  parseSteeringDecisionNotice,
  probeSteeringIntegration,
  recordSteeringDecision,
  resolveSteeringConfig,
  setSteeringUrl,
  steeringEnvironmentFromProcess,
  type SteeringActionReceipt,
  type SteeringEnvironmentConfig,
  type SteeringNotification,
} from "./steering.js";

const columnIds = new Set<string>(BOARD_COLUMNS.map((column) => column.id));
const manualColumnIds = new Set<ColumnId>(["ideas", "exploring", "ready"]);

export function createApp({
  db,
  fetchFn = fetch,
  identityFetchFn = fetch,
  authAdapter,
  authMode = resolveAuthMode(),
  issuesToken = process.env.ACME_ISSUES_TOKEN,
  trustedIssuesOrigins,
  steeringEnvironment = steeringEnvironmentFromProcess(),
}: {
  db: Database.Database;
  fetchFn?: FetchFn;
  identityFetchFn?: typeof fetch;
  authAdapter?: ProjectsAuthAdapter;
  authMode?: AuthMode;
  issuesToken?: string;
  trustedIssuesOrigins?: string[];
  steeringEnvironment?: SteeringEnvironmentConfig;
}): Express {
  const app = express();
  ensureSteeringDecisionStore(db);
  const resolvedAuthAdapter = authAdapter ?? createAuthAdapterFromEnv(authMode, { identityFetchFn });
  const notifySteering = createSteeringNotifier(fetchFn, () => resolveSteeringConfig(db, steeringEnvironment));
  app.use("/api", (_req, res, next) => {
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    next();
  });
  app.use(express.json());
  app.use("/api", sameOriginWrites());
  app.use(webAssets());

  app.get("/api/health", (_req, res) => res.json({ ok: true }));
  app.get("/api/auth/session", authenticateRequests(resolvedAuthAdapter), (_req, res) => {
    res.json({
      schemaVersion: "acme.session.v1",
      authMode,
      accountUrl: resolvedAuthAdapter.accountUrl,
      principal: principalFrom(res),
    });
  });
  app.post("/api/auth/session", async (req, res) => {
    await handleSessionSignIn(resolvedAuthAdapter, req.body, authRequest(req), res);
  });
  app.delete("/api/auth/session", async (req, res) => {
    await handleSessionSignOut(resolvedAuthAdapter, authRequest(req), res);
  });
  app.use("/api", authenticateRequests(resolvedAuthAdapter), authorizeProjectsRequest);
  app.get("/api/integrations/steering", async (_req, res) => {
    res.json(await probeSteeringIntegration(db, fetchFn, steeringEnvironment));
  });
  app.patch("/api/integrations/steering", async (req, res) => {
    if (req.body?.url !== null && typeof req.body?.url !== "string") {
      return res.status(400).json({ error: "url must be a string or null" });
    }
    try {
      if (req.body.url === null) clearSteeringUrl(db);
      else setSteeringUrl(db, req.body.url);
      return res.json(await probeSteeringIntegration(db, fetchFn, steeringEnvironment));
    } catch (error) {
      return res.status(400).json({ error: errorMessage(error) });
    }
  });
  app.post("/api/integrations/steering/test", async (_req, res) => {
    res.json(await probeSteeringIntegration(db, fetchFn, steeringEnvironment));
  });
  app.post("/api/steering/actions", async (req, res) => {
    const action = parseSteeringActionRequest(req.body);
    if (!action) return res.status(400).json({ error: "Invalid acme.steering.action.v1 payload" });
    if (action.actionKey !== "projects.submit_ready_card" || action.resource.type !== "card") {
      return res.status(400).json(actionReceipt(action.requestId, "rejected", action.resource.expectedRevision, "Unsupported Projects steering action."));
    }
    const card = getCard(db, numberId(action.resource.id));
    if (!card) return res.status(404).json(actionReceipt(action.requestId, "rejected", action.resource.expectedRevision, "Card not found."));
    if (card.activeImplementation) {
      return res.json(actionReceipt(action.requestId, "already_applied", String(card.updatedAt), "The card already has an active implementation issue."));
    }
    if (String(card.updatedAt) !== action.resource.expectedRevision) {
      return res.status(409).json(actionReceipt(action.requestId, "stale", String(card.updatedAt), "The card changed before the action was applied."));
    }
    if (card.columnId !== "ready") {
      return res.status(409).json(actionReceipt(action.requestId, "rejected", String(card.updatedAt), "Only a Ready card can be submitted."));
    }
    const project = getProject(db, card.projectId)!;
    if (!project.issuesUrl || !project.issuesProjectRef.trim()) {
      return res.status(409).json(actionReceipt(action.requestId, "rejected", String(card.updatedAt), "The project does not have a complete Issues destination."));
    }
    try {
      const { issue, snapshot, triggerLabel, issuesProjectRef } = await createProjectIssue(fetchFn, project, card, {
        projectsCallbackUrl: issuesLifecycleWebhookUrl(), authToken: issuesToken, trustedOrigins: trustedIssuesOrigins,
      });
      createImplementationAttempt(db, card.id, {
        issueId: issue.id, issueUrl: issue.url, issuesUrl: normalizeIssuesUrl(project.issuesUrl),
        issuesProjectRef, triggerLabel, snapshot,
      });
      const updated = getCard(db, card.id)!;
      const eventId = `acme-projects:card:${updated.id}:card.issue_submitted:${updated.updatedAt}`;
      notifySteering(cardNotification(updated, "card.issue_submitted", "Ready card submitted to Acme Issues", "resolved"));
      return res.json({ ...actionReceipt(action.requestId, "applied", String(updated.updatedAt), "Projects created the implementation issue through Acme Issues."), eventId });
    } catch (error) {
      const status = error instanceof IntegrationConflict ? 409 : 502;
      return res.status(status).json(actionReceipt(action.requestId, status === 409 ? "rejected" : "unavailable", String(card.updatedAt), errorMessage(error)));
    }
  });
  app.post("/api/steering/decisions", (req, res) => {
    const notice = parseSteeringDecisionNotice(req.body);
    if (!notice) return res.status(400).json({ error: "Invalid acme.steering.decision.v1 payload" });
    if (notice.actionKey !== "projects.submit_ready_card" || notice.resource.type !== "card") {
      return res.status(400).json({ error: "Unsupported Projects Steering decision" });
    }
    const card = getCard(db, numberId(notice.resource.id));
    if (!card) return res.status(404).json({ error: "Card not found" });
    const receipt = db.transaction(() => {
      const recorded = recordSteeringDecision(db, notice, String(card.updatedAt));
      if (recorded.status === "recorded" || recorded.status === "stale") {
        createComment(db, card.id, {
          author: "Acme Steering",
          body: steeringDecisionComment(notice, recorded.status),
        });
      }
      return recorded;
    })();
    return res.status(receipt.status === "recorded" ? 202 : receipt.status === "already_recorded" ? 200 : 409).json(receipt);
  });
  app.get("/api/steering/decisions", (req, res) => {
    const resourceType = typeof req.query.resourceType === "string" ? req.query.resourceType.trim() : "";
    const resourceId = typeof req.query.resourceId === "string" ? req.query.resourceId.trim() : "";
    if (!resourceType || !resourceId) return res.status(400).json({ error: "resourceType and resourceId are required" });
    return res.json({ items: listSteeringDecisions(db, resourceType, resourceId) });
  });
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
    const card = createCard(db, projectId, {
      title,
      description: text(body.description) ?? "",
      columnId,
    });
    notifySteering(cardNotification(card, "card.created", "Card created"));
    res.status(201).json(card);
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
    notifySteering(cardNotification(
      card,
      `card.moved.${card.columnId}`,
      `Card moved to ${BOARD_COLUMNS.find((column) => column.id === card.columnId)?.name ?? card.columnId}`,
      card.columnId === "ready" ? "open" : "superseded",
    ));
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
      return res.status(409).json({ error: "Set the issues system URL before submitting" });
    }
    if (!project.issuesProjectRef.trim()) {
      return res.status(409).json({ error: "Set the issues system project before submitting" });
    }

    try {
      const { issue, snapshot, triggerLabel, issuesProjectRef } = await createProjectIssue(
        fetchFn,
        project,
        card,
        {
          projectsCallbackUrl: issuesLifecycleWebhookUrl(),
          authToken: issuesToken,
          trustedOrigins: trustedIssuesOrigins,
        },
      );
      const attempt = createImplementationAttempt(db, card.id, {
        issueId: issue.id,
        issueUrl: issue.url,
        issuesUrl: normalizeIssuesUrl(project.issuesUrl),
        issuesProjectRef,
        triggerLabel,
        snapshot,
      });
      const updatedCard = getCard(db, card.id)!;
      notifySteering(cardNotification(updatedCard, "card.issue_submitted", "Ready card submitted to Acme Issues", "resolved"));
      res.status(201).json({ attempt, card: updatedCard });
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
      notifySteering(cardNotification(
        result.card,
        `card.implementation.${payload.event}`,
        `Implementation ${payload.event.replace("implementation.", "").replace("_", " ")}`,
      ));
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
        issuesToken,
        trustedIssuesOrigins,
      );
      withdrawImplementationAttempt(db, attempt.id);
      const updated = moveCard(db, card.id, "exploring", Number.MAX_SAFE_INTEGER);
      if (updated) notifySteering(cardNotification(updated, "card.returned_to_exploration", "Card returned to exploration", "withdrawn"));
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

function cardNotification(
  card: import("./types.js").Card,
  type: string,
  summary: string,
  state?: "open" | "resolved" | "withdrawn" | "superseded",
): SteeringNotification {
  return {
    schemaVersion: "acme.steering.notification.v1",
    id: `acme-projects:card:${card.id}:${type}:${card.updatedAt}`,
    source: { product: "acme-projects", resourceType: "card", resourceId: String(card.id), revision: String(card.updatedAt) },
    event: { type, occurredAt: new Date(card.updatedAt).toISOString(), summary, detail: card.title },
    ...(state ? { steering: {
      caseKey: `card:${card.id}:submit-issue`, state,
      title: `Submit ${card.title} for implementation`,
      action: "projects.submit_ready_card",
      reason: "A Ready card has enough product context for the Issues handoff.",
      proposedAction: "Create the implementation issue through the configured Acme Issues adapter.",
      recommendation: "Submit when the card's decisions and acceptance notes are sufficient.",
      reversible: true, facts: { ready: card.columnId === "ready" },
    } } : {}),
  };
}

function actionReceipt(
  requestId: string,
  status: SteeringActionReceipt["status"],
  sourceRevision: string,
  summary: string,
): SteeringActionReceipt {
  return { schemaVersion: "acme.steering.action-receipt.v1", requestId, status, sourceRevision, summary };
}

function steeringDecisionComment(
  notice: import("./steering.js").SteeringDecisionNotice,
  status: "recorded" | "stale",
): string {
  const resolution = notice.resolution.replaceAll("_", " ");
  return [
    `Steering decision: ${resolution}${status === "stale" ? " (received after the card changed)" : ""}.`,
    notice.rationale ? `Rationale: ${notice.rationale}` : undefined,
    `Decided by ${notice.actor.displayName}. Decision ${notice.decisionId}.`,
    "Acme Projects retains ownership of the next workflow transition.",
  ].filter(Boolean).join("\n\n");
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
