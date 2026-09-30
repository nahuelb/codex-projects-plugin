import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

export function rootDir(): string {
  const override = process.env.PROJECTS_COORDINATOR_HOME;
  return override ? path.resolve(override) : path.join(os.homedir(), ".projects-coordinator");
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
