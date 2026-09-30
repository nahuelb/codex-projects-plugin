import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelOption } from "../shared/types.ts";
import { VERSION } from "../shared/version.ts";
import { withAppServer, type OneShotCall, type OneShotWait } from "../core/appserver.ts";

type Json = Record<string, any>;

const codexBinary = () => process.env.PROJECTS_CODEX_BIN || "codex";

const withCodex = <T>(work: (call: OneShotCall, wait: OneShotWait) => Promise<T>) => withAppServer(codexBinary(), VERSION, work);

const KICKOFF_TIMEOUT_MS = 180_000;

function coordinatorSkillPath(): string | undefined {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return [path.join(here, "..", "skills", "coordinator", "SKILL.md"), path.join(here, "..", "..", "skills", "coordinator", "SKILL.md")].find((file) => existsSync(file));
}

export function startCoordinatorThread(input: { cwd: string; name: string; kickoff: string; model?: string }): Promise<string> {
  return withCodex(async (call, wait) => {
    const started: Json = await call("thread/start", { cwd: input.cwd, model: input.model || null });
    const threadId: string | undefined = started.thread?.id;
    if (!threadId) throw new Error("Codex did not create the coordinator chat.");
    await call("thread/name/set", { threadId, name: input.name });
    const skill = coordinatorSkillPath();
    const finished = wait("turn/completed", (params) => params.threadId === threadId, KICKOFF_TIMEOUT_MS);
    await call("turn/start", {
      threadId,
      effort: "low",
      input: [...(skill ? [{ type: "skill", name: "coordinator", path: skill }] : []), { type: "text", text: input.kickoff, text_elements: [] }],
    });
    await finished;
    return threadId;
  });
}

export function renameThread(threadId: string, name: string): Promise<boolean> {
  return withCodex(async (call) => {
    const read: Json = await call("thread/read", { threadId, includeTurns: false });
    if (read.thread?.name === name) return false;
    await call("thread/name/set", { threadId, name });
    return true;
  });
}

export async function archiveThread(threadId: string): Promise<boolean> {
  try {
    await withCodex((call) => call("thread/archive", { threadId }));
    return true;
  } catch {
    return false;
  }
}

export function relocateThread(threadId: string, cwd: string, name: string): Promise<{ threadId: string; moved: boolean; archived: boolean }> {
  return withCodex(async (call) => {
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

export function listCreateOptions(exclude: string[]): Promise<{ models: ModelOption[]; workspaces: string[] }> {
  return withCodex(async (call) => {
    const models: ModelOption[] = [];
    let cursor: string | null = null;
    do {
      const page: Json = await call("model/list", { cursor, limit: 50 });
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
    const threads: Json = await call("thread/list", { limit: 200, sortKey: "updated_at" });
    const skip = [os.tmpdir(), "/private/tmp", "/tmp", ...exclude];
    const seen = new Set<string>();
    for (const thread of threads.data ?? []) {
      const cwd: string | undefined = thread.cwd;
      if (!cwd || seen.has(cwd) || cwd === os.homedir()) continue;
      if (skip.some((prefix) => cwd.startsWith(prefix)) || cwd.split(path.sep).includes(".worktrees") || !existsSync(cwd)) continue;
      seen.add(cwd);
    }
    return { models, workspaces: [...seen].slice(0, 20) };
  });
}
