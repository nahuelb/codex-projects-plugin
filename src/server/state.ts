import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import type { ModelOption, Snapshot } from "../shared/types.ts";
import { VERSION } from "../shared/version.ts";
import { readJson, withFileLock, writeJsonAtomic } from "../core/fsutil.ts";
import { paths, rootDir } from "../core/paths.ts";
import { refreshPullRequests, syncProject } from "../core/board.ts";
import { getProject, listProjects, projectDetail, projectSummary, updateProject } from "../core/store.ts";
import { archiveThread, listCreateOptions, relocateThread, renameThread } from "./codex.ts";

const run = promisify(execFile);

let codexCache: { at: number; value: boolean } | undefined;

export async function codexAvailable(): Promise<boolean> {
  if (codexCache && Date.now() - codexCache.at < 5 * 60_000) return codexCache.value;
  let value = false;
  try {
    await run(process.env.PROJECTS_CODEX_BIN || "codex", ["--version"], { timeout: 8_000 });
    value = true;
  } catch {
    value = false;
  }
  codexCache = { at: Date.now(), value };
  return value;
}

const uiStateFile = () => path.join(rootDir(), "run", "ui.json");
const threadsFile = () => path.join(rootDir(), "run", "threads.json");
const archiveFile = () => path.join(rootDir(), "run", "archive-pending.json");

async function archiveLater(threadIds: string[]): Promise<void> {
  const pending = await withFileLock(archiveFile(), async () => {
    const all = [...new Set([...((await readJson<string[]>(archiveFile())) ?? []), ...threadIds])];
    await writeJsonAtomic(archiveFile(), all);
    return all;
  });
  const archived: string[] = [];
  for (const threadId of pending) {
    if (await archiveThread(threadId)) archived.push(threadId);
  }
  if (!archived.length) return;
  await withFileLock(archiveFile(), async () => {
    const left = ((await readJson<string[]>(archiveFile())) ?? []).filter((threadId) => !archived.includes(threadId));
    await writeJsonAtomic(archiveFile(), left);
  });
}

export async function lastProject(): Promise<string | undefined> {
  return (await readJson<{ lastProject?: string }>(uiStateFile()))?.lastProject;
}

export async function rememberProject(slug: string): Promise<void> {
  await writeJsonAtomic(uiStateFile(), { lastProject: slug });
}

export async function projectForThread(threadId: string | undefined): Promise<string | undefined> {
  if (!threadId) return undefined;
  const map = (await readJson<Record<string, string>>(threadsFile())) ?? {};
  if (map[threadId]) return map[threadId];
  for (const project of await listProjects()) if (project.coordinatorThreadId === threadId) return project.slug;
  return undefined;
}

export const coordinatorThreadName = (name: string) => `Project Coordinator: ${name}`;

async function mapThread(threadId: string, slug: string): Promise<void> {
  await withFileLock(threadsFile(), async () => {
    const map = (await readJson<Record<string, string>>(threadsFile())) ?? {};
    if (map[threadId] !== slug) await writeJsonAtomic(threadsFile(), { ...map, [threadId]: slug });
  });
}

export async function coordinatorThread(slug: string): Promise<string | undefined> {
  const project = await getProject(slug);
  const threadId = project.coordinatorThreadId;
  const repo = project.repos[0];
  if (!threadId || !repo) return threadId;
  try {
    const moved = await relocateThread(threadId, repo, coordinatorThreadName(project.name));
    if (moved.moved) {
      await updateProject(slug, { coordinatorThreadId: moved.threadId });
      await mapThread(moved.threadId, slug);
    }
    void archiveLater(moved.moved && !moved.archived ? [threadId] : []).catch(() => undefined);
    return moved.threadId;
  } catch {
    return threadId;
  }
}

export async function bindThread(threadId: string | undefined, slug: string): Promise<void> {
  await rememberProject(slug);
  if (!threadId) return;
  await mapThread(threadId, slug);
  const project = await getProject(slug);
  if (project.coordinatorThreadId && project.coordinatorThreadId !== threadId) return;
  if (!project.coordinatorThreadId) await updateProject(slug, { coordinatorThreadId: threadId });
  void renameThread(threadId, coordinatorThreadName(project.name)).catch(() => undefined);
}

let optionsCache: { at: number; models: ModelOption[]; workspaces: string[] } | undefined;

export async function createOptions(): Promise<{ models: ModelOption[]; workspaces: string[] }> {
  if (optionsCache && Date.now() - optionsCache.at < 60_000) return optionsCache;
  const { models, workspaces } = await listCreateOptions([paths.root()]).catch(() => ({ models: [] as ModelOption[], workspaces: [] as string[] }));
  const known = (await listProjects(true)).flatMap((project) => project.repos);
  optionsCache = { at: Date.now(), models, workspaces: [...new Set([...known, ...workspaces])] };
  return optionsCache;
}

export async function syncBoards(slugs: string[]): Promise<void> {
  await Promise.all(slugs.map((slug) => syncProject(slug).catch(() => 0)));
  for (const slug of slugs) void refreshPullRequests(slug).catch(() => 0);
}

export async function snapshot(requested?: string, threadId?: string): Promise<Snapshot> {
  const projects = await listProjects();
  await syncBoards(projects.map((project) => project.slug));
  const summaries = await Promise.all(projects.map(projectSummary));
  summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const threadProject = await projectForThread(threadId);
  const preferred = requested || threadProject || (await lastProject());
  const slug = projects.find((project) => project.slug === preferred)?.slug ?? summaries[0]?.slug;
  return {
    version: VERSION,
    root: rootDir(),
    codex: await codexAvailable(),
    projects: summaries,
    current: slug ? await projectDetail(slug) : undefined,
    threadId,
    threadProject,
  };
}
