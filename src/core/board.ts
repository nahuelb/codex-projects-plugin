import path from "node:path";
import type { AgentRecord, AgentStatus, InboxKind, Isolation, ProjectRecord } from "../shared/types.ts";
import { nowIso, slugify, withFileLock } from "./fsutil.ts";
import { createTaskWorktree, isGitRepo, removeTaskWorktree } from "./git.ts";
import { parseReport } from "./markdown.ts";
import { paths } from "./paths.ts";
import { fetchPullRequest, isPullRequestUrl, prEvents, type PrEvent } from "./pr.ts";
import { findRollout, isRunning, isThreadId, readChildState, readSpawnedChildren, type SpawnedChild } from "./rollout.ts";
import { addInbox, getAgent, getProject, listAgents, nextAgentId, saveAgent, touchProject } from "./store.ts";

const PR_RECHECK_MS = 2 * 60_000;

export function taskNameFor(title: string, taken: Iterable<string> = []): string {
  const stem = slugify(title, 40).replace(/-/g, "_").replace(/^(\d)/, "task_$1") || "task";
  const used = new Set(taken);
  if (!used.has(stem)) return stem;
  for (let suffix = 2; ; suffix += 1) if (!used.has(`${stem}_${suffix}`)) return `${stem}_${suffix}`;
}

export interface PrepareInput {
  slug: string;
  title: string;
  task: string;
  isolation?: Isolation;
  repo?: string;
  base?: string;
  model?: string;
  effort?: string;
  parentThreadId?: string;
}

export async function prepareAgent(input: PrepareInput): Promise<AgentRecord> {
  const project = await getProject(input.slug);
  const title = input.title.trim().replace(/\s+/g, " ").slice(0, 80);
  if (!title) throw new Error("An agent needs a short title.");
  if (!input.task?.trim()) throw new Error("An agent needs a task.");
  const repo = input.repo?.trim() ? path.resolve(input.repo.trim()) : project.repos[0];
  const isolation: Isolation = input.isolation ?? "shared";
  if (isolation === "worktree" && !repo) throw new Error("A worktree needs a repository. Add one to the project or pass repo.");
  if (isolation === "worktree" && !(await isGitRepo(repo!))) throw new Error(`${repo} is not a git repository. Use isolation "shared".`);
  const id = await nextAgentId(project.slug);
  const taken = (await listAgents(project.slug)).map((existing) => existing.taskName);
  const now = nowIso();
  const agent: AgentRecord = {
    id,
    slug: project.slug,
    title,
    task: input.task.trim(),
    taskName: taskNameFor(title, taken),
    isolation,
    repo,
    cwd: repo ?? paths.project(project.slug),
    model: input.model?.trim() || project.model,
    effort: input.effort?.trim() || project.effort,
    parentThreadId: isThreadId(input.parentThreadId) ? input.parentThreadId : project.coordinatorThreadId,
    status: "prepared",
    createdAt: now,
    updatedAt: now,
    reviewed: false,
    resolved: false,
  };
  if (isolation === "worktree") {
    const worktree = await createTaskWorktree(repo!, id, title, input.base);
    agent.cwd = worktree.cwd;
    agent.branch = worktree.branch;
    agent.baseSha = worktree.base;
  }
  await saveAgent(agent);
  await touchProject(project.slug);
  return agent;
}

function matchChild(children: Map<string, SpawnedChild>, taskName: string): SpawnedChild | undefined {
  const exact = children.get(`/root/${taskName}`);
  if (exact) return exact;
  let best: SpawnedChild | undefined;
  for (const child of children.values()) if (child.agentPath.endsWith(`/${taskName}`) && (!best || child.at > best.at)) best = child;
  return best;
}

const iso = (ms: number | undefined) => (ms ? new Date(ms).toISOString() : undefined);

async function spawnedChildren(project: ProjectRecord, agents: AgentRecord[]): Promise<Map<string, SpawnedChild>> {
  const merged = new Map<string, SpawnedChild>();
  const ids = [...new Set([...(project.pastThreadIds ?? []), project.coordinatorThreadId, ...agents.map((agent) => agent.parentThreadId)].filter((id): id is string => isThreadId(id)))];
  for (const threadId of ids) {
    const file = await findRollout(threadId).catch(() => undefined);
    if (!file) continue;
    for (const [agentPath, child] of await readSpawnedChildren(file).catch(() => new Map<string, SpawnedChild>())) {
      const known = merged.get(agentPath);
      if (!known || child.at >= known.at) merged.set(agentPath, child);
    }
  }
  return merged;
}

const TRANSITION_INBOX: Partial<Record<AgentStatus, InboxKind>> = { idle: "agent_done", waiting: "agent_waiting", stopped: "agent_stopped" };

