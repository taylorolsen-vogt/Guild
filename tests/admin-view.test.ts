import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Browser-only presentation module: no database, server, or model calls.
const { projectGroup, projectStatus, searchStatus, resultStatus, cycleSummary } = await import(new URL("../admin-view.js", import.meta.url).href);
const project = { agentReview: { decision: "approved" }, decision: "pending", status: "draft", lifecycleStatus: "unverified" };
const now = "2026-09-11T12:00:00.000Z";
const data = { generatedAt: now, worker: { heartbeatAt: now, pausedReason: null, attemptPending: false }, cycles: [] };

test("project views do not overlap or hide unfinished and rejected plans", () => {
  assert.equal(projectGroup(project, "aligned"), "review");
  assert.equal(projectGroup(project, "unassessed"), "other");
  assert.equal(projectGroup({ ...project, decision: "selected" }, "aligned"), "published");
  assert.equal(projectGroup({ ...project, decision: "selected" }, "unassessed"), "published");
  for (const patch of [
    { decision: "rejected" }, { status: "archived" }, { lifecycleStatus: "completed" },
    { agentReview: { decision: "pending" } }, { agentReview: { decision: "rejected" } },
  ]) {
    assert.equal(projectGroup({ ...project, ...patch }, "aligned"), "other");
    assert.equal(projectGroup({ ...project, decision: "selected", ...patch }, "aligned"), "other");
  }
});

test("project statuses explain the action instead of showing internal enums", () => {
  assert.equal(projectStatus(project, "aligned"), "Ready to review");
  assert.equal(projectStatus({ ...project, decision: "selected" }, "aligned"), "Published");
  assert.equal(projectStatus({ ...project, status: "archived" }, "aligned"), "Not selected");
  assert.equal(projectStatus({ ...project, lifecycleStatus: "completed" }, "aligned"), "Completed");
  assert.equal(projectStatus(project, "unassessed"), "Needs more work");
});

test("search states distinguish waiting, working, offline, and paused without claiming work occurred", () => {
  assert.equal(searchStatus(data).disabled, false);
  assert.equal(searchStatus(data).label, "Run search");
  for (const status of ["queued", "running"]) {
    const result = searchStatus({ ...data, cycles: [{ status }] });
    assert.equal(result.disabled, true);
    assert.equal(result.label, status === "queued" ? "Search queued" : "Searching…");
  }
  for (const heartbeatAt of [null, "invalid", "2026-09-11T11:55:00.000Z", "2026-09-12T12:00:00.000Z"]) {
    const offline = { ...data, worker: { ...data.worker, heartbeatAt } };
    assert.equal(searchStatus(offline).disabled, true);
    assert.match(searchStatus(offline).message, /offline/);
    assert.equal(searchStatus({ ...offline, cycles: [{ status: "running" }] }).label, "Search waiting");
  }
  assert.equal(searchStatus({ ...data, worker: null }).disabled, true);
  assert.match(searchStatus({ ...data, worker: null, cycles: [{ status: "running" }] }).message, /may have stopped/);
  assert.match(searchStatus({ ...data, worker: null, cycles: [{ status: "queued" }] }).message, /can start/);
  assert.match(searchStatus({ ...data, worker: { ...data.worker, pausedReason: "no_progress" } }).message, /found no new projects/);
  assert.equal(searchStatus({ ...data, worker: { ...data.worker, pausedReason: "no_progress" } }).disabled, false);
  assert.match(searchStatus({ ...data, worker: { ...data.worker, pausedReason: "goal_reached" } }).message, /limit/);
  assert.match(searchStatus({ ...data, worker: { ...data.worker, attemptPending: true } }).message, /wait for it to finish/);
});

test("an interrupted downstream run does not look like a completed positive assessment", () => {
  const result = { status: "completed", assessment: { recommendation: "propose" } };
  assert.equal(resultStatus(result), "Worth developing");
  assert.equal(resultStatus({ ...result, status: "failed" }), "Search incomplete");
  assert.equal(resultStatus({ ...result, status: "interrupted" }), "Search incomplete");
  assert.equal(resultStatus({ ...result, status: "running" }), "Preparing a plan");
  assert.equal(resultStatus({ ...result, status: "skipped" }), "Checked · no plan created");
  assert.equal(resultStatus({ ...result, assessment: null, status: "skipped" }), "Not checked");
  assert.equal(resultStatus({ ...result, assessment: { recommendation: "needs_evidence" } }), "Need more information");
  assert.equal(resultStatus({ ...result, assessment: { recommendation: "do_not_add" } }), "Not recommended");
});

test("search summaries distinguish drafts from publication and retain partial failure", () => {
  const cycle = { status: "completed", results: [{ status: "completed" }], projectIds: [] };
  assert.equal(cycleSummary(null), "No searches yet");
  assert.equal(cycleSummary(cycle), "No new plans");
  assert.equal(cycleSummary({ ...cycle, projectIds: ["a", "a", "b"] }), "2 draft plans created");
  assert.equal(cycleSummary({ ...cycle, results: [{ status: "failed" }] }), "Search incomplete · no new plans");
  assert.equal(cycleSummary({ ...cycle, status: "running", profile: "image_review", results: [{ status: "completed" }, { status: "searching" }] }), "1 of 2 ideas checked");
});

test("admin starts with real loading states and keeps technical history collapsed", async () => {
  const html = await readFile(new URL("../admin.html", import.meta.url), "utf8");
  assert.match(html, /<button id="run-search"[^>]*disabled>Run search/);
  assert.match(html, /<details class="technical-details">/);
  assert.match(html, /<div id="proposals"[^>]*aria-busy="true"/);
  assert.match(html, /data-filter="review"[^>]*aria-pressed="true"/);
  assert.doesNotMatch(html, /Discovery log|Approved drafts|Awaiting curation|>Curate|count-ready/);
});