import path from "node:path";
import type { AgentRecord, AgentUsage, Harness, Isolation, ProjectRecord, TranscriptItem } from "../shared/types.ts";
import { composeBrief, workerContract } from "../core/brief.ts";
import { ensureDir, nowIso } from "../core/fsutil.ts";
import { createWorktree, gitCommonDir, isGitRepo, removeWorktree } from "../core/git.ts";
import { parseReport } from "../core/markdown.ts";
import { paths } from "../core/paths.ts";
import { addInbox, getAgent, getProject, listAgents, listProjects, nextAgentId, saveAgent, touchProject } from "../core/store.ts";
import { fetchPullRequest, isPullRequestUrl, prEvents, type PrEvent } from "./pr.ts";
import { agentKey, type AdapterHooks, type HarnessAdapter, type SendResult, type TurnEnd } from "./adapters/types.ts";

export interface StartAgentInput {
  slug: string;
  title: string;
  task: string;
  model?: string;
  effort?: string;
  repo?: string;
  isolation?: Isolation;
  base?: string;
}

export interface SendInput {
  slug: string;
  id: string;
  text: string;
  mode?: "queue" | "steer";
  from?: "coordinator" | "user";
}

type AdapterFactory = (hooks: AdapterHooks) => HarnessAdapter;

export const MAX_WORKING = Number(process.env.PROJECTS_MAX_WORKING || 10);
const PR_RECHECK_MS = 90_000;

