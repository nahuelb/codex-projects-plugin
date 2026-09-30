import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const target = process.argv[2];
if (!target) {
  console.error("Usage: node scripts/demo.ts <folder>\nCreates demo repositories in <folder>/repos and demo coordinator data in <folder>/data.");
  process.exit(1);
}
const folder = path.resolve(target.replace(/^~(?=$|\/)/, os.homedir()));
const marker = path.join(folder, ".coordinator-demo");
if (existsSync(folder) && !existsSync(marker) && readdirSync(folder).length > 0) {
  console.error(`${folder} is not empty and was not created by this script. Choose an empty folder.`);
  process.exit(1);
}
await mkdir(folder, { recursive: true });
await writeFile(marker, "Project Coordinator demo\n");

const dataDir = path.join(folder, "data");
const reposDir = path.join(folder, "repos");
process.env.PROJECTS_COORDINATOR_HOME = dataDir;

const store = await import("../src/core/store.ts");
const { paths } = await import("../src/core/paths.ts");
const { writeJsonAtomic } = await import("../src/core/fsutil.ts");
const { createTaskWorktree, WORKTREE_DIR } = await import("../src/core/git.ts");
const { taskNameFor } = await import("../src/core/board.ts");
type AgentRecord = import("../src/shared/types.ts").AgentRecord;
type PullRequestStatus = import("../src/shared/types.ts").PullRequestStatus;

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const hoursAgo = (hours: number) => minutesAgo(hours * 60);
const daysAgo = (days: number) => minutesAgo(days * 24 * 60);

const ORG = "https://github.com/pantry-demo";
const TRACKER = "https://linear.app/pantry-demo/issue";
const pr = (repo: string, number: number) => `${ORG}/${repo}/pull/${number}`;
const ticket = (id: string) => `[${id}](${TRACKER}/${id})`;

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "Pantry Demo", GIT_AUTHOR_EMAIL: "demo@example.com", GIT_COMMITTER_NAME: "Pantry Demo", GIT_COMMITTER_EMAIL: "demo@example.com" };
const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, env: gitEnv, stdio: "pipe" }).toString().trim();

async function writeTree(root: string, files: Record<string, string>): Promise<void> {
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), text);
  }
}

async function demoRepo(name: string, files: Record<string, string>): Promise<string> {
  const repo = path.join(reposDir, name);
  if (existsSync(path.join(repo, ".git"))) return repo;
  await writeTree(repo, files);
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "Initial commit"]);
  return repo;
}

const web = await demoRepo("pantry-web", {
  "README.md": "# pantry-web\n\nThe Pantry web app: meal plans, recipes, and shopping lists for families.\n\n```sh\npnpm install\npnpm dev\npnpm test\n```\n",
  "package.json": `${JSON.stringify({ name: "pantry-web", private: true, scripts: { dev: "next dev", build: "next build", test: "vitest run", e2e: "playwright test" } }, null, 2)}\n`,
  "app/lists/page.tsx": "export default function ListsPage() {\n  return <ShoppingLists />;\n}\n",
  "app/onboarding/steps.tsx": "export const steps = [\"Welcome\", \"Household\", \"Diet\", \"First plan\"];\n",
  "lib/flags.ts": "export const flags = { sharedLists: false, familyPlans: false, recipeImport: false };\n",
});
const api = await demoRepo("pantry-api", {
  "README.md": "# pantry-api\n\nFastify API and Postgres schema behind Pantry.\n\n```sh\npnpm install\npnpm dev\npnpm test\n```\n",
  "package.json": `${JSON.stringify({ name: "pantry-api", private: true, scripts: { dev: "tsx watch src/server.ts", test: "vitest run" } }, null, 2)}\n`,
  "src/server.ts": "import Fastify from \"fastify\";\n\nexport const app = Fastify();\n",
  "src/billing/plans.ts": "export const plans = { free: 0, plus: 499 };\n",
  "src/recipes/import.ts": "export async function importRecipe(url: string) {\n  throw new Error(`Not implemented: ${url}`);\n}\n",
});

const kept = new Map<string, string>();
for (const project of await store.listProjects(true).catch(() => [])) {
  if (project.coordinatorThreadId) kept.set(project.name, project.coordinatorThreadId);
}
await rm(paths.projects(), { recursive: true, force: true });
await store.ensureRoot();

