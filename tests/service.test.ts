import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentRecord, TranscriptItem } from "../src/shared/types.ts";
import type { AdapterHooks, HarnessAdapter, SendResult } from "../src/daemon/adapters/types.ts";

process.env.PROJECTS_COORDINATOR_HOME = await mkdtemp(path.join(os.tmpdir(), "pc-svc-"));

const { agentKey } = await import("../src/daemon/adapters/types.ts");
const { AgentService } = await import("../src/daemon/service.ts");
const store = await import("../src/core/store.ts");

class FakeAdapter implements HarnessAdapter {
  readonly harness = "codex" as const;
  started: { agent: AgentRecord; brief: string; instructions: string }[] = [];
  sent: string[] = [];
  running = new Set<string>();
  readonly hooks: AdapterHooks;
  constructor(hooks: AdapterHooks) {
    this.hooks = hooks;
  }
  async available() {
    return true;
  }
  async start(agent: AgentRecord, brief: string, instructions: string) {
    this.started.push({ agent, brief, instructions });
    this.running.add(agentKey(agent));
    this.hooks.onSession(agentKey(agent), `thread-${agent.slug}-${agent.id}`);
    this.hooks.onWorking(agentKey(agent), "turn-1");
    return { sessionId: `thread-${agent.slug}-${agent.id}` };
  }
  finish(agent: AgentRecord, message: string, outcome: "completed" | "failed" | "interrupted" = "completed") {
    this.running.delete(agentKey(agent));
    this.hooks.onTurnEnd(agentKey(agent), { outcome, message, error: outcome === "failed" ? "boom" : undefined });
  }
  async send(agent: AgentRecord, text: string): Promise<SendResult> {
    this.sent.push(text);
    if (this.running.has(agentKey(agent))) return "queued";
    this.running.add(agentKey(agent));
    return "started";
  }
  async stop(agent: AgentRecord) {
    this.finish(agent, "", "interrupted");
  }
  isRunning(key: string) {
    return this.running.has(key);
  }
  async transcript(): Promise<TranscriptItem[]> {
    return [];
  }
  async dispose() {}
}

