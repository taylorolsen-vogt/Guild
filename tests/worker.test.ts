import assert from "node:assert/strict";
import test from "node:test";
import {
  activeApprovedProjectIds, applyVerification, beginDiscoveryAttempt, clearDiscoveryPause,
  finishDiscoveryAttempt, initialWorkerProgress, isDue, latestTimestamp, parseWorkerConfig, projectNeedsRevalidation,
  reconcileWorkerGoal, settleTrackedAttempt, type AttemptSettlementDependencies, type WorkerProgress,
  runDueJobs, workerSources, type DueJobDependencies, type WorkerJob,
} from "../pipeline/worker-schedule.js";
import { main } from "../pipeline/worker.js";
import { getWorkerStatus, initializeWorkerState } from "../db/worker-state.js";
import { compactSourceQuery, discoveryBriefAt, workerDiscoveryBriefs } from "../pipeline/discovery-briefs.js";
import type { Project } from "../schemas/project.js";
import { pipelineRunSchema } from "../schemas/run.js";
import { randomUUID } from "node:crypto";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-09-10T12:00:00.000Z");
const config = parseWorkerConfig({});
const iso = (time: number) => new Date(time).toISOString();

test("worker imports without starting a database, timer, or paid job", () => {
  assert.equal(typeof main, "function");
  assert.equal(typeof getWorkerStatus, "function");
  assert.equal(typeof initializeWorkerState, "function");
});

test("defaults target 50, five-minute discovery, eight no-progress attempts and daily revalidation, without Reddit", () => {
  assert.deepEqual(config, { target: 50, maxNoProgressRuns: 8, discoveryMs: 300_000, revalidationMs: 24 * HOUR, pollMs: 60_000, limit: 5, query: undefined });
  assert.deepEqual(workerSources, ["arxiv", "github", "government", "news"]);
  assert.equal(workerSources.includes("reddit"), false);
});

test("positive fractional hours, bounded source limit, poll interval and query are configurable", () => {
  assert.deepEqual(parseWorkerConfig({
    WORKER_DISCOVERY_HOURS: "0.5", WORKER_REVALIDATION_HOURS: "48",
    WORKER_POLL_SECONDS: "5", WORKER_DISCOVERY_LIMIT: "25", DISCOVERY_QUERY: "  energy  ",
    WORKER_TARGET_PROJECTS: "80", WORKER_MAX_NO_PROGRESS_RUNS: "12",
  }), { target: 80, maxNoProgressRuns: 12, discoveryMs: HOUR / 2, revalidationMs: 48 * HOUR, pollMs: 5000, limit: 25, query: "energy" });
  assert.equal(parseWorkerConfig({ DISCOVERY_QUERY: " " }).query, undefined);
  // Legacy CLI options cannot enable direct publication or Reddit in the worker.
  assert.deepEqual(parseWorkerConfig({ DISCOVERY_REVIEW_MODE: "agent_direct", DISCOVERY_SOURCES: "reddit" }), config);
});

test("malformed environment fails before starting automation", () => {
  for (const key of ["WORKER_DISCOVERY_HOURS", "WORKER_REVALIDATION_HOURS"]) {
    for (const value of ["", " ", "0", "-1", "NaN", "Infinity", "1e999", "6h", "1e-99"]) {
      assert.throws(() => parseWorkerConfig({ [key]: value }), new RegExp(key));
    }
  }
  for (const value of ["", "0", "4", "3601", "Infinity", "oops"]) {
    assert.throws(() => parseWorkerConfig({ WORKER_POLL_SECONDS: value }), /WORKER_POLL_SECONDS/);
  }
  for (const value of ["", "0", "-1", "26", "1.5", "NaN"]) {
    assert.throws(() => parseWorkerConfig({ WORKER_DISCOVERY_LIMIT: value }), /WORKER_DISCOVERY_LIMIT/);
  }
  for (const key of ["WORKER_TARGET_PROJECTS", "WORKER_MAX_NO_PROGRESS_RUNS"]) {
    for (const value of ["", " ", "0", "-1", "1.5", "NaN", "Infinity", "9007199254740992"]) {
      assert.throws(() => parseWorkerConfig({ [key]: value }), new RegExp(key));
    }
  }
  for (const value of ["a".repeat(121), "planning instructions ".repeat(5)]) {
    assert.throws(() => parseWorkerConfig({ DISCOVERY_QUERY: value }), /DISCOVERY_QUERY/);
  }
});

