import { existsSync } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { codexHomeDir } from "./paths.ts";

const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 86_400_000;
const MISS_TTL_MS = 30_000;
const MAX_TEXT = 20_000;

const located = new Map<string, string>();
const misses = new Map<string, number>();

export const isThreadId = (value: string | undefined): value is string => typeof value === "string" && THREAD_ID.test(value);

function candidateDays(threadId: string): string[] {
  const ms = parseInt(threadId.replace(/-/g, "").slice(0, 12), 16);
  if (!Number.isFinite(ms)) return [];
  return [0, -1, 1].map((shift) => {
    const day = new Date(ms + shift * DAY_MS);
    return path.join(String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, "0"), String(day.getDate()).padStart(2, "0"));
  });
}

export async function findRollout(threadId: string, home = codexHomeDir()): Promise<string | undefined> {
  if (!isThreadId(threadId)) return undefined;
  const cached = located.get(threadId);
  if (cached && existsSync(cached)) return cached;
  if (Date.now() - (misses.get(threadId) ?? 0) < MISS_TTL_MS) return undefined;
  const suffix = `-${threadId}.jsonl`;
  const dirs = [...candidateDays(threadId).map((day) => path.join(home, "sessions", day)), path.join(home, "archived_sessions")];
  for (const dir of dirs) {
    const hit = (await readdir(dir).catch(() => [] as string[])).find((name) => name.endsWith(suffix));
    if (hit) {
      const file = path.join(dir, hit);
      located.set(threadId, file);
      misses.delete(threadId);
      return file;
    }
  }
  misses.set(threadId, Date.now());
  return undefined;
}

interface Followed<S> {
  offset: number;
  rest: string;
  state: S;
}

const followed = new Map<string, Followed<unknown>>();

async function follow<S>(file: string, kind: string, init: () => S, apply: (state: S, entry: any) => void): Promise<S> {
  const key = `${kind}:${file}`;
  let entry = followed.get(key) as Followed<S> | undefined;
  const size = (await stat(file)).size;
  if (!entry || size < entry.offset) entry = { offset: 0, rest: "", state: init() };
  if (size > entry.offset) {
    const handle = await open(file, "r");
    try {
      const buffer = Buffer.alloc(size - entry.offset);
      await handle.read(buffer, 0, buffer.length, entry.offset);
      const lines = (entry.rest + buffer.toString("utf8")).split("\n");
      entry.rest = lines.pop() ?? "";
      entry.offset = size;
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          apply(entry.state, JSON.parse(line));
        } catch {}
      }
    } finally {
      await handle.close();
    }
  }
  followed.set(key, entry);
  return entry.state;
}

export type ChildActivityKind = "started" | "interacted" | "interrupted" | "completed";

export interface SpawnedChild {
  agentPath: string;
  threadId: string;
  kind: ChildActivityKind;
  at: number;
}

const eventTime = (entry: any, payload: any) => payload?.completed_at_ms ?? payload?.started_at_ms ?? (Date.parse(entry?.timestamp ?? "") || Date.now());

export function applyParentEntry(children: Map<string, SpawnedChild>, entry: any): void {
  const payload = entry?.payload;
  if (entry?.type !== "event_msg" || payload?.type !== "item_completed") return;
  const item = payload.item;
  if (item?.type !== "SubAgentActivity" || typeof item.agent_path !== "string" || !isThreadId(item.agent_thread_id)) return;
  const kind: ChildActivityKind = ["started", "interacted", "interrupted", "completed"].includes(item.kind) ? item.kind : "interacted";
  children.set(item.agent_path, { agentPath: item.agent_path, threadId: item.agent_thread_id, kind, at: eventTime(entry, payload) });
}

export function readSpawnedChildren(file: string): Promise<Map<string, SpawnedChild>> {
  return follow(file, "parent", () => new Map<string, SpawnedChild>(), applyParentEntry);
}

export interface ChildState {
  nickname?: string;
  startedAt?: number;
  completedAt?: number;
  abortedAt?: number;
  lastMessage?: string;
  lastMessageAt?: number;
  activity?: string;
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function commandText(command: unknown): string | undefined {
  const parts = Array.isArray(command) ? command.map(String) : typeof command === "string" ? [command] : [];
  const last = parts.at(-1)?.trim();
  return last ? clip(last.replace(/\s+/g, " "), 90) : undefined;
}

function reasoningTitle(summary: unknown): string | undefined {
  const first = Array.isArray(summary) ? String(summary[0] ?? "") : "";
  const title = /\*\*(.+?)\*\*/.exec(first)?.[1] ?? first.split("\n")[0];
  return title?.trim() ? clip(title.trim(), 90) : undefined;
}

export function applyChildEntry(state: ChildState, entry: any): void {
  const payload = entry?.payload;
  if (entry?.type === "session_meta" && typeof payload?.agent_nickname === "string") state.nickname = payload.agent_nickname;
  if (entry?.type !== "event_msg") return;
  const at = eventTime(entry, payload);
  if (payload?.type === "task_started") {
    state.startedAt = (payload.started_at ? payload.started_at * 1000 : undefined) ?? at;
    state.activity = "Starting";
  } else if (payload?.type === "task_complete") state.completedAt = at;
  else if (payload?.type === "turn_aborted") state.abortedAt = at;
  else if (payload?.type === "item_completed") {
    const item = payload.item ?? {};
    if (item.type === "AgentMessage") {
      const text = (item.content ?? []).map((part: any) => (typeof part?.text === "string" ? part.text : "")).join("").trim();
      if (text) {
        state.lastMessage = clip(text, MAX_TEXT);
        state.lastMessageAt = at;
      }
    } else if (item.type === "CommandExecution") {
      const command = commandText(item.command);
      if (command) state.activity = `Ran ${command}`;
    } else if (item.type === "McpToolCall") state.activity = `Used ${[item.server, item.tool].filter(Boolean).join(".") || "a tool"}`;
    else if (item.type === "Reasoning") {
      const title = reasoningTitle(item.summary_text);
      if (title) state.activity = title;
    }
  }
}

export function readChildState(file: string): Promise<ChildState> {
  return follow(file, "child", () => ({}) as ChildState, applyChildEntry);
}

export function isRunning(state: ChildState): boolean {
  const started = state.startedAt ?? 0;
  return started > 0 && started > (state.completedAt ?? 0) && started > (state.abortedAt ?? 0);
}