async function project(input: Parameters<typeof store.createProject>[0]) {
  const record = await store.createProject(input);
  const threadId = kept.get(record.name);
  return threadId ? store.updateProject(record.slug, { coordinatorThreadId: threadId }) : record;
}

async function worktree(repo: string, id: string, title: string) {
  const cwd = path.join(repo, WORKTREE_DIR, `${id}-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "").slice(0, 30).replace(/-+$/, "")}`);
  if (existsSync(cwd)) return { cwd, branch: git(cwd, ["branch", "--show-current"]), base: git(repo, ["rev-parse", "HEAD"]) };
  const created = await createTaskWorktree(repo, id, title);
  return { cwd: created.cwd, branch: created.branch, base: created.base };
}

function pullRequest(url: string, state: Partial<PullRequestStatus>): PullRequestStatus {
  return { url, state: "OPEN", draft: false, checks: "passing", failing: [], review: "REVIEW_REQUIRED", checkedAt: minutesAgo(3), ...state };
}

async function agent(slug: string, input: Partial<AgentRecord> & Pick<AgentRecord, "id" | "title" | "task" | "status">, repo?: string): Promise<void> {
  const place = repo ? await worktree(repo, input.id, input.title) : undefined;
  const record: AgentRecord = {
    slug,
    taskName: taskNameFor(input.title),
    isolation: repo ? "worktree" : "shared",
    repo,
    cwd: place?.cwd ?? paths.project(slug),
    branch: place?.branch,
    baseSha: place?.base,
    createdAt: daysAgo(3),
    updatedAt: hoursAgo(2),
    reviewed: false,
    resolved: false,
    ...input,
  };
  await writeJsonAtomic(paths.agentJson(slug, record.id), record);
}

function report(summary: string, next: string[] = [], extra: { needsYou?: string; pr?: string; details?: string[] } = {}) {
  const text = [
    "## Report",
    summary,
    ...(extra.details ?? []).map((line) => `- ${line}`),
    extra.pr ? `PR: ${extra.pr}` : "",
    "## Next",
    ...(next.length ? next.map((line) => `- ${line}`) : ["- None."]),
    extra.needsYou ? `## Needs you\n${extra.needsYou}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return { text, summary, next, remember: [], needsYou: extra.needsYou ?? "", pr: extra.pr };
}

await store.writePreferences(`# Preferences

- Keep status updates short: what changed, what needs me, what is next.
- I review pull requests in the morning; batch review requests before 10:00.
- Frontend work: run the Playwright suite before asking for review.
`);

const launch = await project({
  name: "Pantry 2.0 Launch",
  goal: "Ship Pantry 2.0 on October 20: shared shopping lists, recipe import from any URL, and paid family plans.",
  icon: "rocket",
  color: "orange",
  repos: [web, api],
  instructions: `- One concern per pull request.
- Put every user-facing change behind a flag in \`lib/flags.ts\`.
- Run \`pnpm test\` before you open a pull request, and \`pnpm e2e\` for web changes.
- Use Stripe test mode only. Never read or write live keys.`,
});
const slug = launch.slug;
const projectFile = (relative: string) => path.join(paths.project(slug), relative);

await agent(slug, {
  id: "a-001",
  title: "Map both repositories",
  task: "Read pantry-web and pantry-api. Summarise the stack, how to run and test each, and recommend the first launch tasks.",
  isolation: "shared",
  repo: web,
  cwd: web,
  status: "idle",
  createdAt: daysAgo(6),
  updatedAt: daysAgo(6),
  finishedAt: daysAgo(6),
  report: report("Mapped pantry-web (Next.js 15, Vitest, Playwright) and pantry-api (Fastify, Postgres, Stripe). Recommended six launch tasks.", []),
  reviewed: true,
  resolved: true,
});

await agent(
  slug,
  {
    id: "a-002",
    title: "Family plan billing",
    task: "Add per-seat family plans with Stripe subscriptions behind the familyPlans flag (PAN-142).",
    status: "waiting",
    createdAt: daysAgo(2),
    updatedAt: minutesAgo(18),
    finishedAt: minutesAgo(18),
    report: report(
      "Family plans work end to end in Stripe test mode: create, add a member, remove a member, cancel.",
      ["Add the plan picker to pantry-web once proration is decided"],
      {
        pr: pr("pantry-api", 214),
        needsYou: "When someone joins a family plan mid-cycle, should we prorate the seat now, or start billing at the next renewal? Proration is fairer; next-renewal is simpler and avoids small invoices.",
      },
    ),
    pr: pullRequest(pr("pantry-api", 214), { draft: true }),
  },
  api,
);

