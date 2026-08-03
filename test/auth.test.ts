import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { IdentityClientError, type Principal, type ResolveOptions } from "acme-identity/client";
import { createApp } from "../src/app.js";
import { openDatabase } from "../src/db.js";
import { createCard, createProject } from "../src/store.js";

const HEADER = "x-acme-dev-user";

describe("Acme Projects identity permissions", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "acme-projects-auth-"));
  const db = openDatabase(dataDir);
  const outboundAuthorization: Array<string | null> = [];
  const principals: Record<string, string[]> = {
    admin: ["*"],
    viewer: ["projects.read"],
    member: ["projects.write"],
    custom: ["projects.*"],
    unrelated: ["issues.write"],
    steering: ["projects.steering.submit"],
    receiver: ["projects.steering.receive"],
  };
  const principalResolver = async (options: ResolveOptions): Promise<Principal> => {
    const username = options.devUser ?? "admin";
    if (username === "signed-out") {
      throw new IdentityClientError("Authentication required", "unauthenticated");
    }
    if (username === "outage") {
      throw new IdentityClientError("Identity service unreachable", "unavailable");
    }
    return principal(username, principals[username] ?? []);
  };
  const app = createApp({
    db,
    principalResolver,
    authMode: "off",
    issuesToken: "svc_projects_test",
    trustedIssuesOrigins: ["http://issues.test"],
    fetchFn: async (_input, init) => {
      outboundAuthorization.push(new Headers(init?.headers).get("authorization"));
      if (!init?.method || init.method === "GET") {
        return Response.json({ id: 1, title: "Issues", slug: "default", labelFilter: "trigger" });
      }
      return Response.json({
        issue: {
          id: 77,
          projectId: 1,
          title: "Linked issue",
          body: "Snapshot",
          status: "open",
          labels: ["acme-projects"],
          url: "http://issues.test/?project=default&issue=77",
        },
        delivery: null,
      }, { status: 201 });
    },
    identityFetchFn: async (_input, init) => new Response(
      JSON.stringify(init?.method === "DELETE"
        ? { signedOut: true }
        : { principal: principal("member", principals.member) }),
      {
        status: init?.method === "DELETE" ? 200 : 201,
        headers: {
          "content-type": "application/json",
          "set-cookie": "acme_identity_session=sess_test; HttpOnly; SameSite=Lax; Path=/",
        },
      },
    ),
  });
  let projectId: number;
  let readyCardId: number;

  before(() => {
    const project = createProject(db, {
      name: "Permission test",
      issuesUrl: "http://issues.test",
      issuesProjectRef: "default",
    });
    projectId = project.id;
    readyCardId = createCard(db, project.id, { title: "Ready work", columnId: "ready" }).id;
  });

  after(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("requires a principal, fails closed on identity outages, and leaves health public", async () => {
    await request(app).get("/api/projects").set(HEADER, "signed-out").expect(401);
    await request(app).get("/api/projects").set(HEADER, "outage").expect(503);
    await request(app).get("/api/health").set(HEADER, "signed-out").expect(200);
  });

  it("lets readers inspect boards but requires projects.write for mutations", async () => {
    await request(app).get(`/api/projects/${projectId}/board`).set(HEADER, "viewer").expect(200);
    const blocked = await request(app)
      .post(`/api/projects/${projectId}/cards`)
      .set(HEADER, "viewer")
      .send({ title: "Viewer cannot create" })
      .expect(403);
    assert.match(blocked.body.error, /projects\.write/);

    await request(app)
      .post(`/api/projects/${projectId}/cards`)
      .set(HEADER, "member")
      .send({ title: "Member can create" })
      .expect(201);
  });

  it("supports future namespace roles and rejects unrelated permissions", async () => {
    await request(app)
      .post(`/api/projects/${projectId}/cards`)
      .set(HEADER, "custom")
      .send({ title: "Future role" })
      .expect(201);
    await request(app).get("/api/projects").set(HEADER, "unrelated").expect(403);
  });

  it("proxies browser sessions and blocks cross-origin writes", async () => {
    const signedIn = await request(app)
      .post("/api/auth/session")
      .send({ username: "member", password: "member" })
      .expect(201);
    assert.match(String(signedIn.headers["set-cookie"]), /acme_identity_session=sess_test/);
    await request(app)
      .post("/api/auth/session")
      .set("origin", "https://malicious.example")
      .send({ username: "member", password: "member" })
      .expect(403);
  });

  it("requires projects.write for Issues lifecycle callbacks", async () => {
    await request(app)
      .post("/api/webhooks/issues")
      .set(HEADER, "signed-out")
      .send({ event: "invalid" })
      .expect(401);
    await request(app)
      .post("/api/webhooks/issues")
      .set(HEADER, "member")
      .send({ event: "invalid" })
      .expect(400);
  });

  it("keeps the Steering submission credential narrower than ordinary board writes", async () => {
    const action = {
      schemaVersion: "acme.steering.action.v1", requestId: "auth-test", caseId: "case", decisionId: "decision",
      actionKey: "projects.submit_ready_card", resource: { type: "card", id: "9999", expectedRevision: "1" },
    };
    await request(app).post("/api/steering/actions").set(HEADER, "member").send(action).expect(403);
    await request(app).post("/api/steering/actions").set(HEADER, "steering").send(action).expect(404);
    await request(app).post(`/api/projects/${projectId}/cards`).set(HEADER, "steering").send({ title: "No broad write" }).expect(403);
    await request(app).post("/api/steering/decisions").set(HEADER, "steering").send({}).expect(403);
    await request(app).post("/api/steering/decisions").set(HEADER, "receiver").send({}).expect(400);
    await request(app).post("/api/steering/actions").set(HEADER, "receiver").send(action).expect(403);
  });

  it("forwards the configured service token to authenticated Acme Issues", async () => {
    outboundAuthorization.length = 0;
    await request(app)
      .post(`/api/cards/${readyCardId}/submit-issue`)
      .set(HEADER, "member")
      .expect(201);
    assert.deepEqual(outboundAuthorization, ["Bearer svc_projects_test", "Bearer svc_projects_test"]);
  });

  it("does not send the service token to an untrusted Issues origin", async () => {
    const project = (await request(app).post("/api/projects").set(HEADER, "member").send({
      name: "Untrusted",
      issuesUrl: "https://attacker.example",
      issuesProjectRef: "default",
    }).expect(201)).body as { id: number };
    const card = (await request(app).post(`/api/projects/${project.id}/cards`).set(HEADER, "member").send({
      title: "Do not leak",
      columnId: "ready",
    }).expect(201)).body as { id: number };
    outboundAuthorization.length = 0;
    const response = await request(app)
      .post(`/api/cards/${card.id}/submit-issue`)
      .set(HEADER, "member")
      .expect(502);
    assert.match(response.body.error, /untrusted origin/);
    assert.deepEqual(outboundAuthorization, []);
  });
});

function principal(username: string, permissions: string[]): Principal {
  return {
    schemaVersion: "acme.principal.v1",
    sub: `dev:${username}`,
    iss: "acme-identity",
    username,
    displayName: username,
    email: `${username}@acme.local`,
    roles: [username],
    permissions,
    kind: "dev",
    authMode: "off",
  };
}