function untrustedNames(names: string[]): string {
  return names
    .slice(0, 10)
    .map((name) => oneLine(name.replace(/[<>`]/g, ""), 80))
    .join(", ");
}

const PR_FOLLOW_UP: Partial<Record<PrEvent, (url: string, failing: string[]) => string>> = {
  checks_failed: (url, failing) =>
    [
      `Your pull request ${url} has failing checks. Read the failures with \`gh pr checks ${url}\` and \`gh run view --log-failed\`, fix them on your branch, push, and report again.`,
      ...(failing.length ? ["", "<untrusted source=\"github\">", `Failing check names: ${untrustedNames(failing)}`, "</untrusted>"] : []),
    ].join("\n"),
  changes_requested: (url) =>
    `Your pull request ${url} has review comments requesting changes. Read them with \`gh pr view ${url} --comments\`, address them on your branch, push, and report again.`,
};

const PR_INBOX: Record<PrEvent, { kind: "pr_checks_failed" | "pr_changes_requested" | "pr_merged" | "pr_closed"; text: string }> = {
  checks_failed: { kind: "pr_checks_failed", text: "PR checks are failing" },
  changes_requested: { kind: "pr_changes_requested", text: "PR review requested changes" },
  merged: { kind: "pr_merged", text: "PR merged. Resolve the agent when the work is done" },
  closed: { kind: "pr_closed", text: "PR closed without merging" },
};

function oneLine(text: string, max = 200): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export class AgentService {
  private readonly agents = new Map<string, AgentRecord>();
  private readonly adapters: Record<Harness, HarnessAdapter>;
  readonly codex: HarnessAdapter;
  private saveChain: Promise<void> = Promise.resolve();
  private reservedSlots = 0;
  private flushingDeferred = false;

  constructor(factories: Record<Harness, AdapterFactory>) {
    const hooks = this.hooks();
    this.codex = factories.codex(hooks);
    this.adapters = { codex: this.codex };
  }

  private track(agent: AgentRecord): AgentRecord {
    this.agents.set(agentKey(agent), agent);
    return agent;
  }

  private persist(agent: AgentRecord): Promise<void> {
    agent.updatedAt = nowIso();
    const snapshot = structuredClone(agent);
    const write = this.saveChain.then(() => saveAgent(snapshot));
    this.saveChain = write.catch(() => undefined);
    return write;
  }

  private persistInBackground(agent: AgentRecord): void {
    this.persist(agent).catch((error) => console.error(new Date().toISOString(), `save ${agentKey(agent)}`, error));
  }

  private workingCount(): number {
    const working = [...this.agents.values()].filter((agent) => !agent.resolved && (agent.status === "working" || agent.status === "starting")).length;
    return working + this.reservedSlots;
  }

  private reserveSlot(): () => void {
    if (this.workingCount() >= MAX_WORKING) throw new Error(`${MAX_WORKING} agents are already working. Wait for one to finish or stop one first.`);
    this.reservedSlots += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.reservedSlots -= 1;
    };
  }

  private handle(key: string): AgentRecord | undefined {
    return this.agents.get(key);
  }

  private hooks(): AdapterHooks {
    return {
      onSession: (agentKey, sessionId) => {
        const agent = this.handle(agentKey);
        if (!agent) return;
        agent.sessionId = sessionId;
        this.persistInBackground(agent);
      },
      onWorking: (agentKey, turnId) => {
        const agent = this.handle(agentKey);
        if (!agent) return;
        agent.status = "working";
        agent.turnId = turnId ?? agent.turnId;
        agent.activity = agent.activity ?? "Starting";
        this.persistInBackground(agent);
      },
      onActivity: (agentKey, activity) => {
        const agent = this.handle(agentKey);
        if (!agent) return;
        agent.activity = activity;
        this.persistInBackground(agent);
      },
      onMessage: (agentKey, text) => {
        const agent = this.handle(agentKey);
        if (!agent) return;
        agent.lastMessage = text;
        this.persistInBackground(agent);
      },
      onUsage: (agentKey, usage: AgentUsage) => {
        const agent = this.handle(agentKey);
        if (!agent) return;
        agent.usage = usage;
      },
      onWaiting: (agentKey, reason) => {
        const agent = this.handle(agentKey);
        if (!agent) return;
        agent.status = "waiting";
        agent.activity = reason;
        this.persistInBackground(agent);
        addInbox(agent.slug, { kind: "agent_waiting", agentId: agent.id, title: agent.title, summary: reason }).catch((error) => console.error(new Date().toISOString(), "inbox", error));
      },
      onTurnEnd: (agentKey, end) => {
        this.onTurnEnd(agentKey, end).catch((error) => console.error(new Date().toISOString(), `turn end ${agentKey}`, error));
      },
      onQueueDelivered: (agentKey, count) => {
        const agent = this.handle(agentKey);
        if (!agent?.queued) return;
        const rest = agent.queued.slice(count);
        agent.queued = rest.length ? rest : undefined;
        this.persistInBackground(agent);
      },
    };
  }

  private async onTurnEnd(agentKey: string, end: TurnEnd): Promise<void> {
    const agent = this.handle(agentKey);
    if (!agent) return;
    agent.turns += 1;
    agent.finishedAt = nowIso();
    agent.activity = undefined;
    agent.lastMessage = end.message || agent.lastMessage;
    if (end.message) {
      const previousPr = agent.report?.pr ?? agent.pr?.url;
      agent.report = parseReport(end.message);
      if (!agent.report.pr && previousPr) agent.report.pr = previousPr;
    }
    if (end.outcome === "interrupted") agent.queued = undefined;
    if (agent.report?.pr && agent.pr?.url !== agent.report.pr) agent.pr = undefined;
    agent.reviewed = false;
    if (end.outcome === "completed") {
      agent.status = agent.report?.needsYou ? "waiting" : "idle";
      agent.error = undefined;
    } else if (end.outcome === "interrupted") {
      agent.status = "stopped";
    } else {
      agent.status = "failed";
      agent.error = oneLine(end.error || "The turn failed.", 400);
    }
    await this.persist(agent);
    const kind = agent.status === "failed" ? "agent_failed" : agent.status === "stopped" ? "agent_stopped" : agent.status === "waiting" ? "agent_waiting" : "agent_done";
    const summary =
      agent.status === "failed"
        ? agent.error ?? "failed"
        : agent.status === "waiting"
          ? `Needs you: ${oneLine(agent.report?.needsYou ?? "")}`
          : oneLine(agent.report?.summary || end.message || "Finished with no message.");
    await addInbox(agent.slug, { kind, agentId: agent.id, title: agent.title, summary });
    await touchProject(agent.slug);
  }

  adapter(harness: Harness): HarnessAdapter {
    return this.adapters[harness];
  }

  async available(): Promise<boolean> {
    return this.codex.available();
  }

  async recover(): Promise<number> {
    let recovered = 0;
    for (const project of await listProjects(true)) {
      for (const agent of await listAgents(project.slug)) {
        this.track(agent);
        if (agent.status === "working" || agent.status === "starting") {
          agent.status = "stopped";
          agent.activity = undefined;
          agent.error = agent.queued?.length
            ? `Interrupted because the Project Coordinator service restarted. ${agent.queued.length} queued message(s) will be delivered with your next message.`
            : "Interrupted because the Project Coordinator service restarted. Send a message to continue.";
          await this.persist(agent);
          await addInbox(agent.slug, { kind: "agent_stopped", agentId: agent.id, title: agent.title, summary: agent.error });
          recovered += 1;
        }
      }
    }
    return recovered;
  }

  private async load(slug: string, id: string): Promise<AgentRecord> {
    const existing = this.agents.get(`${slug}/${id}`);
    if (existing) return existing;
    return this.track(await getAgent(slug, id));
  }

  private async instructionsFor(agent: AgentRecord): Promise<string> {
    return workerContract(await getProject(agent.slug), agent);
  }

  async start(input: StartAgentInput): Promise<AgentRecord> {
    const project = await getProject(input.slug);
    if (!input.title?.trim()) throw new Error("An agent needs a short title.");
    if (!input.task?.trim()) throw new Error("An agent needs a task.");
    const harness: Harness = "codex";
    const adapter = this.adapters[harness];
    const repo = input.repo?.trim() ? path.resolve(input.repo.trim()) : input.isolation === "folder" ? undefined : project.repos[0];
    const isolation: Isolation = input.isolation ?? (repo ? ((await isGitRepo(repo)) ? "worktree" : "checkout") : "folder");
    if (isolation !== "folder" && !repo) throw new Error(`Isolation "${isolation}" needs a repository. Add one to the project or pass repo.`);
    const release = this.reserveSlot();
    try {
      return await this.startReserved(project, input, adapter, harness, repo, isolation);
    } finally {
      release();
    }
  }

  private async startReserved(project: ProjectRecord, input: StartAgentInput, adapter: HarnessAdapter, harness: Harness, repo: string | undefined, isolation: Isolation): Promise<AgentRecord> {
    const id = await nextAgentId(project.slug);
    const now = nowIso();
    const agent: AgentRecord = {
      id,
      slug: project.slug,
      title: oneLine(input.title, 80),
      task: input.task.trim(),
      harness,
      model: input.model?.trim() || project.model,
      effort: input.effort?.trim() || project.effort,
      isolation,
      repo,
      cwd: "",
      status: "starting",
      createdAt: now,
      updatedAt: now,
      activity: "Preparing workspace",
      reviewed: false,
      resolved: false,
      turns: 0,
      followUps: [],
    };
    if (isolation === "worktree") {
      const worktree = await createWorktree(repo!, project.slug, id, agent.title, input.base);
      agent.cwd = worktree.cwd;
      agent.branch = worktree.branch;
      const common = await gitCommonDir(worktree.cwd);
      if (common) agent.writableRoots = [common];
    } else if (isolation === "checkout") {
      agent.cwd = repo!;
    } else {
      agent.cwd = paths.workDir(project.slug, id);
      await ensureDir(agent.cwd);
    }
    this.track(agent);
    await this.persist(agent);
    try {
      const brief = await composeBrief(project, agent);
      const { sessionId } = await adapter.start(agent, brief, workerContract(project, agent));
      agent.sessionId = sessionId;
      agent.status = agent.status === "starting" ? "working" : agent.status;
      await this.persist(agent);
    } catch (error) {
      agent.status = "failed";
      agent.activity = undefined;
      agent.error = oneLine(error instanceof Error ? error.message : String(error), 400);
      await this.persist(agent);
      await addInbox(agent.slug, { kind: "agent_failed", agentId: agent.id, title: agent.title, summary: agent.error });
    }
    await touchProject(project.slug);
    return agent;
  }

  async send(input: SendInput): Promise<{ agent: AgentRecord; result: SendResult }> {
    const agent = await this.load(input.slug, input.id);
    if (agent.resolved) throw new Error(`Agent ${agent.id} is resolved. Start a new agent instead.`);
    if (!input.text?.trim()) throw new Error("The message is empty.");
    const adapter = this.adapters[agent.harness];
    const text = input.text.trim();
    const startsTurn = !adapter.isRunning(agentKey(agent));
    const release = startsTurn ? this.reserveSlot() : () => undefined;
    try {
      const pending = startsTurn ? [...(agent.queued ?? [])] : [];
      const outgoing = pending.length ? [...pending, text].join("\n\n") : text;
      const result = await adapter.send(agent, outgoing, input.mode ?? "queue", await this.instructionsFor(agent));
      agent.followUps.push({ at: nowIso(), text, from: input.from ?? "coordinator" });
      if (result === "queued") agent.queued = [...(agent.queued ?? []), text];
      else if (pending.length) {
        const rest = (agent.queued ?? []).slice(pending.length);
        agent.queued = rest.length ? rest : undefined;
      }
      if (result !== "queued") {
        agent.status = "working";
        agent.error = undefined;
        agent.activity = result === "steered" ? "Redirected" : "Reading your message";
      }
      await this.persist(agent);
      return { agent, result };
    } finally {
      release();
    }
  }

  async stop(slug: string, id: string): Promise<AgentRecord> {
    const agent = await this.load(slug, id);
    await this.adapters[agent.harness].stop(agent);
    if (!this.adapters[agent.harness].isRunning(agentKey(agent)) && (agent.status === "working" || agent.status === "starting")) {
      agent.status = "stopped";
      agent.activity = undefined;
      await this.persist(agent);
    }
    return agent;
  }

  async review(slug: string, id: string): Promise<AgentRecord> {
    const agent = await this.load(slug, id);
    agent.reviewed = true;
    await this.persist(agent);
    return agent;
  }

  async resolve(slug: string, id: string, removeWorktreeToo = false): Promise<{ agent: AgentRecord; cleanup?: string }> {
    const agent = await this.load(slug, id);
    if (this.adapters[agent.harness].isRunning(agentKey(agent))) await this.adapters[agent.harness].stop(agent);
    agent.resolved = true;
    agent.reviewed = true;
    if (agent.status === "working" || agent.status === "starting") agent.status = "stopped";
    let cleanup: string | undefined;
    if (removeWorktreeToo && agent.isolation === "worktree" && agent.repo) cleanup = await removeWorktree(agent.repo, agent.cwd);
    await this.persist(agent);
    return { agent, cleanup };
  }

  async reopen(slug: string, id: string): Promise<AgentRecord> {
    const agent = await this.load(slug, id);
    agent.resolved = false;
    await this.persist(agent);
    return agent;
  }

  async transcript(slug: string, id: string): Promise<TranscriptItem[]> {
    const agent = await this.load(slug, id);
    return this.adapters[agent.harness].transcript(agent);
  }

  private async flushDeferred(): Promise<void> {
    if (this.flushingDeferred) return;
    this.flushingDeferred = true;
    try {
      for (const agent of this.agents.values()) {
        if (!agent.deferred?.length || agent.resolved || this.workingCount() >= MAX_WORKING) continue;
        const batch = [...agent.deferred];
        const sent = await this.send({ slug: agent.slug, id: agent.id, text: batch.join("\n\n"), mode: "queue", from: "coordinator" }).then(
          () => true,
          () => false,
        );
        if (!sent) continue;
        const rest = (agent.deferred ?? []).slice(batch.length);
        agent.deferred = rest.length ? rest : undefined;
        await this.persist(agent);
      }
    } finally {
      this.flushingDeferred = false;
    }
  }

  async pollPullRequests(force = false): Promise<number> {
    let changed = 0;
    await this.flushDeferred();
    for (const agent of this.agents.values()) {
      const url = agent.report?.pr ?? agent.pr?.url;
      if (!isPullRequestUrl(url) || agent.resolved) continue;
      if (!force && agent.pr && Date.now() - Date.parse(agent.pr.checkedAt) < PR_RECHECK_MS) continue;
      if (agent.pr && (agent.pr.state === "MERGED" || agent.pr.state === "CLOSED")) continue;
      let next;
      try {
        next = await fetchPullRequest(url);
      } catch {
        continue;
      }
      const events = prEvents(agent.pr, next);
      agent.pr = next;
      await this.persist(agent);
      for (const event of events) {
        changed += 1;
        const failing = event === "checks_failed" && next.failing.length ? `: ${untrustedNames(next.failing)}` : "";
        await addInbox(agent.slug, { kind: PR_INBOX[event].kind, agentId: agent.id, title: agent.title, summary: `${PR_INBOX[event].text}${failing} (${url})` });
        const followUp = PR_FOLLOW_UP[event];
        const project = await getProject(agent.slug).catch(() => undefined);
        if (followUp && project && project.prFollowUp !== false) {
          const text = followUp(url, next.failing);
          await this.send({ slug: agent.slug, id: agent.id, text, mode: "queue", from: "coordinator" }).catch(async () => {
            agent.deferred = [...(agent.deferred ?? []), text];
            await this.persist(agent);
          });
        }
      }
      if (events.length) await touchProject(agent.slug);
    }
    return changed;
  }

  runningCount(): number {
    let count = 0;
    for (const agent of this.agents.values()) if (this.adapters[agent.harness].isRunning(agentKey(agent))) count += 1;
    return count;
  }

  async flush(): Promise<void> {
    await this.saveChain;
  }

  async dispose(): Promise<void> {
    await Promise.all(Object.values(this.adapters).map((adapter) => adapter.dispose()));
    await this.flush();
  }
}