test("due decisions use exact boundaries, tolerate missing/bad timestamps and defer future checkpoints", () => {
  assert.equal(isDue(NOW, HOUR, null), true);
  assert.equal(isDue(NOW, HOUR, NOW - HOUR + 1), false);
  assert.equal(isDue(NOW, HOUR, NOW - HOUR), true);
  assert.equal(isDue(NOW, HOUR, NOW + HOUR), false);
  assert.equal(latestTimestamp([null, undefined, "bad"]), null);
  assert.equal(latestTimestamp([iso(NOW - HOUR), "bad", iso(NOW), iso(NOW - 2 * HOUR)]), NOW);
  assert.equal(isDue(NOW, HOUR, NaN), true);
  assert.throws(() => isDue(NaN, HOUR, null));
  assert.throws(() => isDue(NOW, 0, null));
});

function selection(overrides: Partial<Pick<Project, "decision" | "status" | "lifecycleStatus" | "verificationHistory">> = {}) {
  return {
    decision: "selected" as const, status: "draft" as const,
    lifecycleStatus: "active" as const, verificationHistory: [], ...overrides,
  };
}

const verification = (checkedAt: string, status: Project["verificationHistory"][number]["status"] = "active") => ({
  checkedAt, status, summary: "Fresh evidence", evidenceIds: ["evidence-id"],
});

test("only selected nonarchived unfinished projects with an expired latest check are eligible", () => {
  assert.equal(projectNeedsRevalidation(selection(), NOW, 24 * HOUR), true);
  for (const project of [selection({ decision: "pending" }), selection({ decision: "rejected" }),
    selection({ status: "archived" }), selection({ lifecycleStatus: "completed" })]) {
    assert.equal(projectNeedsRevalidation(project, NOW, 24 * HOUR), false);
  }
  assert.equal(projectNeedsRevalidation(selection({ verificationHistory: [
    verification(iso(NOW - 24 * HOUR)), verification(iso(NOW - HOUR), "inconclusive"),
    verification(iso(NOW - 48 * HOUR)),
  ] }), NOW, 24 * HOUR), false);
  assert.equal(projectNeedsRevalidation(selection({ verificationHistory: [verification(iso(NOW - 24 * HOUR))] }), NOW, 24 * HOUR), true);
});

test("completed verification archives only its own project without altering publication decisions", () => {
  // These helpers only inspect lifecycle fields; retain a representative unrelated field too.
  const project = { ...selection(), id: "one", decidedBy: "Human curator" } as Project;
  const other = { ...selection(), id: "two" } as Project;
  const original = structuredClone(project);
  const result = applyVerification(project, verification(iso(NOW), "completed"));
  assert.equal(result.status, "archived");
  assert.equal(result.lifecycleStatus, "completed");
  assert.equal(result.decision, "selected");
  assert.equal(result.decidedBy, "Human curator");
  assert.equal(result.verificationHistory.length, 1);
  assert.deepEqual(project, original);
  assert.equal(other.status, "draft");
  const inconclusive = applyVerification(project, verification(iso(NOW), "inconclusive"));
  assert.equal(inconclusive.lifecycleStatus, "active");
  assert.equal(inconclusive.status, "draft");
});

function harness() {
  let clock = NOW;
  const state = new Map<WorkerJob, number>();
  const executed: WorkerJob[] = [];
  const errors: WorkerJob[] = [];
  const dependencies: DueJobDependencies = {
    now: async () => clock,
    lastActivity: async (job) => state.get(job) ?? null,
    checkpoint: async (job, time) => { state.set(job, time); },
    execute: async (job) => { executed.push(job); },
    stopping: () => false,
    reportError: (job) => { errors.push(job); },
  };
  return { state, executed, errors, dependencies, advance: (ms: number) => { clock += ms; } };
}

test("durable checkpoints suppress duplicate ticks/restarts and empty revalidation sweeps", async () => {
  const h = harness();
  await runDueJobs(config, h.dependencies);
  assert.deepEqual(h.executed, ["discovery", "revalidation"]);
  await runDueJobs(config, { ...h.dependencies }); // Another worker after acquiring the lock.
  assert.equal(h.executed.length, 2);
  h.advance(config.discoveryMs);
  await runDueJobs(config, h.dependencies);
  assert.deepEqual(h.executed, ["discovery", "revalidation", "discovery"]);
  h.advance(24 * HOUR - config.discoveryMs);
  await runDueJobs(config, h.dependencies);
  assert.deepEqual(h.executed.slice(-2), ["discovery", "revalidation"]);
});

