import { DEFAULT_PORT } from "./types.js";

let publicBaseUrl =
  (process.env.ACME_PROJECTS_BASE_URL ?? `http://127.0.0.1:${DEFAULT_PORT}`).replace(/\/$/, "");

export function setPublicBaseUrl(url: string): void {
  publicBaseUrl = url.replace(/\/$/, "");
}

export function getPublicBaseUrl(): string {
  return publicBaseUrl;
}

export function issuesLifecycleWebhookUrl(): string {
  return `${publicBaseUrl}/api/webhooks/issues`;
}
