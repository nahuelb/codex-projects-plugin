import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

export function rootDir(): string {
  const override = process.env.PROJECTS_COORDINATOR_HOME;
  return override ? path.resolve(override) : path.join(os.homedir(), ".projects-coordinator");
}

export const paths = {
  root: () => rootDir(),
  projects: () => path.join(rootDir(), "projects"),
  project: (slug: string) => path.join(rootDir(), "projects", slug),
  projectJson: (slug: string) => path.join(rootDir(), "projects", slug, "project.json"),
  instructions: (slug: string) => path.join(rootDir(), "projects", slug, "INSTRUCTIONS.md"),
  notes: (slug: string) => path.join(rootDir(), "projects", slug, "notes.md"),
  memoryIndex: (slug: string) => path.join(rootDir(), "projects", slug, "MEMORY.md"),
  memoryDir: (slug: string) => path.join(rootDir(), "projects", slug, "memory"),
  agentsDir: (slug: string) => path.join(rootDir(), "projects", slug, "agents"),
  agentJson: (slug: string, id: string) => path.join(rootDir(), "projects", slug, "agents", `${id}.json`),
  agentDir: (slug: string, id: string) => path.join(rootDir(), "projects", slug, "agents", id),
  inboxDir: (slug: string) => path.join(rootDir(), "projects", slug, "inbox"),
  inboxDoneDir: (slug: string) => path.join(rootDir(), "projects", slug, "inbox", "done"),
  workDir: (slug: string, id: string) => path.join(rootDir(), "projects", slug, "work", id),
  worktreesDir: (slug: string) => path.join(rootDir(), "worktrees", slug),
  user: () => path.join(rootDir(), "user"),
  preferences: () => path.join(rootDir(), "user", "preferences.md"),
  run: () => path.join(rootDir(), "run"),
  socket: () => socketPath(),
  pidFile: () => path.join(rootDir(), "run", "coordd.pid"),
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
