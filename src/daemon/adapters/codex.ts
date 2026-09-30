import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentRecord, ModelOption, TranscriptItem } from "../../shared/types.ts";
import { agentKey, type AdapterHooks, type HarnessAdapter, type SendResult } from "./types.ts";
import { withAppServer } from "./oneshot.ts";

const run = promisify(execFile);

type Json = Record<string, any>;

interface Pending {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface ThreadState {
  agentId: string;
  policy?: Json;
  activeTurn?: string;
  lastMessage: string;
  queue: string[];
}

function textInput(text: string) {
  return [{ type: "text", text, text_elements: [] }];
}

function sandboxPolicy(agent: AgentRecord) {
  return {
    type: "workspaceWrite",
    writableRoots: [agent.cwd, ...(agent.writableRoots ?? [])],
    networkAccess: process.env.PROJECTS_CODEX_NETWORK !== "0",
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

function describeItem(item: Json): string | undefined {
  switch (item.type) {
    case "commandExecution":
      return `Running ${String(item.command ?? "").split("\n")[0].slice(0, 80)}`;
    case "fileChange":
      return "Editing files";
    case "reasoning":
      return "Thinking";
    case "mcpToolCall":
      return `Using ${item.server ?? "tool"}.${item.tool ?? ""}`;
    case "webSearch":
      return "Searching the web";
    case "agentMessage":
      return "Writing";
    default:
      return undefined;
  }
}

export class CodexAdapter implements HarnessAdapter {
  readonly harness = "codex" as const;
  private child?: ChildProcessWithoutNullStreams;
  private ready?: Promise<void>;
  private nextId = 0;
  private pending = new Map<number, Pending>();
  private threads = new Map<string, ThreadState>();
  private stderrTail: string[] = [];

  private readonly hooks: AdapterHooks;
  private readonly version: string;
  private readonly binary: string;

  constructor(hooks: AdapterHooks, version: string, binary = process.env.PROJECTS_CODEX_BIN || "codex") {
    this.hooks = hooks;
    this.version = version;
    this.binary = binary;
  }

  async available(): Promise<boolean> {
    try {
      await run(this.binary, ["--version"], { timeout: 10_000 });
      return true;
    } catch {
      return false;
    }
  }

  private connect(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((resolve, reject) => {
      const child = spawn(this.binary, ["app-server", "--listen", "stdio://"], { stdio: ["pipe", "pipe", "pipe"], env: process.env });
      this.child = child;
      child.stderr.on("data", (chunk: Buffer) => {
        this.stderrTail.push(chunk.toString());
        if (this.stderrTail.length > 40) this.stderrTail.shift();
      });
      child.on("error", (error) => {
        if (this.child !== child) return;
        this.ready = undefined;
        reject(error);
      });
      child.on("exit", (code) => {
        if (this.child === child) this.onExit(code);
      });
      readline.createInterface({ input: child.stdout }).on("line", (line) => {
        if (this.child === child) this.onLine(line);
      });
      this.request("initialize", { clientInfo: { name: "codex-projects-plugin", title: "Project Coordinator", version: this.version }, capabilities: null }, 30_000)
        .then(() => {
          this.write({ jsonrpc: "2.0", method: "initialized" });
          resolve();
        })
        .catch((error) => {
          if (this.child === child) {
            this.child = undefined;
            this.ready = undefined;
          }
          child.kill();
          reject(error);
        });
    });
    return this.ready;
  }

  private onExit(code: number | null): void {
    this.ready = undefined;
    this.child = undefined;
    const reason = `Codex app-server exited (${code ?? "signal"}). ${this.stderrTail.join("").trim().slice(-400)}`.trim();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pending.clear();
    for (const state of this.threads.values()) {
      if (state.activeTurn) this.hooks.onTurnEnd(state.agentId, { outcome: "failed", message: state.lastMessage, error: reason });
      state.activeTurn = undefined;
    }
    this.threads.clear();
  }

  private write(message: Json): void {
    this.child?.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private request<T = any>(method: string, params: unknown, timeoutMs = 60_000): Promise<T> {
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  private async call<T = any>(method: string, params: unknown, timeoutMs?: number): Promise<T> {
    await this.connect();
    return this.request<T>(method, params, timeoutMs);
  }

  private onLine(line: string): void {
    let message: Json;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id != null && message.method == null) {
      const pending = this.pending.get(Number(message.id));
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(Number(message.id));
      if (message.error) pending.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
      else pending.resolve(message.result);
      return;
    }
    if (message.id != null && message.method) {
      this.onServerRequest(message);
      return;
    }
    if (message.method) this.onNotification(message.method, message.params ?? {});
  }

  private onServerRequest(message: Json): void {
    const state = this.threads.get(message.params?.threadId);
    switch (message.method) {
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
        if (state) this.hooks.onActivity(state.agentId, "Declined an action that needed approval");
        this.write({ jsonrpc: "2.0", id: message.id, result: { decision: "decline" } });
        return;
      default:
        this.write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Project Coordinator does not handle ${message.method}` } });
    }
  }

  private onNotification(method: string, params: Json): void {
    const state = this.threads.get(params.threadId);
    if (!state) return;
    switch (method) {
      case "turn/started":
        state.activeTurn = params.turn?.id;
        this.hooks.onWorking(state.agentId, state.activeTurn);
        return;
      case "item/started": {
        const activity = describeItem(params.item ?? {});
        if (activity) this.hooks.onActivity(state.agentId, activity);
        return;
      }
      case "item/completed":
        if (params.item?.type === "agentMessage" && params.item.text) {
          state.lastMessage = String(params.item.text);
          this.hooks.onMessage(state.agentId, state.lastMessage);
        }
        return;
      case "thread/tokenUsage/updated": {
        const total = params.tokenUsage?.total;
        if (total) this.hooks.onUsage(state.agentId, { inputTokens: total.inputTokens ?? 0, outputTokens: (total.outputTokens ?? 0) + (total.reasoningOutputTokens ?? 0) });
        return;
      }
      case "thread/status/changed": {
        const flags: string[] = params.status?.activeFlags ?? [];
        if (flags.length) this.hooks.onWaiting(state.agentId, flags.includes("waitingOnApproval") ? "Waiting on an approval" : "Waiting on input");
        return;
      }
      case "turn/completed": {
        const turn = params.turn ?? {};
        state.activeTurn = undefined;
        const outcome = turn.status === "completed" ? "completed" : turn.status === "interrupted" ? "interrupted" : "failed";
        const finalText = [...(turn.items ?? [])].reverse().find((item: Json) => item.type === "agentMessage")?.text ?? state.lastMessage;
        const queued = state.queue.splice(0);
        this.hooks.onTurnEnd(state.agentId, { outcome, message: String(finalText ?? ""), error: turn.error?.message, deliveredQueue: queued.length > 0 && outcome !== "interrupted" });
        if (queued.length && outcome !== "interrupted") {
          void this.startTurn(params.threadId, queued.join("\n\n")).catch((error) =>
            this.hooks.onTurnEnd(state.agentId, { outcome: "failed", message: "", error: String(error.message ?? error) }),
          );
        }
        return;
      }
    }
  }

  private async startTurn(threadId: string, text: string): Promise<void> {
    const response = await this.call("turn/start", { threadId, input: textInput(text), sandboxPolicy: this.threads.get(threadId)?.policy ?? null });
    const state = this.threads.get(threadId);
    if (state && response?.turn?.id) state.activeTurn = response.turn.id;
  }

  private async ensureLoaded(agent: AgentRecord, instructions: string): Promise<string> {
    if (!agent.sessionId) throw new Error(`Agent ${agent.id} has no Codex thread.`);
    if (!this.threads.has(agent.sessionId)) {
      this.threads.set(agent.sessionId, { agentId: agentKey(agent), policy: sandboxPolicy(agent), lastMessage: agent.lastMessage ?? "", queue: [] });
      try {
        await this.call("thread/resume", {
          threadId: agent.sessionId,
          cwd: agent.cwd,
          approvalPolicy: "never",
          sandbox: "workspace-write",
          developerInstructions: instructions,
          excludeTurns: true,
        });
      } catch (error) {
        this.threads.delete(agent.sessionId);
        throw error;
      }
    }
    return agent.sessionId;
  }

  async start(agent: AgentRecord, brief: string, instructions: string): Promise<{ sessionId: string }> {
    const response = await this.call("thread/start", {
      cwd: agent.cwd,
      model: agent.model || null,
      approvalPolicy: "never",
      sandbox: "workspace-write",
      developerInstructions: instructions,
      serviceName: "codex-projects-plugin",
    });
    const threadId: string = response.thread.id;
    this.threads.set(threadId, { agentId: agentKey(agent), policy: sandboxPolicy(agent), lastMessage: "", queue: [] });
    this.hooks.onSession(agentKey(agent), threadId);
    const turn = await this.call("turn/start", { threadId, input: textInput(brief), effort: agent.effort || null, sandboxPolicy: sandboxPolicy(agent) });
    const state = this.threads.get(threadId);
    if (state && turn?.turn?.id) state.activeTurn = turn.turn.id;
    this.hooks.onWorking(agentKey(agent), turn?.turn?.id);
    return { sessionId: threadId };
  }

  async send(agent: AgentRecord, text: string, mode: "queue" | "steer", instructions: string): Promise<SendResult> {
    const threadId = await this.ensureLoaded(agent, instructions);
    const state = this.threads.get(threadId)!;
    if (state.activeTurn) {
      if (mode === "steer") {
        await this.call("turn/steer", { threadId, input: textInput(text), expectedTurnId: state.activeTurn });
        return "steered";
      }
      state.queue.push(text);
      return "queued";
    }
    await this.startTurn(threadId, text);
    this.hooks.onWorking(agentKey(agent), state.activeTurn);
    return "started";
  }

  async stop(agent: AgentRecord): Promise<void> {
    const state = agent.sessionId ? this.threads.get(agent.sessionId) : undefined;
    if (!state?.activeTurn || !agent.sessionId) return;
    state.queue = [];
    await this.call("turn/interrupt", { threadId: agent.sessionId, turnId: state.activeTurn });
  }

  isRunning(key: string): boolean {
    for (const state of this.threads.values()) if (state.agentId === key && state.activeTurn) return true;
    return false;
  }

  async transcript(agent: AgentRecord): Promise<TranscriptItem[]> {
    if (!agent.sessionId) return [];
    const response = await this.call("thread/read", { threadId: agent.sessionId, includeTurns: true });
    const items: TranscriptItem[] = [];
    for (const turn of response?.thread?.turns ?? []) {
      for (const item of turn.items ?? []) {
        if (item.type === "userMessage") {
          const text = (item.content ?? []).filter((part: Json) => part.type === "text").map((part: Json) => part.text).join("\n");
          if (text) items.push({ role: "user", text });
        } else if (item.type === "agentMessage" && item.text) {
          items.push({ role: "assistant", text: item.text });
        } else if (item.type === "commandExecution") {
          items.push({ role: "tool", text: `$ ${item.command}${item.exitCode != null ? ` (exit ${item.exitCode})` : ""}` });
        } else if (item.type === "fileChange") {
          const files = (item.changes ?? []).map((change: Json) => change.path).filter(Boolean);
          items.push({ role: "tool", text: `Edited ${files.join(", ") || "files"}` });
        }
      }
    }
    return items;
  }

  async listModels(): Promise<ModelOption[]> {
    const models: ModelOption[] = [];
    let cursor: string | null = null;
    do {
      const page: Json = await this.call("model/list", { cursor, limit: 50 });
      for (const model of page.data ?? []) {
        if (model.hidden) continue;
        models.push({
          id: model.model ?? model.id,
          label: model.displayName ?? model.model ?? model.id,
          efforts: (model.supportedReasoningEfforts ?? []).map((option: Json) => option.reasoningEffort ?? option.effort ?? option).filter((value: unknown) => typeof value === "string"),
          defaultEffort: model.defaultReasoningEffort ?? "medium",
          isDefault: Boolean(model.isDefault),
        });
      }
      cursor = page.nextCursor ?? null;
    } while (cursor);
    return models;
  }

  async listWorkspaces(exclude: string[]): Promise<string[]> {
    const page: Json = await this.call("thread/list", { limit: 200, sortKey: "updated_at" });
    const skip = [path.join(os.homedir(), "Projects", "Codex") + path.sep, os.tmpdir(), "/private/tmp", "/tmp", ...exclude];
    const seen = new Set<string>();
    for (const thread of page.data ?? []) {
      const cwd: string | undefined = thread.cwd;
      if (!cwd || seen.has(cwd) || cwd === os.homedir()) continue;
      if (skip.some((prefix) => cwd.startsWith(prefix)) || !existsSync(cwd)) continue;
      seen.add(cwd);
    }
    return [...seen].slice(0, 20);
  }

  async adoptThread(threadId: string, name: string): Promise<{ renamed: boolean }> {
    const read: Json = await this.call("thread/read", { threadId, includeTurns: false });
    if (read.thread?.name === name) return { renamed: false };
    await this.call("thread/name/set", { threadId, name });
    return { renamed: true };
  }

  async archiveThread(threadId: string): Promise<{ archived: boolean }> {
    try {
      await withAppServer(this.binary, this.version, (call) => call("thread/archive", { threadId }));
      return { archived: true };
    } catch {
      return { archived: false };
    }
  }

  async relocateThread(threadId: string, cwd: string, name: string): Promise<{ threadId: string; moved: boolean; archived: boolean }> {
    return withAppServer(this.binary, this.version, async (call) => {
      const read: Json = await call("thread/read", { threadId, includeTurns: false });
      const thread = read.thread;
      if (!thread) throw new Error(`Thread ${threadId} was not found.`);
      if (!existsSync(cwd) || path.resolve(thread.cwd ?? "") === path.resolve(cwd)) {
        if (thread.name !== name) await call("thread/name/set", { threadId, name });
        return { threadId, moved: false, archived: false };
      }
      const fork: Json = await call("thread/fork", { threadId, cwd }, 90_000);
      const next: string | undefined = fork.thread?.id;
      if (!next) throw new Error("Codex did not return the moved thread.");
      await call("thread/name/set", { threadId: next, name });
      const archived = await call("thread/archive", { threadId }).then(
        () => true,
        () => false,
      );
      return { threadId: next, moved: true, archived };
    });
  }

  async dispose(): Promise<void> {
    this.child?.kill();
  }
}