test("failed paid work is checkpointed before execution and cooled down; the other job still runs", async () => {
  const h = harness();
  h.dependencies.execute = async (job) => {
    assert.equal(h.state.get(job), NOW);
    h.executed.push(job);
    if (job === "discovery") throw new Error("model unavailable");
  };
  await runDueJobs(config, h.dependencies);
  assert.deepEqual(h.errors, ["discovery"]);
  assert.deepEqual(h.executed, ["discovery", "revalidation"]);
  await runDueJobs(config, h.dependencies);
  assert.equal(h.executed.length, 2);
});

test("checkpoint failure prevents paid work, and a persisted pre-crash attempt postpones retry", async () => {
  const h = harness();
  await assert.rejects(runDueJobs(config, {
    ...h.dependencies, checkpoint: async () => { throw new Error("database unavailable"); },
  }));
  assert.deepEqual(h.executed, []);
  h.state.set("discovery", NOW); // Crash after durable claim, before the job completed.
  await runDueJobs(config, h.dependencies);
  assert.deepEqual(h.executed, ["revalidation"]);
});

test("jobs are awaited sequentially, long work starts a fresh cooldown and shutdown skips the next job", async () => {
  const h = harness();
  let stopping = false;
  h.dependencies.stopping = () => stopping;
  h.dependencies.execute = async (job) => {
    h.executed.push(job);
    await Promise.resolve();
    h.advance(8 * HOUR);
    stopping = true;
  };
  await runDueJobs(config, h.dependencies);
  assert.deepEqual(h.executed, ["discovery"]);
  assert.equal(h.state.get("discovery"), NOW + 8 * HOUR);
  assert.equal(isDue(NOW + 8 * HOUR, config.discoveryMs, h.state.get("discovery")!), false);
});

function countable(id: string, overrides: Partial<Project> = {}) {
  return {
    id, ...selection({ decision: "pending" }),
    agentReview: { decision: "approved" as const, rationale: null, reviewedAt: null, findings: [] }, ...overrides,
  };
}

test("goal counts approved pending and selected, excluding unreviewed/rejected drafts, human rejections, archives and completed", () => {
  const projects = [
    countable("pending"), countable("selected", { decision: "selected" }), countable("pending"),
    countable("draft", { agentReview: { decision: "pending", rationale: null, reviewedAt: null, findings: [] } }),
    countable("agent-rejected", { agentReview: { decision: "rejected", rationale: null, reviewedAt: null, findings: [] } }),
    countable("human-rejected", { decision: "rejected" }),
    countable("archived", { status: "archived" }), countable("completed", { lifecycleStatus: "completed" }),
    countable("unverified", { lifecycleStatus: "unverified" }),
  ];
  assert.deepEqual([...activeApprovedProjectIds(projects)], ["pending", "selected", "unverified"]);
});

test("goal pause persists at 50 and stays paused across restarts, count drops and target increases until manual reassessment", () => {
  const initial = initialWorkerProgress(50, iso(NOW));
  assert.equal(reconcileWorkerGoal(initial, 49, 8, iso(NOW)), initial);
  const paused = reconcileWorkerGoal(initial, 50, 8, iso(NOW));
  assert.equal(paused.pausedReason, "goal_reached");
  assert.equal(paused.pausedAt, iso(NOW));
  const restarted = JSON.parse(JSON.stringify(paused));
  assert.equal(reconcileWorkerGoal(restarted, 20, 8, iso(NOW + HOUR)), restarted);
  const largerTarget = { ...restarted, target: 80 };
  assert.equal(reconcileWorkerGoal(largerTarget, 50, 8, iso(NOW + HOUR)), largerTarget);
  assert.throws(() => beginDiscoveryAttempt(paused, iso(NOW)), /paused/);
  const cleared = clearDiscoveryPause(paused, iso(NOW + HOUR));
  assert.equal(cleared.pausedReason, null);
  assert.equal(reconcileWorkerGoal(cleared, 50, 8, iso(NOW)).pausedReason, "goal_reached");
});

