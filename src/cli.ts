#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { openDatabase } from "./db.js";
import { startServer } from "./app.js";
import { DEFAULT_PORT } from "./types.js";

loadEnvFile(resolve(process.cwd(), ".env"));

function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}

function usage(): never {
  console.error(`Usage:
  acme-projects serve [--port <n>] [--host <host>]

Environment:
  ACME_PROJECTS_DATA_DIR  Directory for SQLite database (default: ./data)
  PORT                    Default port if --port is not given`);
  process.exit(2);
}

function parseArgs(args: string[]): { port: number; host: string } {
  let port = Number(process.env.PORT ?? DEFAULT_PORT);
  let host = "127.0.0.1";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port") {
      port = Number(args[++i]);
      if (!Number.isInteger(port) || port <= 0) usage();
    } else if (args[i] === "--host") {
      host = args[++i];
    } else {
      usage();
    }
  }
  return { port, host };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] !== "serve") usage();
  const { port, host } = parseArgs(args.slice(1));
  const db = openDatabase();
  const server = startServer({ db, port, host });
  await new Promise<void>((resolve, reject) => {
    const stop = () => server.close((error) => error ? reject(error) : resolve());
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  db.close();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
