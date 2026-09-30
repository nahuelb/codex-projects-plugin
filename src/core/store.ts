import { readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  PROJECT_COLORS,
  PROJECT_ICONS,
  type AgentGroup,
  type AgentRecord,
  type AgentView,
  type FileNode,
  type ProjectFiles,
  type FileScope,
  type InboxItem,
  type MemoryEntry,
  type ProjectColor,
  type ProjectDetail,
  type ProjectIcon,
  type ProjectRecord,
  type ProjectSummary,
} from "../shared/types.ts";
import {
  ensureDir,
  exists,
  insideRoot,
  mtimeIso,
  nowIso,
  readJson,
  readText,
  slugify,
  writeJsonAtomic,
  writeTextAtomic,
} from "./fsutil.ts";
import { parseFrontmatter, parseNotes, renderFrontmatter } from "./markdown.ts";
import { PROJECT_SUBDIRS, paths } from "./paths.ts";

export const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const;
export const MEMORY_INDEX_MAX_LINES = 200;

const EMPTY_NOTES = "<tldr>\n</tldr>\n";

const DEFAULT_PREFERENCES = "# Preferences\n\nCross-project preferences. The coordinator saves one only when you state it, correct an agent, or repeat it.\n";

export interface NewProjectInput {
  name: string;
  goal?: string;
  icon?: string;
  color?: string;
  repos?: string[];
  model?: string;
  effort?: string;
  instructions?: string;
  prFollowUp?: boolean;
}

export type ProjectPatch = Partial<Omit<NewProjectInput, "instructions">> & { archived?: boolean; instructions?: string; coordinatorThreadId?: string };

function pickIcon(value: string | undefined, fallback: ProjectIcon): ProjectIcon {
  return (PROJECT_ICONS as readonly string[]).includes(value ?? "") ? (value as ProjectIcon) : fallback;
}

function pickColor(value: string | undefined, fallback: ProjectColor): ProjectColor {
  return (PROJECT_COLORS as readonly string[]).includes(value ?? "") ? (value as ProjectColor) : fallback;
}

function normalizeRepos(repos: string[] | undefined): string[] {
  return [...new Set((repos ?? []).map((repo) => repo.trim()).filter(Boolean).map((repo) => path.resolve(repo.replace(/^~(?=$|\/)/, process.env.HOME ?? "~"))))];
}

export async function ensureRoot(): Promise<void> {
  await ensureDir(paths.projects());
  await ensureDir(paths.run());
  await ensureDir(paths.user());
  for (const dir of ["workflows", "principles"]) await ensureDir(path.join(paths.user(), dir));
  if (!(await exists(paths.preferences()))) await writeTextAtomic(paths.preferences(), DEFAULT_PREFERENCES);
}

