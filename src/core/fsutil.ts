import { link, mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export async function readText(file: string, fallback = ""): Promise<string> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

export async function writeTextAtomic(file: string, text: string): Promise<void> {
  await ensureDir(path.dirname(file));
  const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temp, text, "utf8");
  await rename(temp, file);
}

export async function readJson<T>(file: string): Promise<T | undefined> {
  const text = await readText(file);
  if (!text.trim()) return undefined;
  return JSON.parse(text) as T;
}

export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await writeTextAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

export async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

export async function mtimeIso(file: string): Promise<string> {
  try {
    return (await stat(file)).mtime.toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

function contains(root: string, target: string): boolean {
  return target === root || target.startsWith(root + path.sep);
}

async function realpathOfNearest(target: string): Promise<string> {
  const missing: string[] = [];
  let current = target;
  for (;;) {
    try {
      return path.join(await realpath(current), ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) return target;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

export function insideRoot(root: string, relative: string): string {
  const normalizedRoot = path.resolve(root);
  const resolved = path.resolve(normalizedRoot, relative);
  if (!contains(normalizedRoot, resolved)) throw new Error(`Path escapes its folder: ${relative}`);
  return resolved;
}

export async function insideRootReal(root: string, relative: string): Promise<string> {
  const resolved = insideRoot(root, relative);
  const realRoot = await realpathOfNearest(path.resolve(root));
  const realTarget = await realpathOfNearest(resolved);
  if (!contains(realRoot, realTarget)) throw new Error(`Path escapes its folder through a link: ${relative}`);
  return resolved;
}

const LOCK_STALE_MS = 15_000;
const LOCK_WAIT_MS = 5_000;
const TAKEOVER_STALE_MS = 10_000;

export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface LockOwner {
  pid: number;
  ageMs: number;
}

async function lockOwner(lock: string): Promise<LockOwner | undefined> {
  try {
    const [text, info] = await Promise.all([readFile(lock, "utf8"), stat(lock)]);
    return { pid: Number(text.trim()), ageMs: Date.now() - info.mtimeMs };
  } catch {
    return undefined;
  }
}

export async function tryLockFile(lock: string, isStale: (owner: LockOwner) => boolean): Promise<boolean> {
  const stamp = `${process.pid}\n`;
  if (await createExclusive(lock, stamp)) return true;
  const takeover = `${lock}.takeover`;
  if (!(await createExclusive(takeover, stamp))) {
    const guard = await lockOwner(takeover);
    if (guard && guard.ageMs > TAKEOVER_STALE_MS && !processAlive(guard.pid)) await rm(takeover, { force: true });
    return false;
  }
  try {
    const owner = await lockOwner(lock);
    if (owner && isStale(owner)) await rm(lock, { force: true });
    return await createExclusive(lock, stamp);
  } finally {
    await rm(takeover, { force: true });
  }
}

export async function withFileLock<T>(file: string, work: () => Promise<T>): Promise<T> {
  const lock = `${file}.lock`;
  await ensureDir(path.dirname(file));
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (!(await tryLockFile(lock, (owner) => !processAlive(owner.pid) || owner.ageMs > LOCK_STALE_MS))) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${path.basename(file)}.`);
    await new Promise((resolve) => setTimeout(resolve, 20 + Math.random() * 40));
  }
  try {
    return await work();
  } finally {
    await rm(lock, { force: true });
  }
}

export async function createExclusive(file: string, text: string): Promise<boolean> {
  await ensureDir(path.dirname(file));
  const staged = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.new`;
  await writeFile(staged, text, { flag: "wx" });
  try {
    await link(staged, file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    await rm(staged, { force: true });
  }
}

export function slugify(text: string, max = 40): string {
  const slug = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  return slug || "untitled";
}

export function nowIso(): string {
  return new Date().toISOString();
}