let fake!: FakeAdapter;
const service = new AgentService({
  codex: (hooks) => (fake = new FakeAdapter(hooks)),
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

test("an agent moves from working to ready for review and files an inbox item", async () => {
  const project = await store.createProject({ name: "Alpha", goal: "Ship caching", instructions: "Use pnpm." });
  await store.writeMemory(project.slug, { name: "Redis port", description: "Redis runs on 6380", body: "Redis runs on 6380 locally." });
  const agent = await service.start({ slug: project.slug, title: "Cache users", task: "Add a cache to /users." });
  assert.equal(agent.isolation, "folder");
  assert.equal(agent.status, "working");
  const brief = fake.started[0].brief;
  assert.match(brief, /Goal: Ship caching/);
  assert.match(brief, /Use pnpm\./);
  assert.match(brief, /Redis runs on 6380 locally\./);
  assert.match(fake.started[0].instructions, /## Next/);

  fake.finish(agent, "## Report\nCached /users.\n## Next\n- Merge the PR");
  await settle();
  await service.flush();
  const saved = await store.getAgent(project.slug, agent.id);
  assert.equal(saved.status, "idle");
  assert.equal(store.agentGroup(saved), "review");
  assert.deepEqual(saved.report?.next, ["Merge the PR"]);
  const inbox = await store.listInbox(project.slug);
  assert.equal(inbox.at(-1)?.kind, "agent_done");
  assert.equal(inbox.at(-1)?.summary, "Cached /users.");

  const { result } = await service.send({ slug: project.slug, id: agent.id, text: "Merge the PR" });
  assert.equal(result, "started");
  await service.flush();
  assert.equal((await store.getAgent(project.slug, agent.id)).status, "working");
});

test("agents with the same id in different projects do not collide", async () => {
  const one = await store.createProject({ name: "One" });
  const two = await store.createProject({ name: "Two" });
  const a = await service.start({ slug: one.slug, title: "Task one", task: "one" });
  const b = await service.start({ slug: two.slug, title: "Task two", task: "two" });
  assert.equal(a.id, "a-001");
  assert.equal(b.id, "a-001");
  fake.finish(b, "## Report\nTwo done.\n## Needs you\nWhich region?");
  await settle();
  await service.flush();
  assert.equal((await store.getAgent(one.slug, a.id)).status, "working");
  const saved = await store.getAgent(two.slug, b.id);
  assert.equal(saved.status, "waiting");
  assert.equal(store.agentGroup(saved), "needs_you");
});

test("a failed turn records the error and a restart marks running agents stopped", async () => {
  const project = await store.createProject({ name: "Gamma" });
  const failing = await service.start({ slug: project.slug, title: "Fails", task: "x" });
  fake.finish(failing, "", "failed");
  await settle();
  await service.flush();
  const failed = await store.getAgent(project.slug, failing.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.error, "boom");

  const running = await service.start({ slug: project.slug, title: "Runs", task: "y" });
  await service.flush();
  const restarted = new AgentService({ codex: (hooks) => new FakeAdapter(hooks) });
  assert.ok((await restarted.recover()) >= 1);
  await restarted.flush();
  const recovered = await store.getAgent(project.slug, running.id);
  assert.equal(recovered.status, "stopped");
  assert.match(recovered.error ?? "", /restarted/);
});

test("resolve hides an agent from open groups", async () => {
  const project = await store.createProject({ name: "Delta" });
  const agent = await service.start({ slug: project.slug, title: "Resolve me", task: "z" });
  await service.resolve(project.slug, agent.id);
  await service.flush();
  assert.equal(store.agentGroup(await store.getAgent(project.slug, agent.id)), "resolved");
  await assert.rejects(service.send({ slug: project.slug, id: agent.id, text: "more" }), /resolved/);
});

test("queued follow-ups are kept on the record and delivered with the next message after a restart", async () => {
  const project = await store.createProject({ name: "Queue Keeper" });
  const agent = await service.start({ slug: project.slug, title: "Long task", task: "Work for a while." });
  const { result } = await service.send({ slug: project.slug, id: agent.id, text: "Also update the docs." });
  assert.equal(result, "queued");
  await service.flush();
  assert.deepEqual((await store.getAgent(project.slug, agent.id)).queued, ["Also update the docs."]);

  fake.running.delete(agentKey(agent));
  fake.hooks.onTurnEnd(agentKey(agent), { outcome: "failed", message: "", error: "app-server exited" });
  await settle();
  await service.flush();
  assert.deepEqual((await store.getAgent(project.slug, agent.id)).queued, ["Also update the docs."]);

  fake.sent.length = 0;
  await service.send({ slug: project.slug, id: agent.id, text: "Continue." });
  assert.equal(fake.sent.at(-1), "Also update the docs.\n\nContinue.");
  await service.flush();
  assert.equal((await store.getAgent(project.slug, agent.id)).queued, undefined);
});

test("follow-ups that would start a turn respect the working limit", async () => {
  const { MAX_WORKING } = await import("../src/daemon/service.ts");
  const project = await store.createProject({ name: "Capacity" });
  const idle = await service.start({ slug: project.slug, title: "Idle one", task: "Finish fast." });
  fake.finish(idle, "## Report\nDone.");
  await settle();
  const busy: AgentRecord[] = [];
  const working = () => [...fake.running].length;
  while (working() < MAX_WORKING) busy.push(await service.start({ slug: project.slug, title: `Busy ${busy.length}`, task: "Keep working." }).catch(() => undefined as never));
  await assert.rejects(service.send({ slug: project.slug, id: idle.id, text: "One more thing." }), /already working/);
  for (const agent of busy) if (agent) fake.finish(agent, "## Report\nStopped.");
  await settle();
  await service.flush();
});
