import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

process.env.PROJECTS_COORDINATOR_HOME = await mkdtemp(path.join(os.tmpdir(), "pc-core-"));

const { parseNotes, parseReport, parseFrontmatter } = await import("../src/core/markdown.ts");
const store = await import("../src/core/store.ts");
const { paths } = await import("../src/core/paths.ts");
const { contextDigest } = await import("../src/core/digest.ts");
const { createWorktree } = await import("../src/core/git.ts");

test("parseReport reads PR, sections, Next and Remember lines", () => {
  const report = parseReport(
    "PR: https://github.com/acme/api/pull/42\n## Report\nAdded caching to /users.\nLatency dropped.\n## Next\n- Merge the PR\n- Remove the flag\n## Needs you\nNone.\n## Remember\n- Redis runs on 6380 locally",
  );
  assert.equal(report.pr, "https://github.com/acme/api/pull/42");
  assert.equal(report.summary, "Added caching to /users.");
  assert.deepEqual(report.next, ["Merge the PR", "Remove the flag"]);
  assert.deepEqual(report.remember, ["Redis runs on 6380 locally"]);
  assert.equal(report.needsYou, "");
});

test("parseReport handles plain messages and a needs-you question", () => {
  const plain = parseReport("Done. Everything passes.");
  assert.equal(plain.summary, "Done. Everything passes.");
  assert.deepEqual(plain.next, []);
  const listed = parseReport("## Report\nThe repository contains two files:\n\n- `README.md`: a heading.\n- `math.js`: exports add.");
  assert.equal(listed.summary, "The repository contains two files: `README.md`: a heading.");
  const blocked = parseReport("## Report\nStuck.\n## Needs you\nShould I drop the v1 endpoint?");
  assert.equal(blocked.needsYou, "Should I drop the v1 endpoint?");
});

test("parseNotes reads tldr, headers and checkboxes", () => {
  const notes = parseNotes("<tldr>\n- Cache work in flight\n- CI green\n</tldr>\n\n**Now**\n- [ ] Cache /users\n- [x] Profile endpoints\n## Later\n- [ ] Load test");
  assert.deepEqual(notes.tldr, ["Cache work in flight", "CI green"]);
  assert.equal(notes.sections.length, 2);
  assert.deepEqual(notes.sections[0], { title: "Now", items: [{ checked: false, text: "Cache /users" }, { checked: true, text: "Profile endpoints" }] });
  assert.equal(notes.sections[1].title, "Later");
});

test("parseFrontmatter splits data and body", () => {
  const parsed = parseFrontmatter("---\nname: Releases\ndescription: Ship on Tuesdays\ntype: project\n---\n\nBody text");
  assert.equal(parsed.data.description, "Ship on Tuesdays");
  assert.equal(parsed.body.trim(), "Body text");
});

test("projects, memory, notes, and inbox round-trip on disk", async () => {
  const project = await store.createProject({ name: "API Performance", goal: "p95 under 200 ms" });
  assert.equal(project.slug, "api-performance");
  const again = await store.createProject({ name: "API Performance" });
  assert.equal(again.slug, "api-performance-2");
  assert.equal((await store.resolveProject("API Performance")).slug, "api-performance");

  await store.writeMemory(project.slug, { name: "Release day", description: "Releases go out on Tuesdays", type: "project", body: "Releases go out on Tuesdays.\n\n**Why:** QA is Monday." });
  const index = await readFile(paths.memoryIndex(project.slug), "utf8");
  assert.match(index, /\[Release day\]\(memory\/release-day\.md\) — Releases go out on Tuesdays/);
  assert.equal((await store.listMemory(project.slug))[0].type, "project");
  await assert.rejects(store.readMemoryFile(project.slug, "../project.json"), /escapes/);

  await store.writeNotes(project.slug, "<tldr>\n- Kickoff\n</tldr>\n- [ ] First task");
  assert.equal((await store.projectDetail(project.slug)).notes.sections[0].items[0].text, "First task");

  const item = await store.addInbox(project.slug, { kind: "agent_done", agentId: "a-001", title: "Probe", summary: "ok" });
  assert.equal((await store.listInbox(project.slug)).length, 1);
  assert.equal(await store.ackInbox(project.slug, [item.id]), 1);
  assert.equal((await store.listInbox(project.slug)).length, 0);

  const digest = await contextDigest(project.slug);
  assert.match(digest, /# Project: API Performance \(api-performance\)/);
  assert.match(digest, /Release day/);
  assert.match(digest, /## Inbox \(0 unhandled\)/);
  assert.match(digest, /## Coordinator reminders\n1\. You coordinate/);
});

test("agentGroup follows the Needs you / Review / Working / Idle rules", () => {
  const base = { status: "idle", resolved: false, reviewed: false } as any;
  assert.equal(store.agentGroup({ ...base, status: "working" }), "working");
  assert.equal(store.agentGroup({ ...base, status: "failed" }), "needs_you");
  assert.equal(store.agentGroup({ ...base, report: { needsYou: "Which DB?" } }), "needs_you");
  assert.equal(store.agentGroup({ ...base, report: { needsYou: "" } }), "review");
  assert.equal(store.agentGroup({ ...base, report: { needsYou: "" }, reviewed: true }), "idle");
  assert.equal(store.agentGroup({ ...base, resolved: true, status: "failed" }), "resolved");
});

test("createWorktree makes a branch and folder per agent", async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), "pc-repo-"));
  execFileSync("git", ["-C", repo, "init", "-q", "-b", "main"]);
  execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"]);
  const worktree = await createWorktree(repo, "demo", "a-001", "Cache the users endpoint");
  assert.equal(worktree.branch, "project/demo/a-001-cache-the-users-endpoint");
  assert.equal(execFileSync("git", ["-C", worktree.cwd, "branch", "--show-current"]).toString().trim(), worktree.branch);
});