export async function listProjects(includeArchived = false): Promise<ProjectRecord[]> {
  await ensureRoot();
  const entries = await readdir(paths.projects(), { withFileTypes: true });
  const records: ProjectRecord[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const record = await readJson<ProjectRecord>(paths.projectJson(entry.name));
    if (record && (includeArchived || !record.archived)) records.push(record);
  }
  return records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function getProject(slug: string): Promise<ProjectRecord> {
  const record = await readJson<ProjectRecord>(paths.projectJson(slug));
  if (!record) throw new Error(`No project named "${slug}". Use project_list to see projects.`);
  return record;
}

export async function resolveProject(slugOrName: string): Promise<ProjectRecord> {
  const direct = await readJson<ProjectRecord>(paths.projectJson(slugify(slugOrName)));
  if (direct) return direct;
  const all = await listProjects(true);
  const lowered = slugOrName.trim().toLowerCase();
  const found = all.find((project) => project.slug === lowered || project.name.toLowerCase() === lowered);
  if (!found) throw new Error(`No project named "${slugOrName}". Use project_list to see projects.`);
  return found;
}

export async function createProject(input: NewProjectInput): Promise<ProjectRecord> {
  await ensureRoot();
  const name = input.name.trim();
  if (!name) throw new Error("A project needs a name.");
  let slug = slugify(name, 32);
  for (let n = 2; await exists(paths.project(slug)); n += 1) slug = `${slugify(name, 28)}-${n}`;
  const repos = normalizeRepos(input.repos);
  for (const repo of repos) {
    if (!(await exists(repo))) throw new Error(`Repository folder not found: ${repo}`);
  }
  const now = nowIso();
  const record: ProjectRecord = {
    slug,
    name,
    goal: (input.goal ?? "").trim(),
    icon: pickIcon(input.icon, PROJECT_ICONS[Math.floor(Math.random() * PROJECT_ICONS.length)]),
    color: pickColor(input.color, "gray"),
    repos,
    model: input.model?.trim() || undefined,
    effort: input.effort?.trim() || undefined,
    prFollowUp: input.prFollowUp ?? true,
    createdAt: now,
    updatedAt: now,
  };
  for (const dir of PROJECT_SUBDIRS) await ensureDir(path.join(paths.project(slug), dir));
  await writeJsonAtomic(paths.projectJson(slug), record);
  await writeTextAtomic(paths.instructions(slug), (input.instructions ?? "").trim() + "\n");
  await writeTextAtomic(paths.notes(slug), EMPTY_NOTES);
  await writeTextAtomic(paths.memoryIndex(slug), "");
  return record;
}

export async function updateProject(slug: string, patch: ProjectPatch): Promise<ProjectRecord> {
  const current = await getProject(slug);
  const repos = patch.repos ? normalizeRepos(patch.repos) : current.repos;
  for (const repo of repos) {
    if (!(await exists(repo))) throw new Error(`Repository folder not found: ${repo}`);
  }
  const next: ProjectRecord = {
    ...current,
    name: patch.name?.trim() || current.name,
    goal: patch.goal !== undefined ? patch.goal.trim() : current.goal,
    icon: pickIcon(patch.icon, current.icon),
    color: pickColor(patch.color, current.color),
    repos,
    model: patch.model !== undefined ? patch.model.trim() || undefined : current.model,
    effort: patch.effort !== undefined ? patch.effort.trim() || undefined : current.effort,
    coordinatorThreadId: patch.coordinatorThreadId ?? current.coordinatorThreadId,
    prFollowUp: patch.prFollowUp ?? current.prFollowUp ?? true,
    archived: patch.archived ?? current.archived,
    updatedAt: nowIso(),
  };
  await writeJsonAtomic(paths.projectJson(slug), next);
  if (patch.instructions !== undefined) await writeTextAtomic(paths.instructions(slug), patch.instructions.trim() + "\n");
  return next;
}

export async function touchProject(slug: string): Promise<void> {
  const current = await readJson<ProjectRecord>(paths.projectJson(slug));
  if (current) await writeJsonAtomic(paths.projectJson(slug), { ...current, updatedAt: nowIso() });
}

export const readInstructions = (slug: string) => readText(paths.instructions(slug));
export const readNotes = (slug: string) => readText(paths.notes(slug), EMPTY_NOTES);

export async function writeNotes(slug: string, text: string): Promise<void> {
  await getProject(slug);
  await writeTextAtomic(paths.notes(slug), text.trim() + "\n");
  await touchProject(slug);
}

export const readPreferences = () => readText(paths.preferences(), DEFAULT_PREFERENCES);

export async function writePreferences(text: string): Promise<void> {
  await ensureRoot();
  await writeTextAtomic(paths.preferences(), text.trim() + "\n");
}

export async function listMemory(slug: string): Promise<MemoryEntry[]> {
  const dir = paths.memoryDir(slug);
  if (!(await exists(dir))) return [];
  const entries: MemoryEntry[] = [];
  for (const file of (await readdir(dir)).filter((name) => name.endsWith(".md")).sort()) {
    const { data } = parseFrontmatter(await readText(path.join(dir, file)));
    const type = (MEMORY_TYPES as readonly string[]).includes(data.type ?? "") ? (data.type as MemoryEntry["type"]) : "project";
    entries.push({
      file,
      name: data.name || file.replace(/\.md$/, ""),
      description: data.description || "",
      type,
      updatedAt: await mtimeIso(path.join(dir, file)),
    });
  }
  return entries;
}

export async function readMemoryFile(slug: string, file: string): Promise<string> {
  return readText(insideRoot(paths.memoryDir(slug), file));
}

const MEMORY_DESCRIPTION_MAX = 160;

export function clipDescription(text: string, max = MEMORY_DESCRIPTION_MAX): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (line.length <= max) return line;
  const cut = line.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.—-]+$/, "")}…`;
}

export async function rebuildMemoryIndex(slug: string): Promise<void> {
  const lines = (await listMemory(slug)).map((entry) => `- [${entry.name}](memory/${entry.file}) — ${clipDescription(entry.description)}`);
  await writeTextAtomic(paths.memoryIndex(slug), lines.slice(0, MEMORY_INDEX_MAX_LINES).join("\n") + (lines.length ? "\n" : ""));
}

export interface MemoryInput {
  name: string;
  description: string;
  type?: MemoryEntry["type"];
  body: string;
}

export async function writeMemory(slug: string, input: MemoryInput): Promise<MemoryEntry> {
  await getProject(slug);
  const file = `${slugify(input.name, 60)}.md`;
  const type = input.type ?? "project";
  await writeTextAtomic(
    insideRoot(paths.memoryDir(slug), file),
    renderFrontmatter({ name: input.name.trim(), description: input.description.trim(), type }, input.body),
  );
  await rebuildMemoryIndex(slug);
  await touchProject(slug);
  const entry = (await listMemory(slug)).find((item) => item.file === file);
  if (!entry) throw new Error("Memory write failed.");
  return entry;
}

export async function deleteMemory(slug: string, file: string): Promise<void> {
  await rm(insideRoot(paths.memoryDir(slug), file.endsWith(".md") ? file : `${file}.md`), { force: true });
  await rebuildMemoryIndex(slug);
}

export const readMemoryIndex = (slug: string) => readText(paths.memoryIndex(slug));

export async function listAgents(slug: string): Promise<AgentRecord[]> {
  const dir = paths.agentsDir(slug);
  if (!(await exists(dir))) return [];
  const agents: AgentRecord[] = [];
  for (const file of await readdir(dir)) {
    if (!file.endsWith(".json")) continue;
    const record = await readJson<AgentRecord>(path.join(dir, file));
    if (record) agents.push(record);
  }
  return agents.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getAgent(slug: string, id: string): Promise<AgentRecord> {
  const record = await readJson<AgentRecord>(paths.agentJson(slug, id));
  if (!record) throw new Error(`No agent ${id} in project ${slug}.`);
  return record;
}

export async function saveAgent(agent: AgentRecord): Promise<void> {
  await writeJsonAtomic(paths.agentJson(agent.slug, agent.id), { ...agent, updatedAt: nowIso() });
}

export async function nextAgentId(slug: string): Promise<string> {
  const ids = (await listAgents(slug)).map((agent) => Number(/^a-(\d+)$/.exec(agent.id)?.[1] ?? 0));
  return `a-${String(Math.max(0, ...ids) + 1).padStart(3, "0")}`;
}

export function agentGroup(agent: AgentRecord): AgentGroup {
  if (agent.resolved) return "resolved";
  if (agent.status === "failed" || agent.status === "waiting") return "needs_you";
  if (agent.status === "starting" || agent.status === "working") return "working";
  if (agent.report?.needsYou) return "needs_you";
  if (agent.status === "idle" && agent.report && !agent.reviewed) return "review";
  return "idle";
}

export const GROUP_ORDER: AgentGroup[] = ["needs_you", "review", "working", "idle", "resolved"];

export function viewAgents(agents: AgentRecord[]): AgentView[] {
  return agents
    .map((agent) => ({ ...agent, group: agentGroup(agent) }))
    .sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group) || b.updatedAt.localeCompare(a.updatedAt));
}

export async function addInbox(slug: string, item: Omit<InboxItem, "id" | "at">): Promise<InboxItem> {
  const at = nowIso();
  const id = `${at.replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomBytes(3).toString("hex")}`;
  const full: InboxItem = { id, at, ...item };
  await writeJsonAtomic(path.join(paths.inboxDir(slug), `${id}.json`), full);
  return full;
}

export async function listInbox(slug: string): Promise<InboxItem[]> {
  const dir = paths.inboxDir(slug);
  if (!(await exists(dir))) return [];
  const items: InboxItem[] = [];
  for (const file of (await readdir(dir)).filter((name) => name.endsWith(".json")).sort()) {
    const item = await readJson<InboxItem>(path.join(dir, file));
    if (item) items.push(item);
  }
  return items;
}

export async function ackInbox(slug: string, ids: string[]): Promise<number> {
  await ensureDir(paths.inboxDoneDir(slug));
  let moved = 0;
  for (const id of ids) {
    const from = insideRoot(paths.inboxDir(slug), `${id}.json`);
    if (await exists(from)) {
      await rename(from, path.join(paths.inboxDoneDir(slug), `${id}.json`));
      moved += 1;
    }
  }
  return moved;
}

const BLANK_PROBE_BYTES = 512;

async function isBlankFile(file: string, size: number): Promise<boolean> {
  if (size === 0) return true;
  if (size > BLANK_PROBE_BYTES) return false;
  return !(await readText(file)).replace(/<\/?tldr>/gi, "").trim();
}

async function tree(root: string, relative: string, skip: Set<string>, depth: number): Promise<FileNode[]> {
  const dir = path.join(root, relative);
  if (!(await exists(dir))) return [];
  const nodes: FileNode[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || skip.has(path.join(relative, entry.name))) continue;
    const rel = path.join(relative, entry.name);
    const full = path.join(root, rel);
    if (entry.isDirectory()) {
      const children = depth > 0 ? await tree(root, rel, skip, depth - 1) : [];
      if (depth > 0 && !children.length) continue;
      nodes.push({ name: entry.name, path: rel, kind: "dir", updatedAt: await mtimeIso(full), children });
    } else if (entry.isFile()) {
      const info = await stat(full);
      if (await isBlankFile(full, info.size)) continue;
      nodes.push({ name: entry.name, path: rel, kind: "file", updatedAt: info.mtime.toISOString(), size: info.size });
    }
  }
  return nodes.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1));
}

const HIDDEN_PROJECT_PATHS = new Set(["project.json", "agents", "inbox", "work"]);

export async function projectFiles(slug: string): Promise<ProjectFiles> {
  return {
    roots: { project: paths.project(slug), user: paths.user() },
    project: await tree(paths.project(slug), "", HIDDEN_PROJECT_PATHS, 4),
    user: await tree(paths.user(), "", new Set(), 4),
  };
}

export interface ScopedFile {
  text: string;
  path: string;
  size: number;
  updatedAt: string;
  tooLarge?: boolean;
}

const MAX_EDITABLE_BYTES = 512 * 1024;

function scopedPath(slug: string, scope: FileScope, relative: string): string {
  const root = scope === "user" ? paths.user() : paths.project(slug);
  const first = relative.split(/[\\/]/).filter(Boolean)[0] ?? "";
  if (scope === "project" && HIDDEN_PROJECT_PATHS.has(first)) throw new Error(`${relative} is managed by Project Coordinator.`);
  return insideRoot(root, relative);
}

export async function readScopedFile(slug: string, scope: FileScope, relative: string): Promise<ScopedFile> {
  const file = scopedPath(slug, scope, relative);
  const info = await stat(file);
  if (!info.isFile()) throw new Error(`${relative} is not a file.`);
  const base = { path: file, size: info.size, updatedAt: info.mtime.toISOString() };
  if (info.size > MAX_EDITABLE_BYTES) return { ...base, text: "", tooLarge: true };
  return { ...base, text: await readText(file) };
}

export async function writeScopedFile(slug: string, scope: FileScope, relative: string, text: string, expectedUpdatedAt?: string): Promise<ScopedFile> {
  const file = scopedPath(slug, scope, relative);
  if (Buffer.byteLength(text) > MAX_EDITABLE_BYTES) throw new Error("The file is too large to save here.");
  if (expectedUpdatedAt && (await exists(file))) {
    const current = (await stat(file)).mtime.toISOString();
    if (current !== expectedUpdatedAt) throw new Error("The file changed on disk since you opened it. Reload it before you save.");
  }
  await writeTextAtomic(file, text);
  return readScopedFile(slug, scope, relative);
}

export async function projectSummary(project: ProjectRecord): Promise<ProjectSummary> {
  const agents = viewAgents(await listAgents(project.slug));
  const count = (group: AgentGroup) => agents.filter((agent) => agent.group === group).length;
  const latest = agents.reduce((max, agent) => (agent.updatedAt > max ? agent.updatedAt : max), project.updatedAt);
  return {
    slug: project.slug,
    name: project.name,
    icon: project.icon,
    color: project.color,
    workspace: project.repos[0],
    coordinatorThreadId: project.coordinatorThreadId,
    updatedAt: latest,
    needsYou: count("needs_you"),
    working: count("working"),
    review: count("review"),
  };
}

export async function projectDetail(slug: string): Promise<ProjectDetail> {
  const project = await getProject(slug);
  const notesRaw = await readNotes(slug);
  return {
    project,
    instructions: await readInstructions(slug),
    notes: parseNotes(notesRaw),
    notesRaw,
    agents: viewAgents(await listAgents(slug)),
    memory: await listMemory(slug),
    inbox: await listInbox(slug),
    files: await projectFiles(slug),
  };
}
