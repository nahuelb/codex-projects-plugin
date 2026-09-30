import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { appendFile, cp } from "node:fs/promises";
import { ensureDir, exists, readText, slugify } from "./fsutil.ts";

const run = promisify(execFile);

export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-C", cwd, ...args], { maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim();
}

export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    return (await git(dir, ["rev-parse", "--is-inside-work-tree"])) === "true";
  } catch {
    return false;
  }
}

export async function repoRoot(dir: string): Promise<string> {
  return git(dir, ["rev-parse", "--show-toplevel"]);
}

export const WORKTREE_DIR = ".worktrees";
const WORKTREE_INCLUDE = ".worktreeinclude";

export interface Worktree {
  cwd: string;
  branch: string;
  base: string;
}

async function excludeWorktreeDir(root: string): Promise<void> {
  const common = await gitCommonDir(root);
  if (!common) return;
  const file = path.join(common, "info", "exclude");
  const text = await readText(file);
  const line = `/${WORKTREE_DIR}/`;
  if (text.split(/\r?\n/).some((entry) => entry.trim() === line)) return;
  await ensureDir(path.dirname(file));
  await appendFile(file, `${text && !text.endsWith("\n") ? "\n" : ""}${line}\n`);
}

async function copyWorktreeIncludes(root: string, cwd: string): Promise<number> {
  if (!(await exists(path.join(root, WORKTREE_INCLUDE)))) return 0;
  const listed = await git(root, ["ls-files", "--others", "--ignored", `--exclude-from=${WORKTREE_INCLUDE}`, "-z"]);
  let copied = 0;
  for (const relative of listed.split("\0").filter(Boolean)) {
    if (relative.startsWith(`${WORKTREE_DIR}/`) || relative.split("/").includes("..")) continue;
    await ensureDir(path.dirname(path.join(cwd, relative)));
    await cp(path.join(root, relative), path.join(cwd, relative), { force: false, errorOnExist: false });
    copied += 1;
  }
  return copied;
}

async function branchExists(root: string, branch: string): Promise<boolean> {
  return git(root, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).then(
    () => true,
    () => false,
  );
}

async function freeWorktreeName(root: string, stem: string): Promise<{ name: string; branch: string; cwd: string }> {
  for (let attempt = 1; attempt <= 50; attempt += 1) {
    const name = attempt === 1 ? stem : `${stem}-${attempt}`;
    const branch = `coordinator/${name}`;
    const cwd = path.join(root, WORKTREE_DIR, name);
    if (!(await exists(cwd)) && !(await branchExists(root, branch))) return { name, branch, cwd };
  }
  throw new Error(`No free worktree name for ${stem}.`);
}

export async function createTaskWorktree(repo: string, agentId: string, title: string, baseRef?: string): Promise<Worktree> {
  if (!(await isGitRepo(repo))) throw new Error(`${repo} is not a git repository. Use isolation "shared".`);
  const root = await repoRoot(repo);
  const { name, branch, cwd } = await freeWorktreeName(root, `${agentId}-${slugify(title, 30)}`);
  const base = await git(root, ["rev-parse", "--verify", `${baseRef?.trim() || "HEAD"}^{commit}`]);
  await excludeWorktreeDir(root);
  await git(root, ["worktree", "add", "-b", branch, cwd, base]);
  await copyWorktreeIncludes(root, cwd);
  return { cwd, branch, base };
}

export async function removeTaskWorktree(repo: string, cwd: string, branch?: string, base?: string): Promise<string> {
  const root = await repoRoot(repo);
  if (path.dirname(path.resolve(cwd)) !== path.join(root, WORKTREE_DIR)) return "kept: not a coordinator worktree";
  if (!(await exists(cwd))) return "worktree already gone";
  if (await git(cwd, ["status", "--porcelain"])) return "kept: the worktree has uncommitted changes";
  const ahead = branch && base ? await git(root, ["rev-list", "--count", `${base}..${branch}`]).catch(() => "1") : "1";
  await git(root, ["worktree", "remove", cwd]);
  if (branch && ahead === "0") {
    await git(root, ["branch", "-D", branch]).catch(() => "");
    return "worktree and its empty branch removed";
  }
  return "worktree removed; branch kept";
}

export async function gitCommonDir(cwd: string): Promise<string | undefined> {
  try {
    return path.resolve(cwd, await git(cwd, ["rev-parse", "--git-common-dir"]));
  } catch {
    return undefined;
  }
}