await agent(
  slug,
  {
    id: "a-003",
    title: "Shared shopping lists",
    task: "Let family members edit the same shopping list live, with optimistic updates and conflict-free merges (PAN-137).",
    status: "idle",
    createdAt: daysAgo(3),
    updatedAt: minutesAgo(42),
    finishedAt: minutesAgo(42),
    report: report(
      "Shopping lists now sync live between family members. Edits apply optimistically and merge without conflicts. Added 14 tests.",
      ["Merge #318 after the API deploy on Wednesday", "Add a two-device Playwright test"],
      { pr: pr("pantry-web", 318) },
    ),
    pr: pullRequest(pr("pantry-web", 318), { review: "APPROVED" }),
  },
  web,
);

await agent(
  slug,
  {
    id: "a-004",
    title: "Recipe import from URL",
    task: "Import a recipe from any URL: parse JSON-LD first, then fall back to microdata and readable HTML (PAN-151).",
    status: "working",
    createdAt: hoursAgo(5),
    updatedAt: minutesAgo(1),
    activity: "Running pnpm test",
  },
  api,
);

await agent(
  slug,
  {
    id: "a-005",
    title: "Onboarding redesign",
    task: "Rebuild onboarding as four short steps (welcome, household, diet, first plan) behind the onboardingV2 flag.",
    status: "working",
    createdAt: hoursAgo(3),
    updatedAt: minutesAgo(2),
    activity: "Editing app/onboarding/steps.tsx",
  },
  web,
);

await agent(
  slug,
  {
    id: "a-006",
    title: "Offline mode",
    task: "Cache the current meal plan and shopping lists for offline use, and queue edits until the device is back online (PAN-139).",
    status: "working",
    createdAt: daysAgo(2),
    updatedAt: minutesAgo(4),
    activity: "Fixing the failing e2e (webkit) check",
    report: report("Meal plans and lists work offline; edits queue in IndexedDB and replay on reconnect.", [], { pr: pr("pantry-web", 320) }),
    pr: pullRequest(pr("pantry-web", 320), { checks: "failing", failing: ["e2e (webkit)"] }),
  },
  web,
);

await agent(
  slug,
  {
    id: "a-007",
    title: "Accessibility audit",
    task: "Audit pantry-web against WCAG 2.2 AA and fix what can be fixed without design changes.",
    status: "idle",
    createdAt: daysAgo(4),
    updatedAt: daysAgo(1),
    finishedAt: daysAgo(1),
    report: report("Fixed 23 contrast, focus, and label issues. Two need design input; they are listed in the plan.", [], { pr: pr("pantry-web", 309) }),
    pr: pullRequest(pr("pantry-web", 309), { state: "MERGED", review: "APPROVED" }),
    reviewed: true,
  },
  web,
);

await agent(
  slug,
  {
    id: "a-008",
    title: "Pricing page copy",
    task: "Update the pricing page for family plans: the new tier, a comparison table, and FAQ entries.",
    status: "idle",
    createdAt: hoursAgo(6),
    updatedAt: hoursAgo(1),
    finishedAt: hoursAgo(1),
    report: report("The pricing page shows the Family tier, a comparison table, and five new FAQ entries.", ["Confirm the Family price ($9.99) with the user"], { pr: pr("pantry-web", 322) }),
    pr: pullRequest(pr("pantry-web", 322), { checks: "pending" }),
  },
  web,
);