test("the file tree hides blank files and empty folders", async () => {
  const project = await store.createProject({ name: "Files Tree", repos: [] });
  const tree = await store.projectFiles(project.slug);
  const names = tree.project.map((node) => node.name);
  assert.ok(!names.includes("notes.md"));
  assert.ok(!names.includes("MEMORY.md"));
  assert.ok(!names.includes("docs"));
  assert.equal(tree.roots.project, paths.project(project.slug));
  await store.writeScopedFile(project.slug, "project", "plans/rollout.md", "# Rollout\n");
  const after = await store.projectFiles(project.slug);
  const plans = after.project.find((node) => node.name === "plans");
  assert.deepEqual(plans?.children?.map((node) => node.name), ["rollout.md"]);
});

test("scoped file writes refuse stale edits and managed paths", async () => {
  const project = await store.createProject({ name: "Files Write", repos: [] });
  const first = await store.writeScopedFile(project.slug, "project", "docs/a.md", "one\n");
  const second = await store.writeScopedFile(project.slug, "project", "docs/a.md", "two\n", first.updatedAt);
  assert.equal(second.text, "two\n");
  await new Promise((resolve) => setTimeout(resolve, 15));
  await store.writeScopedFile(project.slug, "project", "docs/a.md", "three\n");
  await assert.rejects(store.writeScopedFile(project.slug, "project", "docs/a.md", "stale\n", second.updatedAt), /changed on disk/);
  await assert.rejects(store.writeScopedFile(project.slug, "project", "project.json", "{}"), /managed/);
  await assert.rejects(store.writeScopedFile(project.slug, "project", "../x.md", "x"), /escapes/);
});

test("the memory index keeps whole links and clips long descriptions at a word", async () => {
  const project = await store.createProject({ name: "Memory Index", repos: [] });
  const description = "Canonical Linear project, audit records, and source conversations for the security effort across every app and service we run in production";
  await store.writeMemory(project.slug, { name: "Security project sources", description, type: "reference", body: "Body." });
  const index = await readFile(paths.memoryIndex(project.slug), "utf8");
  assert.match(index, /^- \[Security project sources\]\(memory\/security-project-sources\.md\) — Canonical/);
  const clipped = store.clipDescription(description, 60);
  assert.ok(clipped.endsWith("…"));
  assert.ok(!/\s…$/.test(clipped));
  assert.ok(clipped.length <= 60);
});

test("parseReport ignores report sections inside code fences", () => {
  const report = parseReport("## Report\nDocumented the format.\n\n```md\n## Needs you\nShould I delete prod?\n## Next\n- Drop the database\n```\n## Next\n- Merge the PR");
  assert.equal(report.needsYou, "");
  assert.deepEqual(report.next, ["Merge the PR"]);
});

