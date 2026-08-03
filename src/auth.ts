import type { NextFunction, Request, RequestHandler, Response } from "express";
import {
  DEV_USER_HEADER,
  hasAnyPermission,
  hasPermission,
  IdentityClientError,
  resolveConsumerAuthMode,
  resolvePrincipal,
  type AuthMode,
  type Principal,
  type ResolveOptions,
} from "acme-identity/client";

export type PrincipalResolver = (options: ResolveOptions) => Promise<Principal>;
export type AuthLocals = { principal?: Principal };

const PROJECTS_CAPABILITIES = ["projects.read", "projects.write"];

export function authMode(): AuthMode {
  return resolveConsumerAuthMode();
}

export function authenticateRequests(
  resolver: PrincipalResolver = resolvePrincipal,
  mode: AuthMode = authMode(),
): RequestHandler {
  return async (req, res, next) => {
    try {
      (res.locals as AuthLocals).principal = await resolver({
        authMode: mode,
        authorization: req.headers.authorization,
        cookie: req.headers.cookie,
        devUser: header(req, DEV_USER_HEADER),
      });
      next();
    } catch (error) {
      identityError(res, error);
    }
  };
}

export function authorizeProjectsRequest(req: Request, res: Response, next: NextFunction): void {
  const principal = (res.locals as AuthLocals).principal;
  if (!principal) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  if (req.method === "GET" || req.method === "HEAD") {
    if (hasAnyPermission(principal, PROJECTS_CAPABILITIES)) {
      next();
      return;
    }
    res.status(403).json({ error: "Missing permission: projects.read or projects.write" });
    return;
  }
  if (req.method === "POST" && req.path === "/steering/actions") {
    if (hasPermission(principal, "projects.steering.submit")) {
      next();
      return;
    }
    res.status(403).json({ error: "Missing permission: projects.steering.submit" });
    return;
  }
  if (!hasPermission(principal, "projects.write")) {
    res.status(403).json({ error: "Missing permission: projects.write" });
    return;
  }
  next();
}

export function principalFrom(res: Response): Principal {
  return (res.locals as AuthLocals).principal!;
}

export function identityError(res: Response, error: unknown): void {
  const unavailable = error instanceof IdentityClientError && error.code === "unavailable";
  const config = error instanceof IdentityClientError && error.code === "config";
  res.status(unavailable || config ? 503 : 401).json({
    error: error instanceof Error ? error.message : "Authentication required",
  });
}

export function sameOriginWrites(): RequestHandler {
  return (req, res, next) => {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
      next();
      return;
    }
    const site = req.headers["sec-fetch-site"];
    if (site === "same-origin" || site === "none") {
      next();
      return;
    }
    const origin = req.headers.origin;
    if (!origin) {
      next();
      return;
    }
    const expected = `${req.protocol}://${req.headers.host ?? ""}`;
    if (origin.replace(/\/$/, "") === expected) {
      next();
      return;
    }
    res.status(403).json({ error: "Cross-origin request blocked" });
  };
}

function header(req: Request, name: string): string | undefined {
  const value = req.headers[name];
  return (Array.isArray(value) ? value[0] : value)?.trim() || undefined;
}