test("consecutive no-progress attempts are precharged, reset only for additions, and pause after the eighth failure/empty run", () => {
  let state = initialWorkerProgress(50, iso(NOW));
  for (let attempt = 1; attempt <= 8; attempt++) {
    state = beginDiscoveryAttempt(state, iso(NOW + attempt));
    assert.equal(state.noProgressRuns, attempt);
    assert.equal(state.attemptPending, true);
    assert.equal(reconcileWorkerGoal(state, 0, 8, iso(NOW)).pausedReason, null); // Eighth run may finish.
    assert.throws(() => beginDiscoveryAttempt(state, iso(NOW)), /in flight/);
    assert.throws(() => clearDiscoveryPause(state, iso(NOW)), /unfinished/);
    // Includes a crash after the durable claim; recovery does not increment again.
    state = JSON.parse(JSON.stringify(state));
    state = finishDiscoveryAttempt(state, 0, attempt % 2 ? "Discovery failed" : null, iso(NOW + attempt));
    state = reconcileWorkerGoal(state, 0, 8, iso(NOW + attempt));
    assert.equal(state.pausedReason, attempt === 8 ? "no_progress" : null);
  }
  assert.equal(reconcileWorkerGoal(state, 2, 8, iso(NOW)), state);
  assert.equal(state.briefIndex, 8);
  state = clearDiscoveryPause(state, iso(NOW));
  state = beginDiscoveryAttempt(state, iso(NOW));
  state = finishDiscoveryAttempt(state, 1, "Partial batch failure", iso(NOW + 1));
  assert.equal(state.noProgressRuns, 0);
  assert.equal(state.lastProgressAt, iso(NOW + 1));
  assert.equal(state.lastFinishedAt, iso(NOW + 1));
  assert.equal(state.briefIndex, 9); // Manual reassessment doesn't replay the same brief.
});

test("brief cursor rotates every batch on the same day and survives serialization/restarts", () => {
  let state = initialWorkerProgress(50, iso(NOW));
  const seen: string[] = [];
  for (let index = 0; index <= workerDiscoveryBriefs.length; index++) {
    seen.push(discoveryBriefAt(state.briefIndex));
    state = beginDiscoveryAttempt(state, iso(NOW));
    state = JSON.parse(JSON.stringify(finishDiscoveryAttempt(state, 1, null, iso(NOW))));
  }
  assert.equal(new Set(seen.slice(0, -1)).size, workerDiscoveryBriefs.length);
  assert.equal(seen.at(-1), seen[0]);
  for (const cursor of [-1, 0.5, NaN, Infinity]) assert.throws(() => discoveryBriefAt(cursor));
  for (const brief of workerDiscoveryBriefs) assert.match(brief, /^[a-z]+$/);
  assert.equal(compactSourceQuery("A need for open-source microgrids and energy storage with " + "many words ".repeat(100)), "open-source microgrids energy");
  assert.equal(compactSourceQuery("???"), "engineering");
});

test("sticky paused workers never checkpoint or execute discovery, but still revalidate daily after counts drop", async () => {
  const h = harness();
  let progress = reconcileWorkerGoal(initialWorkerProgress(50, iso(NOW)), 50, 8, iso(NOW));
  h.dependencies.canRun = async (job) => {
    progress = reconcileWorkerGoal(progress, 10, 8, iso(NOW));
    return job !== "discovery" || !progress.pausedReason;
  };
  await runDueJobs(config, h.dependencies);
  h.advance(24 * HOUR);
  await runDueJobs(config, { ...h.dependencies });
  assert.deepEqual(h.executed, ["revalidation", "revalidation"]);
  assert.equal(h.state.has("discovery"), false);
});

function settlementHarness() {
  const ownId = randomUUID();
  const otherId = randomUUID();
  const run = (id: string) => pipelineRunSchema.parse({
    id, query: "microgrids", sources: ["github"], limit: 5, reviewMode: "human_review",
    status: "running", stage: "planner", message: "Drafting", warnings: [], error: null,
    artifactIds: { evidence: [], candidates: [], dossiers: [], problems: [], projects: [] },
    createdAt: iso(NOW), updatedAt: iso(NOW),
  });
  const runs = new Map<string, ReturnType<typeof run>>([[ownId, run(ownId)], [otherId, run(otherId)]]);
  const state = { ...beginDiscoveryAttempt(initialWorkerProgress(50, iso(NOW)), iso(NOW)), lastRunId: ownId };
  let saved: WorkerProgress | undefined;
  const events: string[] = [];
  const approved = new Set<string>();
  const dependencies: AttemptSettlementDependencies = {
    getRun: async (id) => { events.push(`read:${id}`); return runs.get(id)!; },
    updateRun: async (id, changes) => {
      events.push(`update:${id}`);
      const updated = pipelineRunSchema.parse({ ...runs.get(id), ...changes });
      runs.set(id, updated);
      return updated;
    },
    approvedIds: async () => approved,
    now: () => iso(NOW + HOUR),
    checkpoint: async () => { events.push("checkpoint"); },
    save: async (value) => { events.push("save"); saved = value; },
  };
  return { state, ownId, otherId, runs, events, approved, dependencies, get saved() { return saved; } };
}

