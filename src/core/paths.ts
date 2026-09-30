import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PLUGIN_NAME = "codex-projects-plugin";
const DEFAULT_MARKETPLACE = "personal";

export function codexHomeDir(): string {
  return process.env.CODEX_HOME ? path.resolve(process.env.CODEX_HOME) : path.join(os.homedir(), ".codex");
}

export function pluginDataDir(script = fileURLToPath(import.meta.url)): string {
  const parts = path.resolve(script).split(path.sep);
  const at = parts.lastIndexOf(PLUGIN_NAME);
  const installed = at >= 3 && parts[at - 3] === "plugins" && parts[at - 2] === "cache";
  const codexHome = installed ? parts.slice(0, at - 3).join(path.sep) || path.sep : codexHomeDir();
  const marketplace = installed ? parts[at - 1] : DEFAULT_MARKETPLACE;
  return path.join(codexHome, "plugins", "data", `${PLUGIN_NAME}-${marketplace}`);
}

export function legacyRootDir(): string {
  return path.join(os.homedir(), ".projects-coordinator");
}

export function rootDir(): string {
  const override = process.env.PROJECTS_COORDINATOR_HOME;
  if (override) return path.resolve(override);
  const preferred = pluginDataDir();
  return !existsSync(preferred) && existsSync(legacyRootDir()) ? legacyRootDir() : preferred;
}

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,79}$/;
const AGENT_ID_PATTERN = /^a-\d{3,6}$/;

export function checkSlug(slug: string): string {
  if (!SLUG_PATTERN.test(slug)) throw new Error(`Not a project id: ${JSON.stringify(slug)}`);
  return slug;
}

export function checkAgentId(id: string): string {
  if (!AGENT_ID_PATTERN.test(id)) throw new Error(`Not an agent id: ${JSON.stringify(id)}`);
  return id;
}

const projectDir = (slug: string) => path.join(rootDir(), "projects", checkSlug(slug));

export const paths = {
  root: () => rootDir(),
  projects: () => path.join(rootDir(), "projects"),
  project: (slug: string) => projectDir(slug),
  projectJson: (slug: string) => path.join(projectDir(slug), "project.json"),
  instructions: (slug: string) => path.join(projectDir(slug), "INSTRUCTIONS.md"),
  notes: (slug: string) => path.join(projectDir(slug), "notes.md"),
  memoryIndex: (slug: string) => path.join(projectDir(slug), "MEMORY.md"),
  memoryDir: (slug: string) => path.join(projectDir(slug), "memory"),
  agentsDir: (slug: string) => path.join(projectDir(slug), "agents"),
  agentJson: (slug: string, id: string) => path.join(projectDir(slug), "agents", `${checkAgentId(id)}.json`),
  agentDir: (slug: string, id: string) => path.join(projectDir(slug), "agents", checkAgentId(id)),
  inboxDir: (slug: string) => path.join(projectDir(slug), "inbox"),
  inboxDoneDir: (slug: string) => path.join(projectDir(slug), "inbox", "done"),
  workDir: (slug: string, id: string) => path.join(projectDir(slug), "work", checkAgentId(id)),
  worktreesDir: (slug: string) => path.join(rootDir(), "worktrees", checkSlug(slug)),
  user: () => path.join(rootDir(), "user"),
  preferences: () => path.join(rootDir(), "user", "preferences.md"),
  run: () => path.join(rootDir(), "run"),
  socket: () => socketPath(),
  pidFile: () => path.join(rootDir(), "run", "coordd.pid"),
  lockFile: () => path.join(rootDir(), "run", "coordd.lock"),
  daemonLog: () => path.join(rootDir(), "run", "coordd.log"),
};

export const PROJECT_SUBDIRS = ["docs", "plans", "internal", "memory", "agents", "inbox", "inbox/done", "work"];

const MAX_SOCKET_PATH = 100;

function socketPath(): string {
  const preferred = path.join(rootDir(), "run", "coordd.sock");
  if (preferred.length <= MAX_SOCKET_PATH) return preferred;
  const hash = createHash("sha256").update(rootDir()).digest("hex").slice(0, 12);
  return path.join(os.tmpdir(), `projects-coordd-${hash}.sock`);
}
