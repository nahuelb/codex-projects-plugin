import http from "node:http";
import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureRoot } from "../core/store.ts";
import { paths } from "../core/paths.ts";
import { VERSION } from "../shared/version.ts";

export interface Health {
  version: string;
  pid: number;
  running: number;
}

function post<T>(method: string, params: unknown, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const request = http.request({ socketPath: paths.socket(), path: "/rpc", method: "POST", headers: { "content-type": "application/json" }, timeout: timeoutMs }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (body.error) reject(new Error(body.error));
          else resolve(body.result as T);
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on("timeout", () => request.destroy(new Error(`Project Coordinator service did not answer ${method} in time.`)));
    request.on("error", reject);
    request.end(JSON.stringify({ method, params }));
  });
}

function daemonScript(): string {
  return process.env.PROJECTS_DAEMON_SCRIPT || path.join(path.dirname(fileURLToPath(import.meta.url)), "daemon.js");
}

async function health(): Promise<Health | undefined> {
  try {
    return await post<Health>("health", {}, 2_000);
  } catch {
    return undefined;
  }
}

function launch(): void {
  const log = openSync(paths.daemonLog(), "a");
  const child = spawn(process.execPath, [daemonScript()], { detached: true, stdio: ["ignore", log, log], env: process.env });
  child.unref();
}

let starting: Promise<Health> | undefined;

export function ensureDaemon(): Promise<Health> {
  starting ??= (async () => {
    await ensureRoot();
    let current = await health();
    if (current && current.version !== VERSION && current.running === 0) {
      await post("shutdown", {}, 2_000).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 300));
      current = undefined;
    }
    if (current) return current;
    launch();
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      current = await health();
      if (current) return current;
    }
    throw new Error(`The Project Coordinator service did not start. See ${paths.daemonLog()}.`);
  })().finally(() => {
    starting = undefined;
  });
  return starting;
}

export async function callDaemon<T>(method: string, params: unknown = {}, timeoutMs = 120_000): Promise<T> {
  await ensureDaemon();
  return post<T>(method, params, timeoutMs);
}

export async function daemonStatus(): Promise<{ running: boolean; pid?: number; version?: string; error?: string }> {
  const current = await health();
  return current ? { running: true, pid: current.pid, version: current.version } : { running: false };
}