await store.writeMemory(slug, {
  name: "Launch date and scope",
  type: "project",
  description: "Pantry 2.0 ships 2026-10-20 with shared lists, recipe import, and family plans; meal-plan AI moved to 2.1",
  body: "Pantry 2.0 ships on 2026-10-20.\n\nIn scope: shared shopping lists, recipe import from URL, paid family plans, offline mode.\n\nOut of scope: meal-plan AI. The user moved it to 2.1 on 2026-09-24 to protect the date.",
});
await store.writeMemory(slug, {
  name: "Repositories and commands",
  type: "reference",
  description: "pantry-web is Next.js 15 with Vitest and Playwright; pantry-api is Fastify, Postgres, and Stripe",
  body: `- pantry-web (${web}): Next.js 15. \`pnpm dev\`, \`pnpm test\` (Vitest), \`pnpm e2e\` (Playwright).\n- pantry-api (${api}): Fastify and Postgres. \`pnpm dev\`, \`pnpm test\`.\n- Staging: https://staging.pantry.example`,
});
await store.writeMemory(slug, {
  name: "One concern per pull request",
  type: "feedback",
  description: "Split refactors from features; reviewers are a team of two",
  body: "Keep each pull request to one concern.\n\n**Why:** two people review everything, and mixed PRs stall.\n\n**How to apply:** open a separate PR for any refactor a feature needs.",
});
await store.writeMemory(slug, {
  name: "Stripe test mode only",
  type: "feedback",
  description: "Agents use STRIPE_TEST_KEY from .env.test and never touch live keys",
  body: "Agents use Stripe test mode only.\n\n**Why:** live keys can charge real customers.\n\n**How to apply:** load `STRIPE_TEST_KEY` from `.env.test`; stop and ask if a task seems to need live data.",
});
await store.writeMemory(slug, {
  name: "Design review on Thursdays",
  type: "project",
  description: "Design questions batch for the Thursday review with the designer",
  body: "Design questions go to the Thursday design review. Collect them in the launch plan instead of asking one by one.",
});

await store.writeScopedFile(slug, "project", "plans/launch-plan.md", `---
owner: Coordinator
launch: 2026-10-20
status: on track
---

# Pantry 2.0 launch plan

Pantry 2.0 ships on **October 20**. Every feature ships dark behind a flag, then ramps to 100% over launch week.

## Workstreams

| Workstream | Agent | Ticket | Status |
| --- | --- | --- | --- |
| Shared shopping lists | a-003 | ${ticket("PAN-137")} | Approved, ready to merge |
| Offline mode | a-006 | ${ticket("PAN-139")} | Fixing a failing check |
| Family plan billing | a-002 | ${ticket("PAN-142")} | Waiting on proration decision |
| Recipe import | a-004 | ${ticket("PAN-151")} | In progress |
| Onboarding redesign | a-005 | ${ticket("PAN-155")} | In progress |
| Accessibility | a-007 | ${ticket("PAN-128")} | Merged |

## Launch week

1. **Oct 14**: freeze features; only fixes merge.
2. **Oct 16**: enable every flag for staff.
3. **Oct 18**: ramp to 10% of households.
   - Watch checkout errors and sync latency.
   - Roll back if either passes its budget.
4. **Oct 20**: ramp to 100% and publish the launch post.

## Open questions for Thursday's design review

- [ ] Focus order on the recipe card (from a-007)
- [ ] Empty state for a shared list with no items (from a-007)
- [x] Family tier name: **Family**

> Rollback: turn the flag off in \`lib/flags.ts\` and redeploy. No migration is irreversible.
`);

await store.writeScopedFile(slug, "project", "docs/decisions.md", `# Decisions

| Date | Decision | Why |
| --- | --- | --- |
| 2026-09-24 | Move meal-plan AI to 2.1 | Protects the October 20 date |
| 2026-09-26 | CRDT merges for shared lists | Two people often edit the same list at the store |
| 2026-09-28 | Family plans use per-seat Stripe prices | Matches how households grow |
`);

await store.writeScopedFile(slug, "project", "docs/architecture.md", `# Architecture

\`\`\`
pantry-web (Next.js)  ──►  pantry-api (Fastify)  ──►  Postgres
        │                        │
        └── IndexedDB (offline)  └── Stripe (test mode)
\`\`\`

- **Lists** sync through a websocket channel per household.
- **Recipes** import from JSON-LD first, then microdata, then readable HTML.
- **Billing** keeps Stripe as the source of truth; the API mirrors subscription state.
`);