async function refreshAgent(agent: AgentRecord, child: SpawnedChild): Promise<AgentRecord | undefined> {
  const next: AgentRecord = { ...agent, threadId: child.threadId };
  const file = await findRollout(child.threadId).catch(() => undefined);
  const state = file ? await readChildState(file).catch(() => undefined) : undefined;
  if (state?.nickname) next.nickname = state.nickname;
  next.startedAt = agent.startedAt ?? iso(state?.startedAt ?? child.at);
  const running = state ? isRunning(state) : child.kind === "started" || child.kind === "interacted";
  const interrupted = child.kind === "interrupted" && child.at >= (state?.startedAt ?? 0);
  if (interrupted && !running) {
    next.status = "stopped";
    next.activity = undefined;
  } else if (running) {
    next.status = "working";
    next.activity = state?.activity ?? "Working";
  } else {
    const finishedAt = iso(state?.lastMessageAt ?? state?.completedAt ?? child.at);
    if (state?.lastMessage && finishedAt !== agent.finishedAt) {
      next.report = parseReport(state.lastMessage);
      next.reviewed = false;
      if (next.report.pr && next.report.pr !== agent.report?.pr) next.pr = undefined;
    }
    next.finishedAt = finishedAt;
    next.status = next.report?.needsYou ? "waiting" : "idle";
    next.activity = undefined;
  }
  const changed = JSON.stringify({ ...next, updatedAt: "" }) !== JSON.stringify({ ...agent, updatedAt: "" });
  return changed ? next : undefined;
}

export async function syncProject(slug: string): Promise<number> {
  const project = await getProject(slug);
  const open = (await listAgents(slug)).filter((agent) => !agent.resolved);
  if (!open.length) return 0;
  return withFileLock(path.join(paths.agentsDir(slug), "sync"), async () => {
    const children = await spawnedChildren(project, open);
    if (!children.size) return 0;
    let changed = 0;
    for (const stale of open) {
      const agent = await getAgent(slug, stale.id).catch(() => stale);
      if (agent.resolved) continue;
      const child = matchChild(children, agent.taskName);
      if (!child) continue;
      const next = await refreshAgent(agent, child);
      if (!next) continue;
      await saveAgent(next);
      changed += 1;
      const kind = next.status !== agent.status || next.finishedAt !== agent.finishedAt ? TRANSITION_INBOX[next.status] : undefined;
      if (kind) {
        const summary = next.status === "waiting" ? `Needs you: ${next.report?.needsYou ?? ""}` : next.status === "stopped" ? "Interrupted." : next.report?.summary || "Finished with no report.";
        await addInbox(slug, { kind, agentId: next.id, title: next.title, summary: summary.replace(/\s+/g, " ").slice(0, 300) });
      }
    }
    if (changed) await touchProject(slug);
    return changed;
  });
}

const PR_INBOX: Record<PrEvent, { kind: InboxKind; text: string }> = {
  checks_failed: { kind: "pr_checks_failed", text: "Checks failing on the pull request" },
  changes_requested: { kind: "pr_changes_requested", text: "Changes requested on the pull request" },
  merged: { kind: "pr_merged", text: "Pull request merged" },
  closed: { kind: "pr_closed", text: "Pull request closed without merging" },
};

const inFlight = new Map<string, Promise<number>>();

export function refreshPullRequests(slug: string, force = false): Promise<number> {
  const running = inFlight.get(slug);
  if (running) return running;
  const work = (async () => {
    let events = 0;
    for (const agent of await listAgents(slug)) {
      const url = agent.report?.pr ?? agent.pr?.url;
      if (agent.resolved || !isPullRequestUrl(url)) continue;
      if (agent.pr && (agent.pr.state === "MERGED" || agent.pr.state === "CLOSED")) continue;
      if (!force && agent.pr && Date.now() - Date.parse(agent.pr.checkedAt) < PR_RECHECK_MS) continue;
      let status;
      try {
        status = await fetchPullRequest(url);
      } catch {
        continue;
      }
      const current = await getAgent(slug, agent.id).catch(() => agent);
      const found = prEvents(current.pr, status);
      await saveAgent({ ...current, pr: status });
      for (const event of found) {
        events += 1;
        const failing = event === "checks_failed" && status.failing.length ? `: ${status.failing.join(", ")}` : "";
        await addInbox(slug, { kind: PR_INBOX[event].kind, agentId: agent.id, title: agent.title, summary: `${PR_INBOX[event].text}${failing} (${url})` });
      }
    }
    if (events) await touchProject(slug);
    return events;
  })().finally(() => inFlight.delete(slug));
  inFlight.set(slug, work);
  return work;
}

export async function reviewAgent(slug: string, id: string): Promise<AgentRecord> {
  const agent = await getAgent(slug, id);
  const next = { ...agent, reviewed: true };
  await saveAgent(next);
  return next;
}

export async function resolveAgent(slug: string, id: string, removeWorktree = true): Promise<{ agent: AgentRecord; cleanup?: string }> {
  const agent = await getAgent(slug, id);
  let cleanup: string | undefined;
  if (removeWorktree && agent.isolation === "worktree" && agent.repo) cleanup = await removeTaskWorktree(agent.repo, agent.cwd, agent.branch, agent.baseSha).catch((error) => `kept: ${error.message}`);
  const next = { ...agent, resolved: true, reviewed: true };
  await saveAgent(next);
  await touchProject(slug);
  return { agent: next, cleanup };
}

export async function reopenAgent(slug: string, id: string): Promise<AgentRecord> {
  const agent = await getAgent(slug, id);
  const next = { ...agent, resolved: false };
  await saveAgent(next);
  return next;
}
