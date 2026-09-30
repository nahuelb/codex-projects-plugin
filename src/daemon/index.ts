import http from "node:http";
import { readFile, rm, writeFile } from "node:fs/promises";
import { createExclusive } from "../core/fsutil.ts";
import { widenPath } from "../core/env.ts";
import { ensureRoot } from "../core/store.ts";
import { paths } from "../core/paths.ts";
import { VERSION } from "../shared/version.ts";
import { CodexAdapter } from "./adapters/codex.ts";
import { AgentService } from "./service.ts";

widenPath();

const IDLE_EXIT_MS = 6 * 60 * 60 * 1000;

const service = new AgentService({
  codex: (hooks) => new CodexAdapter(hooks, VERSION),
});

const codex = service.codex as CodexAdapter;

let lastRequest = Date.now();

type Handler = (params: any) => Promise<unknown>;

const handlers: Record<string, Handler> = {
  health: async () => ({ version: VERSION, pid: process.pid, running: service.runningCount() }),
  available: () => service.available(),
  "models.list": () => codex.listModels(),
  "workspaces.list": (params) => codex.listWorkspaces(params.exclude ?? []),
  "thread.adopt": (params) => codex.adoptThread(params.threadId, params.name),
  "thread.relocate": (params) => codex.relocateThread(params.threadId, params.cwd, params.name),
  "thread.archive": (params) => codex.archiveThread(params.threadId),
  "agent.start": (params) => service.start(params),
  "agent.send": (params) => service.send(params),
  "agent.stop": (params) => service.stop(params.slug, params.id),
  "agent.review": (params) => service.review(params.slug, params.id),
  "agent.resolve": (params) => service.resolve(params.slug, params.id, Boolean(params.removeWorktree)),
  "agent.reopen": (params) => service.reopen(params.slug, params.id),
  "agent.transcript": (params) => service.transcript(params.slug, params.id),
  "pr.poll": () => service.pollPullRequests(true),
  shutdown: async () => {
    setTimeout(() => void shutdown(0), 50);
    return { ok: true };
  },
};

async function readBody(request: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const server = http.createServer(async (request, response) => {
  lastRequest = Date.now();
  response.setHeader("content-type", "application/json");
  try {
    const { method, params } = JSON.parse(await readBody(request));
    const handler = handlers[method];
    if (!handler) throw new Error(`Unknown method ${method}`);
    response.end(JSON.stringify({ result: await handler(params ?? {}) }));
  } catch (error) {
    response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  }
});

async function shutdown(code: number): Promise<void> {
  server.close();
  await service.dispose().catch(() => undefined);
  await rm(paths.socket(), { force: true });
  await rm(paths.pidFile(), { force: true });
  await rm(paths.lockFile(), { force: true });
  process.exit(code);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function acquireLock(): Promise<boolean> {
  const deadline = Date.now() + 4_000;
  for (;;) {
    if (await createExclusive(paths.lockFile(), `${process.pid}\n`)) return true;
    const owner = Number((await readFile(paths.lockFile(), "utf8").catch(() => "")).trim());
    if (!owner || !alive(owner)) {
      await rm(paths.lockFile(), { force: true });
      continue;
    }
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

await ensureRoot();
if (!(await acquireLock())) {
  console.log(`${new Date().toISOString()} coordd ${VERSION} found another service running; exiting`);
  process.exit(0);
}
await rm(paths.socket(), { force: true });
const recovered = await service.recover();
server.listen(paths.socket(), async () => {
  await writeFile(paths.pidFile(), `${process.pid}\n`);
  console.log(`${new Date().toISOString()} coordd ${VERSION} listening on ${paths.socket()} (recovered ${recovered})`);
});

setInterval(() => {
  void service.pollPullRequests().catch((error) => console.error(new Date().toISOString(), "pr poll", error));
}, 120_000).unref();

setInterval(() => {
  if (service.runningCount() === 0 && Date.now() - lastRequest > IDLE_EXIT_MS) void shutdown(0);
}, 60_000).unref();

process.on("SIGTERM", () => void shutdown(0));
process.on("SIGINT", () => void shutdown(0));
process.on("uncaughtException", (error) => console.error(new Date().toISOString(), "uncaught", error));
process.on("unhandledRejection", (error) => console.error(new Date().toISOString(), "unhandled", error));
