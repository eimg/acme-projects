import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, it } from "node:test";
import request from "supertest";
import { createApp } from "../src/app.js";
import { openDatabase } from "../src/db.js";
import { createCard, createProject, getCard } from "../src/store.js";
import { setPublicBaseUrl } from "../src/publicUrl.js";

let dataDir: string;
let db: ReturnType<typeof openDatabase>;
before(() => { dataDir = mkdtempSync(join(tmpdir(), "projects-steering-")); db = openDatabase(dataDir); setPublicBaseUrl("http://projects.test"); });
after(() => { db.close(); rmSync(dataDir, { recursive: true, force: true }); });

it("applies and deduplicates the Ready-card submission action", async () => {
  const project = createProject(db, { name: "Action test", issuesUrl: "http://issues.test", issuesProjectRef: "default" });
  const card = createCard(db, project.id, { title: "Ready work", columnId: "ready" });
  const fetchFn: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/projects/default" && (!init?.method || init.method === "GET")) {
      return Response.json({ id: 1, slug: "default", labelFilter: "trigger" });
    }
    if (url.pathname === "/api/projects/default/issues" && init?.method === "POST") {
      return Response.json({ issue: { id: 9, title: "Ready work", body: "", status: "open", labels: ["acme-projects"], url: "http://issues.test/9" }, delivery: null }, { status: 201 });
    }
    return Response.json({ error: "unexpected" }, { status: 404 });
  };
  const app = createApp({ db, fetchFn });
  const body = {
    schemaVersion: "acme.steering.action.v1", requestId: "req-1", caseId: "case-1", decisionId: "decision-1",
    actionKey: "projects.submit_ready_card",
    resource: { type: "card", id: String(card.id), expectedRevision: String(card.updatedAt) },
  };
  const applied = await request(app).post("/api/steering/actions").send(body).expect(200);
  assert.equal(applied.body.status, "applied");
  const duplicate = await request(app).post("/api/steering/actions").send(body).expect(200);
  assert.equal(duplicate.body.status, "already_applied");
});

it("records a Steering disposition while Projects retains workflow ownership", async () => {
  const project = createProject(db, { name: "Decision project" });
  const card = createCard(db, project.id, { title: "Revise intent", columnId: "ready" });
  const app = createApp({ db });
  const body = decisionBody("projects.submit_ready_card", "card", String(card.id), String(card.updatedAt));
  await request(app).post("/api/steering/decisions").send(body).expect(202).expect(({ body: receipt }) => assert.equal(receipt.status, "recorded"));
  await request(app).post("/api/steering/decisions").send(body).expect(200).expect(({ body: receipt }) => assert.equal(receipt.status, "already_recorded"));
  const listed = await request(app).get(`/api/steering/decisions?resourceType=card&resourceId=${card.id}`).expect(200);
  assert.equal(listed.body.items[0].resolution, "request_revision");
  assert.equal(getCard(db, card.id)?.columnId, "ready");
  const comments = await request(app).get(`/api/cards/${card.id}/comments`).expect(200);
  assert.equal(comments.body.length, 1);
  assert.match(comments.body[0].body, /Steering decision: request revision/);
  assert.match(comments.body[0].body, /Clarify the acceptance context/);
});

function decisionBody(actionKey: string, type: string, id: string, expectedRevision: string) {
  return {
    schemaVersion: "acme.steering.decision.v1", decisionId: `decision-${id}`, caseId: `case-${id}`,
    actionKey, resolution: "request_revision", rationale: "Clarify the acceptance context.",
    decidedAt: "2026-08-03T00:00:00.000Z",
    actor: { id: "identity:admin", issuer: "acme-identity", username: "admin", displayName: "Administrator", kind: "human" },
    resource: { type, id, expectedRevision },
  };
}