await store.writeNotes(slug, `<tldr>
- Launch on **October 20** is on track: 5 of 7 workstreams are done, approved, or in progress.
- a-002 Family plan billing needs your call on proration (${ticket("PAN-142")}).
- [#318 Shared shopping lists](${pr("pantry-web", 318)}) is approved and ready to merge.
</tldr>

**Now**
- [ ] a-002 Family plan billing is waiting on you: prorate new members now, or bill at renewal? (${ticket("PAN-142")})
- [ ] Merge [#318 Shared shopping lists](${pr("pantry-web", 318)}) after Wednesday's API deploy
- [ ] a-006 Offline mode is fixing \`e2e (webkit)\` on [#320 Offline mode](${pr("pantry-web", 320)})
- [ ] a-004 Recipe import from URL: parser done, tests running (${ticket("PAN-151")})
- [ ] a-005 Onboarding redesign: 4 short steps behind \`onboardingV2\` (${ticket("PAN-155")})
- [ ] Confirm the $9.99 Family price on [#322 Pricing page copy](${pr("pantry-web", 322)})
- [ ] Bring two accessibility questions to Thursday's review ([Launch plan](${projectFile("plans/launch-plan.md")}))
**Done**
- [x] a-007 Accessibility audit: [#309 Accessibility fixes](${pr("pantry-web", 309)}) merged, 23 issues fixed
- [x] Moved meal-plan AI to 2.1 ([Decisions](${projectFile("docs/decisions.md")}))
- [x] a-001 Map both repositories: proposed the launch tasks
`);

await store.addInbox(slug, { kind: "agent_waiting", agentId: "a-002", title: "Family plan billing", summary: "Needs you: prorate a new family member now, or bill at the next renewal?" });
await store.addInbox(slug, { kind: "pr_checks_failed", agentId: "a-006", title: "Offline mode", summary: `Checks failing on the pull request: e2e (webkit) (${pr("pantry-web", 320)})` });
await store.addInbox(slug, { kind: "agent_done", agentId: "a-008", title: "Pricing page copy", summary: "The pricing page shows the Family tier, a comparison table, and five new FAQ entries." });

const docs = await project({
  name: "Docs Site Refresh",
  goal: "Move the help center to the new docs site with search and versioned API reference.",
  icon: "book",
  color: "blue",
  repos: [web],
});
await agent(
  docs.slug,
  {
    id: "a-001",
    title: "API reference examples",
    task: "Generate a runnable example for every public API endpoint.",
    status: "working",
    createdAt: hoursAgo(2),
    updatedAt: minutesAgo(6),
    activity: "Writing examples for /recipes",
  },
  web,
);
await store.writeNotes(docs.slug, `<tldr>
- a-001 API reference examples is writing examples, 18 of 31 endpoints done.
</tldr>

**Now**
- [ ] a-001 API reference examples: 18 of 31 endpoints
**Done**
- [x] Picked the docs framework`);

const flaky = await project({
  name: "Flaky Test Cleanup",
  goal: "Get the main branch to 20 green runs in a row.",
  icon: "bug",
  color: "red",
  repos: [web, api],
});
await agent(
  flaky.slug,
  {
    id: "a-001",
    title: "Quarantine flaky e2e",
    task: "Find the five flakiest Playwright tests, quarantine them, and open a ticket for each.",
    status: "idle",
    createdAt: daysAgo(1),
    updatedAt: hoursAgo(4),
    finishedAt: hoursAgo(4),
    report: report("Quarantined 5 flaky tests and opened a ticket for each. Main is 12 runs green in a row.", ["Fix the checkout timeout test first"], { pr: pr("pantry-web", 316) }),
    pr: pullRequest(pr("pantry-web", 316), {}),
  },
  web,
);
await store.writeNotes(flaky.slug, `<tldr>
- Main is 12 runs green in a row; the goal is 20.
- a-001 Quarantine flaky e2e is ready for review ([#316](${pr("pantry-web", 316)})).
</tldr>

**Now**
- [ ] Review [#316 Quarantine flaky e2e](${pr("pantry-web", 316)})`);

await store.touchProject(slug);
const { rememberProject } = await import("../src/server/state.ts");
await rememberProject(slug);

const summary = JSON.parse(await readFile(paths.projectJson(slug), "utf8"));
console.log(`Demo ready.\n  Data: ${dataDir}\n  Repositories: ${reposDir}\n  Main project: ${summary.name} (${slug})`);
console.log(`\nTo show it in Codex, install with this data folder:\n  npm run install:local -- --data ${dataDir}\n  codex plugin add codex-projects-plugin@personal\nThen restart Codex. Run this script again to reset the demo.`);
