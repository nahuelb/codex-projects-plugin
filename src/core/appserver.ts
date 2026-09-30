import { spawn } from "node:child_process";
import readline from "node:readline";

type Json = any;

export type OneShotCall = <T = Json>(method: string, params: unknown, timeoutMs?: number) => Promise<T>;

export type OneShotWait = (method: string, match: (params: Json) => boolean, timeoutMs: number) => Promise<Json>;

export async function withAppServer<T>(binary: string, version: string, work: (call: OneShotCall, wait: OneShotWait) => Promise<T>): Promise<T> {
  const child = spawn(binary, ["app-server", "--listen", "stdio://"], { stdio: ["pipe", "pipe", "pipe"], env: process.env });
  const pending = new Map<number, { resolve: (value: Json) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  let nextId = 0;
  const waiters = new Set<{ method: string; match: (params: Json) => boolean; resolve: (params: Json) => void }>();
  const fail = (error: Error) => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  };
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });
  child.stderr.resume();
  child.on("error", fail);
  child.on("exit", (code) => fail(new Error(`Codex app-server exited (${code ?? "signal"}).`)));
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    let message: Json;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id == null && typeof message.method === "string") {
      for (const waiter of waiters) {
        if (waiter.method !== message.method || !waiter.match(message.params ?? {})) continue;
        waiters.delete(waiter);
        waiter.resolve(message.params ?? {});
      }
      return;
    }
    const entry = message.id != null ? pending.get(message.id) : undefined;
    if (!entry || !("result" in message || "error" in message)) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(message.error.message ?? "Codex request failed"));
    else entry.resolve(message.result);
  });
  const call: OneShotCall = (method, params, timeoutMs = 60_000) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Codex ${method} timed out`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  try {
    await call("initialize", { clientInfo: { name: "codex-projects-plugin", title: "Project Coordinator", version }, capabilities: null }, 30_000);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized" })}\n`);
    const wait: OneShotWait = (method, match, timeoutMs) =>
      new Promise((resolve, reject) => {
        const waiter = { method, match, resolve: (params: Json) => { clearTimeout(timer); resolve(params); } };
        const timer = setTimeout(() => {
          waiters.delete(waiter);
          reject(new Error(`Codex did not finish ${method} in time`));
        }, timeoutMs);
        waiters.add(waiter);
      });
    return await work(call, wait);
  } finally {
    child.kill();
    const forced = setTimeout(() => child.kill("SIGKILL"), 3_000);
    await exited;
    clearTimeout(forced);
  }
}
