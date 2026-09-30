import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.PROJECTS_COORDINATOR_HOME = await mkdtemp(path.join(os.tmpdir(), "pc-board-"));
process.env.CODEX_HOME = await mkdtemp(path.join(os.tmpdir(), "pc-codex-"));

const store = await import("../src/core/store.ts");
const board = await import("../src/core/board.ts");
const rollout = await import("../src/core/rollout.ts");

function threadId(): string {
  const hex = Date.now().toString(16).padStart(12, "0");
  const tail = Math.random().toString(16).slice(2).padEnd(12, "0").slice(0, 12);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7000-8000-${tail}`;
}

async function rolloutFile(id: string): Promise<string> {
  const now = new Date();
  const dir = path.join(process.env.CODEX_HOME!, "sessions", String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0"));
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-01-01T00-00-00-${id}.jsonl`);
  await writeFile(file, "");
  return file;
}

const line = (entry: unknown) => `${JSON.stringify({ timestamp: new Date().toISOString(), ...(entry as object) })}\n`;
const activity = (kind: string, agentThreadId: string, agentPath: string) =>
  line({ type: "event_msg", payload: { type: "item_completed", item: { type: "SubAgentActivity", kind, agent_thread_id: agentThreadId, agent_path: agentPath }, completed_at_ms: Date.now() } });

test("the board follows a native subagent from start to report", async () => {
  const coordinator = threadId();
  const parentFile = await rolloutFile(coordinator);
  const project = await store.createProject({ name: "Board Sync" });
  await store.updateProject(project.slug, { coordinatorThreadId: coordinator });
  const agent = await board.prepareAgent({ slug: project.slug, title: "Cache users", task: "Add a cache to /users." });
  assert.equal(agent.status, "prepared");
  assert.equal(agent.taskName, "a001_cache_users");
  assert.equal(store.agentGroup(agent), "working");

  const child = threadId();
  const childFile = await rolloutFile(child);
  await appendFile(childFile, line({ type: "session_meta", payload: { agent_nickname: "Rawls" } }));
  await appendFile(childFile, line({ type: "event_msg", payload: { type: "task_started", started_at: Math.floor(Date.now() / 1000) } }));
  await appendFile(childFile, line({ type: "event_msg", payload: { type: "item_completed", item: { type: "CommandExecution", command: ["zsh", "-lc", "pnpm test"] } } }));
  await appendFile(parentFile, activity("started", child, `/root/${agent.taskName}`));

  assert.equal(await board.syncProject(project.slug), 1);
  let saved = await store.getAgent(project.slug, agent.id);
  assert.equal(saved.status, "working");
  assert.equal(saved.threadId, child);
  assert.equal(saved.nickname, "Rawls");
  assert.equal(saved.activity, "Ran pnpm test");

  const report = "Cached /users.\nPR: https://github.com/acme/api/pull/7\n## Report\nCached /users with a 60s TTL.\n## Next\n- Merge the PR";
  await new Promise((resolve) => setTimeout(resolve, 5));
  await appendFile(childFile, line({ type: "event_msg", payload: { type: "item_completed", item: { type: "AgentMessage", content: [{ type: "Text", text: report }] }, completed_at_ms: Date.now() } }));
  await appendFile(childFile, line({ type: "event_msg", payload: { type: "task_complete" } }));
  await appendFile(parentFile, activity("completed", child, `/root/${agent.taskName}`));

  await board.syncProject(project.slug);
  saved = await store.getAgent(project.slug, agent.id);
  assert.equal(saved.status, "idle");
  assert.equal(saved.report?.pr, "https://github.com/acme/api/pull/7");
  assert.deepEqual(saved.report?.next, ["Merge the PR"]);
  assert.equal(store.agentGroup(saved), "review");
  const inbox = await store.listInbox(project.slug);
  assert.equal(inbox.at(-1)?.kind, "agent_done");
  assert.equal(await board.syncProject(project.slug), 0);

  await new Promise((resolve) => setTimeout(resolve, 5));
  await appendFile(childFile, line({ type: "event_msg", payload: { type: "task_started", started_at: Math.floor(Date.now() / 1000) + 1 } }));
  await appendFile(childFile, line({ type: "event_msg", payload: { type: "item_completed", item: { type: "AgentMessage", content: [{ type: "Text", text: "## Report\nBlocked.\n## Needs you\nWhich Redis host?" }] }, completed_at_ms: Date.now() + 2000 } }));
  await appendFile(childFile, line({ type: "event_msg", payload: { type: "task_complete" }, timestamp: new Date(Date.now() + 3000).toISOString() }));
  await board.syncProject(project.slug);
  saved = await store.getAgent(project.slug, agent.id);
  assert.equal(saved.status, "waiting");
  assert.equal(store.agentGroup(saved), "needs_you");
});

test("tasks the coordinator has not spawned stay prepared and age out of Working", async () => {
  const project = await store.createProject({ name: "Never Spawned" });
  await store.updateProject(project.slug, { coordinatorThreadId: threadId() });
  const agent = await board.prepareAgent({ slug: project.slug, title: "Idle task", task: "Nothing." });
  assert.equal(await board.syncProject(project.slug), 0);
  assert.equal(store.agentGroup({ ...agent, createdAt: new Date(Date.now() - 60 * 60_000).toISOString() }), "idle");
});

test("findRollout ignores ids that are not thread ids", async () => {
  assert.equal(await rollout.findRollout("../../etc/passwd"), undefined);
  assert.equal(rollout.isThreadId("01a0f373-576e-74c3-8a44-8039098c7269"), true);
});
