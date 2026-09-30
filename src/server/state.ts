import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import type { ModelOption, Snapshot } from "../shared/types.ts";
import { VERSION } from "../shared/version.ts";
import { readJson, writeJsonAtomic } from "../core/fsutil.ts";
import { paths, rootDir } from "../core/paths.ts";
import { getProject, listProjects, projectDetail, projectSummary, updateProject } from "../core/store.ts";
import { callDaemon, daemonStatus } from "../daemon/client.ts";

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

export async function bindThread(threadId: string | undefined, slug: string): Promise<void> {
  await rememberProject(slug);
  if (!threadId) return;
  const map = (await readJson<Record<string, string>>(threadsFile())) ?? {};
  if (map[threadId] !== slug) await writeJsonAtomic(threadsFile(), { ...map, [threadId]: slug });
  const project = await getProject(slug);
  if (project.coordinatorThreadId && project.coordinatorThreadId !== threadId) return;
  if (!project.coordinatorThreadId) await updateProject(slug, { coordinatorThreadId: threadId });
  void callDaemon("thread.adopt", { threadId, name: project.name }, 30_000).catch(() => undefined);
}

let optionsCache: { at: number; models: ModelOption[]; workspaces: string[] } | undefined;

export async function createOptions(): Promise<{ models: ModelOption[]; workspaces: string[] }> {
  if (optionsCache && Date.now() - optionsCache.at < 60_000) return optionsCache;
  const [models, workspaces] = await Promise.all([
    callDaemon<ModelOption[]>("models.list", {}, 30_000).catch(() => [] as ModelOption[]),
    callDaemon<string[]>("workspaces.list", { exclude: [paths.root()] }, 30_000).catch(() => [] as string[]),
  ]);
  const known = (await listProjects(true)).flatMap((project) => project.repos);
  optionsCache = { at: Date.now(), models, workspaces: [...new Set([...known, ...workspaces])] };
  return optionsCache;
}

export async function snapshot(requested?: string, threadId?: string): Promise<Snapshot> {
  const projects = await listProjects();
  const summaries = await Promise.all(projects.map(projectSummary));
  summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const threadProject = await projectForThread(threadId);
  const preferred = requested || threadProject || (await lastProject());
  const slug = projects.find((project) => project.slug === preferred)?.slug ?? summaries[0]?.slug;
  const service = await daemonStatus();
  return {
    version: VERSION,
    root: rootDir(),
    service: { running: service.running, pid: service.pid },
    codex: await codexAvailable(),
    projects: summaries,
    current: slug ? await projectDetail(slug) : undefined,
    threadId,
    threadProject,
  };
}