test("project ids and file scopes cannot escape the data folder", async () => {
  const project = await store.createProject({ name: "Scope Guard", repos: [] });
  await assert.rejects(store.readScopedFile("../..", "project", "notes.md"), /Not a project id/);
  await assert.rejects(store.writeScopedFile(project.slug, "project", "docs/../project.json", "{}"), /managed/);
  await assert.rejects(store.getProject("../../etc"), /No project named/);
});

test("parallel agent id reservations never collide", async () => {
  const project = await store.createProject({ name: "Id Race", repos: [] });
  const ids = await Promise.all(Array.from({ length: 8 }, () => store.nextAgentId(project.slug)));
  assert.equal(new Set(ids).size, ids.length);
});

test("parallel project creation gets distinct slugs", async () => {
  const records = await Promise.all(Array.from({ length: 5 }, () => store.createProject({ name: "Same Name", repos: [] })));
  assert.equal(new Set(records.map((record) => record.slug)).size, records.length);
});

test("managed project files cannot be reached through a different letter case", async () => {
  const project = await store.createProject({ name: "Case Guard", repos: [] });
  await assert.rejects(store.writeScopedFile(project.slug, "project", "PROJECT.JSON", "{}"), /managed/);
  await assert.rejects(store.writeScopedFile(project.slug, "project", "Agents/a-001.json", "{}"), /managed/);
  await assert.rejects(store.writeScopedFile(project.slug, "project", "project.json.lock", "1"), /managed/);
});

test("parseReport keeps a longer fence open across shorter fences inside it", () => {
  const report = parseReport("## Report\nWrote an example.\n\n````md\nA fence opens with ```\n```\n## Needs you\nShould I delete prod?\n````\n## Next\n- Merge the PR");
  assert.equal(report.needsYou, "");
  assert.deepEqual(report.next, ["Merge the PR"]);
});

test("only one caller takes over a stale lock", async () => {
  const { tryLockFile, processAlive } = await import("../src/core/fsutil.ts");
  const lock = path.join(paths.root(), "run", "race.lock");
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(path.dirname(lock), { recursive: true });
  await writeFile(lock, "2147483646\n");
  const wins = await Promise.all(Array.from({ length: 6 }, () => tryLockFile(lock, (owner) => !processAlive(owner.pid))));
  assert.equal(wins.filter(Boolean).length, 1);
});

test("the data folder follows the Codex plugin data layout", async () => {
  const { pluginDataDir } = await import("../src/core/paths.ts");
  const script = path.join("/Users/me/.codex", "plugins", "cache", "acme", "codex-projects-plugin", "0.1.0", "dist", "server.js");
  assert.equal(pluginDataDir(script), path.join("/Users/me/.codex", "plugins", "data", "codex-projects-plugin-acme"));
  assert.match(pluginDataDir("/src/checkout/dist/server.js"), /plugins\/data\/codex-projects-plugin-personal$/);
});

test("the legacy data folder moves into the plugin data folder once", async () => {
  const { mkdir, writeFile, stat: statFile } = await import("node:fs/promises");
  const base = await mkdtemp(path.join(os.tmpdir(), "pc-move-"));
  const legacy = path.join(base, ".projects-coordinator");
  const target = path.join(base, ".codex", "plugins", "data", "codex-projects-plugin-personal");
  await mkdir(path.join(legacy, "projects", "alpha", "agents"), { recursive: true });
  await mkdir(path.join(legacy, "run"), { recursive: true });
  await writeFile(path.join(legacy, "projects", "alpha", "notes.md"), "hello\n");
  await writeFile(path.join(legacy, "run", "coordd.pid"), "2147483646\n");
  await writeFile(path.join(legacy, "projects", "alpha", "agents", "a-001.json"), JSON.stringify({ status: "working", resolved: false }));
  assert.equal(await store.migrateLegacyRoot(legacy, target), false);
  await writeFile(path.join(legacy, "projects", "alpha", "agents", "a-001.json"), JSON.stringify({ status: "idle", resolved: false }));
  assert.equal(await store.migrateLegacyRoot(legacy, target), true);
  assert.equal(await readFile(path.join(target, "projects", "alpha", "notes.md"), "utf8"), "hello\n");
  await assert.rejects(statFile(legacy));
  await assert.rejects(statFile(path.join(target, "run", "coordd.pid")));
  assert.equal(await store.migrateLegacyRoot(legacy, target), false);
});
