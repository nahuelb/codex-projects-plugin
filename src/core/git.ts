import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { exists, slugify } from "./fsutil.ts";
import { paths } from "./paths.ts";

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

export interface Worktree {
  cwd: string;
  branch: string;
  base: string;
}

export async function createWorktree(repo: string, slug: string, agentId: string, title: string, baseRef?: string): Promise<Worktree> {
  if (!(await isGitRepo(repo))) throw new Error(`${repo} is not a git repository. Use isolation "folder" or "checkout".`);
  const root = await repoRoot(repo);
  const base = baseRef?.trim() || (await git(root, ["rev-parse", "HEAD"]));
  const branch = `project/${slug}/${agentId}-${slugify(title, 30)}`;
  const cwd = path.join(paths.worktreesDir(slug), `${agentId}-${path.basename(root)}`);
  if (await exists(cwd)) throw new Error(`Worktree folder already exists: ${cwd}`);
  await git(root, ["worktree", "add", "-b", branch, cwd, base]);
  return { cwd, branch, base };
}

export async function removeWorktree(repo: string, cwd: string): Promise<string> {
  if (!(await exists(cwd))) return "worktree already gone";
  const status = await git(cwd, ["status", "--porcelain"]);
  if (status) return "kept: the worktree has uncommitted changes";
  await git(await repoRoot(repo), ["worktree", "remove", cwd]);
  return "worktree removed; branch kept";
}

export async function gitCommonDir(cwd: string): Promise<string | undefined> {
  try {
    return path.resolve(cwd, await git(cwd, ["rev-parse", "--git-common-dir"]));
  } catch {
    return undefined;
  }
}
