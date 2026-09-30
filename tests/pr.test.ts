import { test } from "node:test";
import assert from "node:assert/strict";
import { prEvents, summarizeChecks } from "../src/daemon/pr.ts";
import type { PullRequestStatus } from "../src/shared/types.ts";

const base: PullRequestStatus = { url: "https://github.com/a/b/pull/1", state: "OPEN", draft: false, checks: "pending", failing: [], review: "NONE", checkedAt: "2026-09-30T00:00:00Z" };

test("summarizeChecks reads check runs and status contexts", () => {
  assert.deepEqual(summarizeChecks([]), { checks: "none", failing: [] });
  assert.deepEqual(summarizeChecks([{ name: "lint", status: "COMPLETED", conclusion: "FAILURE" }, { name: "test", status: "COMPLETED", conclusion: "SUCCESS" }]), { checks: "failing", failing: ["lint"] });
  assert.equal(summarizeChecks([{ name: "test", status: "IN_PROGRESS" }]).checks, "pending");
  assert.equal(summarizeChecks([{ context: "ci/legacy", state: "PENDING" }]).checks, "pending");
  assert.equal(summarizeChecks([{ context: "ci/legacy", state: "SUCCESS" }, { name: "t", status: "COMPLETED", conclusion: "SUCCESS" }]).checks, "passing");
});

test("prEvents fires once per transition", () => {
  const failing = { ...base, checks: "failing" as const, failing: ["lint"] };
  assert.deepEqual(prEvents(base, failing), ["checks_failed"]);
  assert.deepEqual(prEvents(failing, failing), []);
  assert.deepEqual(prEvents(failing, { ...failing, failing: ["lint", "test"] }), ["checks_failed"]);
  assert.deepEqual(prEvents(base, { ...base, review: "CHANGES_REQUESTED" }), ["changes_requested"]);
  assert.deepEqual(prEvents(base, { ...base, state: "MERGED" }), ["merged"]);
  assert.deepEqual(prEvents({ ...base, state: "MERGED" }, { ...base, state: "MERGED" }), []);
  assert.deepEqual(prEvents(undefined, { ...base, state: "CLOSED" }), ["closed"]);
});
