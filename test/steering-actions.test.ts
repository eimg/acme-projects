import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, it } from "node:test";
import request from "supertest";
import { createApp } from "../src/app.js";
import { openDatabase } from "../src/db.js";
import { createCard, createProject } from "../src/store.js";
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
