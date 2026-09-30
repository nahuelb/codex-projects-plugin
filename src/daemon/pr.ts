import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PullRequestStatus } from "../shared/types.ts";
import { nowIso } from "../core/fsutil.ts";

const run = promisify(execFile);

type Check = { name?: string; context?: string; status?: string; conclusion?: string; state?: string };

const FAILED = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR"]);

export function summarizeChecks(checks: Check[]): Pick<PullRequestStatus, "checks" | "failing"> {
  if (!checks.length) return { checks: "none", failing: [] };
  const failing = checks.filter((check) => FAILED.has(String(check.conclusion ?? check.state ?? "").toUpperCase())).map((check) => check.name ?? check.context ?? "check");
  if (failing.length) return { checks: "failing", failing };
  const pending = checks.some((check) => {
    const status = String(check.status ?? "").toUpperCase();
    const state = String(check.state ?? "").toUpperCase();
    return (status && status !== "COMPLETED") || state === "PENDING" || state === "EXPECTED";
  });
  return { checks: pending ? "pending" : "passing", failing: [] };
}

export async function fetchPullRequest(url: string, gh = process.env.PROJECTS_GH_BIN || "gh"): Promise<PullRequestStatus> {
  const { stdout } = await run(gh, ["pr", "view", url, "--json", "state,isDraft,reviewDecision,statusCheckRollup"], { timeout: 30_000 });
  const data = JSON.parse(stdout);
  const state = ["OPEN", "MERGED", "CLOSED"].includes(data.state) ? data.state : "UNKNOWN";
  const review = ["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"].includes(data.reviewDecision) ? data.reviewDecision : "NONE";
  return { url, state, draft: Boolean(data.isDraft), review, ...summarizeChecks(data.statusCheckRollup ?? []), checkedAt: nowIso() };
}

export type PrEvent = "checks_failed" | "changes_requested" | "merged" | "closed";

export function prEvents(previous: PullRequestStatus | undefined, next: PullRequestStatus): PrEvent[] {
  const events: PrEvent[] = [];
  if (next.state === "MERGED" && previous?.state !== "MERGED") events.push("merged");
  if (next.state === "CLOSED" && previous?.state !== "CLOSED") events.push("closed");
  if (next.state === "OPEN") {
    const newlyFailing = next.checks === "failing" && (previous?.checks !== "failing" || next.failing.join() !== previous.failing.join());
    if (newlyFailing) events.push("checks_failed");
    if (next.review === "CHANGES_REQUESTED" && previous?.review !== "CHANGES_REQUESTED") events.push("changes_requested");
  }
  return events;
}
