import type { Card, Project } from "./types.js";

export type FetchFn = typeof fetch;

interface AcmeIssue {
  id: number;
  title: string;
  body: string;
  status: "open" | "in_progress" | "closed";
  labels: string[];
  url: string;
  projectId?: number;
}

interface IssueResponse {
  issue: AcmeIssue;
  delivery: unknown;
}

interface IssuesProject {
  id: number;
  slug: string;
  labelFilter: string;
}

export async function createProjectIssue(
  fetchFn: FetchFn,
  project: Project,
  card: Card,
): Promise<{ issue: AcmeIssue; snapshot: string; triggerLabel: string; issuesProjectRef: string }> {
  const baseUrl = normalizeIssuesUrl(project.issuesUrl);
  const projectRef = normalizeIssuesProjectRef(project.issuesProjectRef);
  const issuesProject = await readIssuesProject(
    await fetchFn(issuesProjectUrl(baseUrl, projectRef)),
  );
  if (issuesProject.labelFilter === "acme-projects") {
    throw new IntegrationConflict(
      "Acme Issues uses acme-projects as its trigger label. Choose a different trigger label before submitting.",
    );
  }
  const snapshot = formatImplementationSnapshot(project, card, issuesProject);
  const response = await fetchFn(issuesProjectUrl(baseUrl, projectRef, "/issues"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: `[${project.name}] ${card.title}`,
      body: snapshot,
      labels: ["acme-projects"],
      status: "open",
    }),
  });
  const result = await readIssueResponse(response, "create issue");
  if (result.delivery !== null) {
    throw new Error("Acme Issues unexpectedly triggered delivery for a non-triggering issue");
  }
  return {
    issue: {
      ...result.issue,
      url: issueDeepLink(baseUrl, issuesProject.slug, result.issue),
    },
    snapshot,
    triggerLabel: issuesProject.labelFilter,
    issuesProjectRef: issuesProject.slug,
  };
}

export async function withdrawProjectIssue(
  fetchFn: FetchFn,
  issuesUrl: string,
  issuesProjectRef: string,
  issueId: number,
  triggerLabel: string,
): Promise<AcmeIssue> {
  const baseUrl = normalizeIssuesUrl(issuesUrl);
  const projectRef = normalizeIssuesProjectRef(issuesProjectRef);
  const currentResponse = await fetchFn(
    issuesProjectUrl(baseUrl, projectRef, `/issues/${issueId}`),
  );
  const current = await readIssue(currentResponse, "read issue");
  if (current.labels.includes(triggerLabel)) {
    throw new IntegrationConflict(
      `This issue already has the ${triggerLabel} label and can no longer return to exploration.`,
    );
  }
  if (current.status !== "open") {
    throw new IntegrationConflict(
      `Only an open, untriggered issue can return to exploration (current status: ${current.status}).`,
    );
  }

  const response = await fetchFn(issuesProjectUrl(baseUrl, projectRef, `/issues/${issueId}`), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "closed" }),
  });
  return (await readIssueResponse(response, "close issue")).issue;
}

export class IntegrationConflict extends Error {}

export function normalizeIssuesUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Acme Issues URL must be a valid HTTP URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Acme Issues URL must use http or https");
  }
  return url.toString().replace(/\/$/, "");
}

export function normalizeIssuesProjectRef(value: string): string {
  const ref = value.trim();
  if (!ref) {
    throw new Error("Acme Issues project slug or id is required");
  }
  if (ref.includes("/") || ref.includes("?")) {
    throw new Error("Acme Issues project ref must be a slug or numeric id");
  }
  return ref;
}

function issuesProjectUrl(baseUrl: string, projectRef: string, suffix = ""): string {
  const encoded = encodeURIComponent(projectRef);
  const path = suffix.startsWith("/") ? suffix : suffix ? `/${suffix}` : "";
  return `${baseUrl}/api/projects/${encoded}${path}`;
}

function issueDeepLink(baseUrl: string, projectSlug: string, issue: AcmeIssue): string {
  if (issue.url.includes("project=")) return issue.url;
  return `${baseUrl}/?project=${encodeURIComponent(projectSlug)}&issue=${issue.id}`;
}

function formatImplementationSnapshot(
  project: Project,
  card: Card,
  issuesProject: IssuesProject,
): string {
  const sections = [
    "Generated from Acme Projects.",
    "",
    `Source: ${project.name} / ACM-${card.id}`,
    `Issues project: ${issuesProject.slug} (#${issuesProject.id})`,
  ];
  if (project.repositoryPath.trim()) {
    sections.push(`Repository: ${project.repositoryPath}`);
  }
  sections.push("", "## Implementation brief", card.description || card.title);
  if (card.decisions) sections.push("", "## Decisions", card.decisions);
  if (card.openQuestions) sections.push("", "## Open questions", card.openQuestions);
  if (card.acceptanceNotes) sections.push("", "## Acceptance notes", card.acceptanceNotes);
  return sections.join("\n");
}

async function readIssueResponse(response: Response, action: string): Promise<IssueResponse> {
  const body = await readJson(response, action) as Partial<IssueResponse>;
  if (!body.issue) throw new Error(`Acme Issues returned an invalid response while trying to ${action}`);
  return { issue: validateIssue(body.issue, action), delivery: body.delivery ?? null };
}

async function readIssue(response: Response, action: string): Promise<AcmeIssue> {
  return validateIssue(await readJson(response, action), action);
}

async function readIssuesProject(response: Response): Promise<IssuesProject> {
  const value = await readJson(response, "read Acme Issues project");
  if (
    !value ||
    typeof value !== "object" ||
    typeof (value as { id?: unknown }).id !== "number" ||
    typeof (value as { slug?: unknown }).slug !== "string" ||
    !(value as { slug: string }).slug.trim() ||
    typeof (value as { labelFilter?: unknown }).labelFilter !== "string" ||
    !(value as { labelFilter: string }).labelFilter.trim()
  ) {
    throw new Error("Acme Issues returned an invalid project configuration");
  }
  const project = value as { id: number; slug: string; labelFilter: string };
  return {
    id: project.id,
    slug: project.slug.trim(),
    labelFilter: project.labelFilter.trim(),
  };
}

async function readJson(response: Response, action: string): Promise<unknown> {
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message = body && typeof body === "object" && "error" in body
      ? String((body as { error: unknown }).error)
      : `${response.status} ${response.statusText}`;
    throw new Error(`Could not ${action}: ${message}`);
  }
  return body;
}

function validateIssue(value: unknown, action: string): AcmeIssue {
  if (
    !value ||
    typeof value !== "object" ||
    typeof (value as Partial<AcmeIssue>).id !== "number" ||
    typeof (value as Partial<AcmeIssue>).url !== "string" ||
    !Array.isArray((value as Partial<AcmeIssue>).labels) ||
    typeof (value as Partial<AcmeIssue>).status !== "string"
  ) {
    throw new Error(`Acme Issues returned an invalid issue while trying to ${action}`);
  }
  return value as AcmeIssue;
}