test("locked restart recovery touches only the atomically tracked worker run, charges no extra attempt and is idempotent", async () => {
  const h = settlementHarness();
  const result = await settleTrackedAttempt(h.state, 8, true, h.dependencies);
  assert.equal(result?.run.status, "failed");
  assert.equal(h.runs.get(h.otherId)?.status, "running");
  assert.deepEqual(h.events, [`read:${h.ownId}`, `update:${h.ownId}`, "checkpoint", "save"]);
  assert.equal(h.saved?.noProgressRuns, 1);
  assert.equal(h.saved?.briefIndex, 1);
  assert.equal(h.saved?.attemptPending, false);
  const before = [...h.events];
  assert.equal(await settleTrackedAttempt(h.saved!, 8, true, h.dependencies), null);
  assert.deepEqual(h.events, before);
});

test("completed tracked runs retain factual status during recovery, count only own approved artifact IDs and redact raw errors", async () => {
  const h = settlementHarness();
  const ownProject = randomUUID();
  const unapprovedDraft = randomUUID();
  h.approved.add(ownProject);
  h.approved.add(randomUUID()); // Unrelated new project is not this run's progress.
  const run = h.runs.get(h.ownId)!;
  h.runs.set(h.ownId, { ...run, status: "completed", stage: "complete", warnings: ["Raw credential-like detail"],
    artifactIds: { ...run.artifactIds, projects: [ownProject, ownProject, unapprovedDraft] } });
  const result = await settleTrackedAttempt({ ...h.state, noProgressRuns: 8 }, 8, true, h.dependencies);
  assert.equal(result?.run.status, "completed");
  assert.equal(result?.additions, 1);
  assert.equal(h.saved?.noProgressRuns, 0);
  assert.equal(h.saved?.pausedReason, null);
  assert.equal(h.saved?.lastProgressAt, iso(NOW + HOUR));
  assert.equal(h.saved?.lastError?.includes("Raw credential"), false);
  assert.equal(h.events.some((event) => event.startsWith("update:")), false);
});

test("the eighth interrupted attempt pauses durably, and a failed final state save can be retried without double charging", async () => {
  const h = settlementHarness();
  const state = { ...h.state, noProgressRuns: 8 };
  await assert.rejects(settleTrackedAttempt(state, 8, true, {
    ...h.dependencies, save: async () => { throw new Error("Persistence failure"); },
  }), /Persistence failure/);
  assert.ok(h.events.includes("checkpoint"));
  const result = await settleTrackedAttempt(state, 8, true, h.dependencies);
  assert.equal(result?.state.noProgressRuns, 8);
  assert.equal(h.saved?.pausedReason, "no_progress");
  assert.equal(h.runs.get(h.otherId)?.status, "running");
});

test("failure to persist the post-run cooldown prevents finalizing state, and missing ownership never triggers global recovery", async () => {
  const h = settlementHarness();
  await assert.rejects(settleTrackedAttempt(h.state, 8, true, {
    ...h.dependencies, checkpoint: async () => { throw new Error("Checkpoint unavailable"); },
  }), /Checkpoint unavailable/);
  assert.equal(h.saved, undefined);
  h.events.length = 0;
  await assert.rejects(settleTrackedAttempt({ ...h.state, lastRunId: null }, 8, true, h.dependencies), /no tracked run/);
  assert.deepEqual(h.events, []);
  await assert.rejects(settleTrackedAttempt(h.state, 8, true, {
    ...h.dependencies, getRun: async () => h.runs.get(h.otherId)!,
  }), /ownership mismatch/);
  assert.equal(h.runs.get(h.otherId)?.status, "running");
});