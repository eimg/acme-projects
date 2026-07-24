import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import request from "supertest";
import { openDatabase } from "../src/db.js";
import { createApp } from "../src/app.js";

describe("acme-projects API", () => {
  let dataDir: string;
  let db: ReturnType<typeof openDatabase>;
  let app: ReturnType<typeof createApp>;
  let nextRemoteIssueId: number;
  let remoteTriggerLabel: string;
  let remoteIssues: Map<number, {
    id: number;
    title: string;
    body: string;
    status: "open" | "in_progress" | "closed";
    labels: string[];
    url: string;
  }>;

  before(() => {
    dataDir = mkdtempSync(join(tmpdir(), "acme-projects-"));
    db = openDatabase(dataDir);
    nextRemoteIssueId = 100;
    remoteTriggerLabel = "trigger";
    remoteIssues = new Map();
    app = createApp({
      db,
      fetchFn: async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === "/api/config" && (!init?.method || init.method === "GET")) {
          return Response.json({ labelFilter: remoteTriggerLabel });
        }
        if (url.pathname === "/api/issues" && init?.method === "POST") {
          const payload = JSON.parse(String(init.body)) as {
            title: string;
            body: string;
            labels: string[];
          };
          const issue = {
            id: nextRemoteIssueId++,
            title: payload.title,
            body: payload.body,
            status: "open" as const,
            labels: payload.labels,
            url: `http://issues.test/issues/${nextRemoteIssueId - 1}`,
          };
          remoteIssues.set(issue.id, issue);
          return Response.json({ issue, delivery: null }, { status: 201 });
        }
        const match = url.pathname.match(/^\/api\/issues\/(\d+)$/);
        const issue = match ? remoteIssues.get(Number(match[1])) : undefined;
        if (!issue) return Response.json({ error: "Issue not found" }, { status: 404 });
        if (!init?.method || init.method === "GET") return Response.json(issue);
        if (init.method === "PATCH") {
          const payload = JSON.parse(String(init.body)) as { status?: "closed" };
          if (payload.status) issue.status = payload.status;
          return Response.json({ issue, delivery: null });
        }
        return Response.json({ error: "Unsupported request" }, { status: 400 });
      },
    });
  });

  after(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("starts empty and reports health", async () => {
    await request(app).get("/api/health").expect(200, { ok: true });
    await request(app).get("/api/projects").expect(200, []);
  });

  it("adds repository scope to databases created before the project binding", () => {
    const legacyDir = mkdtempSync(join(tmpdir(), "acme-projects-legacy-"));
    const legacyPath = join(legacyDir, "projects.db");
    const legacy = new Database(legacyPath);
    legacy.exec(`
      CREATE TABLE projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO projects (name, description, created_at, updated_at)
      VALUES ('Existing board', '', 1, 1);
    `);
    legacy.close();

    const migrated = openDatabase(legacyDir);
    const project = migrated.prepare("SELECT * FROM projects WHERE id = 1").get() as {
      repository_path: string;
      issues_url: string;
    };
    assert.equal(project.repository_path, "");
    assert.equal(project.issues_url, "");
    migrated.close();
    rmSync(legacyDir, { recursive: true, force: true });
  });

  it("creates and updates a project", async () => {
    const created = await request(app)
      .post("/api/projects")
      .send({
        name: "Customer workspace",
        description: "Explore shared customer context",
        repositoryPath: "/workspace/customer-app",
      })
      .expect(201);

    assert.equal(created.body.name, "Customer workspace");
    assert.equal(created.body.description, "Explore shared customer context");
    assert.equal(created.body.repositoryPath, "/workspace/customer-app");

    const updated = await request(app)
      .patch(`/api/projects/${created.body.id}`)
      .send({ name: "Customer home", repositoryPath: "/workspace/customer-home" })
      .expect(200);

    assert.equal(updated.body.name, "Customer home");
    assert.equal(updated.body.description, "Explore shared customer context");
    assert.equal(updated.body.repositoryPath, "/workspace/customer-home");
  });

  it("returns the six fixed collaboration stages", async () => {
    const project = await createTestProject("Stages");
    const board = await request(app).get(`/api/projects/${project.id}/board`).expect(200);
    assert.deepEqual(
      board.body.columns.map((column: { id: string }) => column.id),
      ["ideas", "exploring", "ready", "in_progress", "in_review", "done"],
    );
  });

  it("creates cards and preserves collaboration fields", async () => {
    const project = await createTestProject("Card fields");
    const created = await request(app)
      .post(`/api/projects/${project.id}/cards`)
      .send({
        title: "Shared notes",
        description: "Let customers collect context",
        columnId: "exploring",
      })
      .expect(201);

    assert.equal(created.body.columnId, "exploring");
    assert.equal(created.body.position, 0);

    const updated = await request(app)
      .patch(`/api/cards/${created.body.id}`)
      .send({
        decisions: "Use a single shared space",
        openQuestions: "How should access work?",
        acceptanceNotes: "Two people can contribute",
      })
      .expect(200);

    assert.equal(updated.body.decisions, "Use a single shared space");
    assert.equal(updated.body.openQuestions, "How should access work?");
    assert.equal(updated.body.acceptanceNotes, "Two people can contribute");
    assert.equal("targetRepository" in updated.body, false);
  });

  it("moves and reorders cards without duplicating positions", async () => {
    const project = await createTestProject("Movement");
    const one = await createTestCard(project.id, "One", "ideas");
    const two = await createTestCard(project.id, "Two", "ideas");
    const three = await createTestCard(project.id, "Three", "ready");

    await request(app)
      .post(`/api/cards/${two.id}/move`)
      .send({ columnId: "ready", index: 0 })
      .expect(200);
    await request(app)
      .post(`/api/cards/${one.id}/move`)
      .send({ columnId: "ready", index: 1 })
      .expect(200);

    const board = await request(app).get(`/api/projects/${project.id}/board`).expect(200);
    const ready = board.body.columns.find((column: { id: string }) => column.id === "ready");
    assert.deepEqual(ready.cards.map((card: { title: string }) => card.title), ["Two", "One", "Three"]);
    assert.deepEqual(ready.cards.map((card: { position: number }) => card.position), [0, 1, 2]);
    assert.equal(board.body.columns.find((column: { id: string }) => column.id === "ideas").cards.length, 0);
  });

  it("adds discussion and reflects comment count on the board", async () => {
    const project = await createTestProject("Discussion");
    const card = await createTestCard(project.id, "Explore permissions", "exploring");
    const comment = await request(app)
      .post(`/api/cards/${card.id}/comments`)
      .send({ author: "Maya", body: "Could this start with project-level access?" })
      .expect(201);

    assert.equal(comment.body.author, "Maya");

    const comments = await request(app).get(`/api/cards/${card.id}/comments`).expect(200);
    assert.equal(comments.body.length, 1);

    const board = await request(app).get(`/api/projects/${project.id}/board`).expect(200);
    const exploring = board.body.columns.find((column: { id: string }) => column.id === "exploring");
    assert.equal(exploring.cards[0].commentCount, 1);

    await request(app)
      .delete(`/api/cards/${card.id}/comments/${comment.body.id}`)
      .expect(204);
  });

  it("validates required names, titles, columns, and comments", async () => {
    await request(app).post("/api/projects").send({ name: " " }).expect(400);
    const project = await createTestProject("Validation");
    await request(app).post(`/api/projects/${project.id}/cards`).send({ title: "" }).expect(400);
    const card = await createTestCard(project.id, "Valid", "ideas");
    await request(app)
      .post(`/api/cards/${card.id}/move`)
      .send({ columnId: "shipping" })
      .expect(400);
    await request(app)
      .post(`/api/cards/${card.id}/move`)
      .send({ columnId: "in_progress" })
      .expect(409);
    await request(app)
      .post(`/api/projects/${project.id}/cards`)
      .send({ title: "Impossible", columnId: "done" })
      .expect(400);
    await request(app)
      .post(`/api/cards/${card.id}/comments`)
      .send({ body: " " })
      .expect(400);
  });

  it("submits a Ready card as a non-triggering issue and coordinates withdrawal", async () => {
    const project = await request(app)
      .post("/api/projects")
      .send({
        name: "Integrated project",
        repositoryPath: "/workspace/product",
        issuesUrl: "http://issues.test",
      })
      .expect(201);
    const card = await createTestCard(project.body.id, "Shared customer notes", "ideas");
    await request(app)
      .post(`/api/cards/${card.id}/move`)
      .send({ columnId: "ready", index: 0 })
      .expect(200);

    const submitted = await request(app)
      .post(`/api/cards/${card.id}/submit-issue`)
      .expect(201);

    const issueId = submitted.body.attempt.issueId as number;
    const issue = remoteIssues.get(issueId)!;
    assert.deepEqual(issue.labels, ["acme-projects"]);
    assert.doesNotMatch(issue.labels.join(" "), /trigger/);
    assert.match(issue.title, /Integrated project/);
    assert.match(issue.body, /Repository: \/workspace\/product/);
    assert.match(issue.body, /ACM-/);
    assert.equal(submitted.body.card.columnId, "ready");
    assert.equal(submitted.body.attempt.triggerLabel, "trigger");
    assert.equal(submitted.body.attempt.issueUrl, `http://issues.test/?issue=${issueId}`);
    assert.equal(submitted.body.card.activeImplementation.issueId, issueId);

    await request(app).post(`/api/cards/${card.id}/submit-issue`).expect(409);
    await request(app)
      .post(`/api/cards/${card.id}/move`)
      .send({ columnId: "exploring", index: 0 })
      .expect(409);
    await request(app).delete(`/api/cards/${card.id}`).expect(409);
    await request(app).delete(`/api/projects/${project.body.id}`).expect(409);

    const returned = await request(app)
      .post(`/api/cards/${card.id}/return-to-exploration`)
      .expect(200);

    assert.equal(remoteIssues.get(issueId)?.status, "closed");
    assert.equal(returned.body.card.columnId, "exploring");
    assert.equal(returned.body.card.activeImplementation, undefined);

    const attempts = await request(app)
      .get(`/api/cards/${card.id}/implementation-attempts`)
      .expect(200);
    assert.equal(attempts.body.length, 1);
    assert.equal(attempts.body[0].status, "withdrawn");
  });

  it("does not withdraw an issue after a human adds the trigger label", async () => {
    remoteTriggerLabel = "ship";
    const project = await request(app)
      .post("/api/projects")
      .send({
        name: "Triggered project",
        repositoryPath: "/workspace/triggered",
        issuesUrl: "http://issues.test",
      })
      .expect(201);
    const card = await createTestCard(project.body.id, "Authorized work", "ready");
    const submitted = await request(app)
      .post(`/api/cards/${card.id}/submit-issue`)
      .expect(201);
    const issueId = submitted.body.attempt.issueId as number;
    assert.equal(submitted.body.attempt.triggerLabel, "ship");
    remoteIssues.get(issueId)!.labels.push("ship");

    const response = await request(app)
      .post(`/api/cards/${card.id}/return-to-exploration`)
      .expect(409);

    assert.match(response.body.error, /ship label/);
    assert.equal(remoteIssues.get(issueId)?.status, "open");
    const current = await request(app).get(`/api/cards/${card.id}`).expect(200);
    assert.equal(current.body.columnId, "ready");
    assert.equal(current.body.activeImplementation.issueId, issueId);
    remoteTriggerLabel = "trigger";
  });

  it("refuses a configuration where the origin label would trigger delivery", async () => {
    remoteTriggerLabel = "acme-projects";
    const project = await request(app)
      .post("/api/projects")
      .send({
        name: "Unsafe project",
        repositoryPath: "/workspace/unsafe",
        issuesUrl: "http://issues.test",
      })
      .expect(201);
    const card = await createTestCard(project.body.id, "Unsafe handoff", "ready");
    const issueCount = remoteIssues.size;

    const response = await request(app)
      .post(`/api/cards/${card.id}/submit-issue`)
      .expect(409);

    assert.match(response.body.error, /different trigger label/);
    assert.equal(remoteIssues.size, issueCount);
    remoteTriggerLabel = "trigger";
  });

  it("deleting a project cascades to cards and discussion", async () => {
    const project = await createTestProject("Temporary");
    const card = await createTestCard(project.id, "Temporary card", "ideas");
    await request(app)
      .post(`/api/cards/${card.id}/comments`)
      .send({ body: "Temporary thought" })
      .expect(201);

    await request(app).delete(`/api/projects/${project.id}`).expect(204);
    await request(app).get(`/api/projects/${project.id}/board`).expect(404);
    await request(app).get(`/api/cards/${card.id}`).expect(404);
  });

  async function createTestProject(name: string): Promise<{ id: number }> {
    const response = await request(app).post("/api/projects").send({ name }).expect(201);
    return response.body as { id: number };
  }

  async function createTestCard(
    projectId: number,
    title: string,
    columnId: string,
  ): Promise<{ id: number }> {
    const response = await request(app)
      .post(`/api/projects/${projectId}/cards`)
      .send({ title, columnId })
      .expect(201);
    return response.body as { id: number };
  }
});
