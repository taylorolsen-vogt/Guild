import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { enqueueSearchCycle, type EnqueueDependencies } from "../db/search-cycles.js";
import { conceptCandidate, conceptSourceEvidence, runConceptReviewer, validateConceptReview } from "../agents/concept-reviewer.js";
import { createEvidence, type Evidence } from "../schemas/evidence.js";
import { pipelineRunSchema, type PipelineRun } from "../schemas/run.js";
import { imageReviewConcepts, newSearchCycle, projectCycle, searchCycleSchema, type ConceptReview, type SearchCycle, type SearchCycleProfile } from "../schemas/search-cycle.js";
import { processPendingSearchCycle, type SearchCycleDependencies } from "../pipeline/search-cycle.js";
import { discoveryBriefAt } from "../pipeline/discovery-briefs.js";
import { initialWorkerProgress } from "../pipeline/worker-schedule.js";
import type { generateStructured } from "../lib/model.js";

const at = "2026-09-11T12:00:00.000Z";
function evidenceFor(query = "reef monitoring"): Evidence {
  return createEvidence({ url: `https://example.org/report/${encodeURIComponent(query)}`, title: `${query} field report`,
    publisher: "Fixture laboratory", sourceType: "field_report", observedAt: at, adapter: "github", query,
    excerpt: `${query}: fixture documenting a useful engineering gap and existing open alternatives.` });
}
function assessment(evidence: Evidence[], recommendation: ConceptReview["recommendation"] = "propose"): ConceptReview {
  const field = (text: string) => ({ text, evidenceIds: evidence.map((item) => item.id) });
  return { recommendation, gapStatus: recommendation === "propose" ? "documented" : "already_addressed",
    rationale: field("A bounded contribution is supported by the fixture."), value: field("More reliable observations."),
    targetUsers: field("Field researchers."), alternatives: field("An existing open design has documented limits."),
    gap: field("Calibration drifts during long deployments."), feasibility: field("Prototype and measure drift on a test bench."),
    duplicateSaturation: field("Extend the open design rather than duplicating it.") };
}

function queueHarness() {
  let current: SearchCycle | null = null;
  let pending = Promise.resolve();
  let inserts = 0;
  const dependencies: EnqueueDependencies = {
    transaction: (operation) => {
      const result = pending.then(() => operation({ outstanding: async () => current,
        insert: async (cycle) => { inserts++; current = cycle; } }));
      pending = result.then(() => {}, () => {});
      return result;
    },
  };
  return { dependencies, get current() { return current; }, get inserts() { return inserts; },
    clear: () => { current = null; } };
}

test("concurrent enqueue across profiles has one winner and never starts work", async () => {
  const h = queueHarness();
  const results = await Promise.all(Array.from({ length: 40 }, (_, index) => enqueueSearchCycle(
    index % 2 ? "frontier_scan" : "image_review", h.dependencies)));
  assert.equal(h.inserts, 1);
  assert.equal(results.filter((result) => !result.alreadyQueued).length, 1);
  assert.equal(new Set(results.map((result) => result.cycle.id)).size, 1);
  assert.equal(h.current?.status, "queued");
  assert.equal(h.current?.results.length, 5);
  assert.deepEqual(h.current?.runIds, []);
  h.current!.status = "running";
  assert.equal((await enqueueSearchCycle("frontier_scan", h.dependencies)).alreadyQueued, true);
  h.clear();
  assert.equal((await enqueueSearchCycle("frontier_scan", h.dependencies)).alreadyQueued, false);
});

test("queue rejects unknown profiles before opening a transaction and schema defaults result collections", async () => {
  const h = queueHarness();
  await assert.rejects(enqueueSearchCycle("unknown" as SearchCycleProfile, h.dependencies));
  assert.equal(h.inserts, 0);
  const cycle = searchCycleSchema.parse({ id: randomUUID(), profile: "image_review", createdAt: at, updatedAt: at });
  assert.deepEqual(cycle.results, []);
  assert.equal(cycle.status, "queued");
});

test("five exact concepts each have two bounded 2–4 keyword source queries", () => {
  assert.deepEqual(newSearchCycle("image_review").results.map((result) => result.title), [
    "Autonomous reef monitoring module", "Open-source prosthetic hand", "Emergency shelter system",
    "Modular orbital sensor platform", "Autonomous precision agriculture rover",
  ]);
  for (const concept of imageReviewConcepts) {
    assert.equal(concept.searchTerms.length, 2);
    for (const query of concept.searchTerms) assert.ok(query.split(/\s+/).length >= 2 && query.split(/\s+/).length <= 4 && query.length <= 80);
  }
});

for (const concept of imageReviewConcepts) {
  test(`${concept.title}: review receives its own context and seeds matching value/gap`, async () => {
    const evidence = [evidenceFor(concept.searchTerms[0])];
    let calls = 0;
    const generate: typeof generateStructured = async (prompt, input, schema) => {
      calls++;
      assert.match(prompt, /illustrations are inspiration, NOT source evidence/);
      const supplied = input as { concept: { title: string; context: string }; evidence: Evidence[] };
      assert.equal(supplied.concept.title, concept.title);
      assert.equal(supplied.concept.context, concept.context);
      assert.deepEqual(supplied.evidence, evidence);
      return schema.parse(assessment(evidence));
    };
    const result = await runConceptReviewer(concept, evidence, [], generate);
    const candidate = conceptCandidate(concept, result, evidence);
    assert.equal(calls, 1);
    assert.ok(candidate.problemHypothesis.startsWith(concept.title));
    assert.ok(candidate.problemHypothesis.includes(result.value.text));
    assert.ok(candidate.problemHypothesis.includes(result.gap.text));
    assert.deepEqual(candidate.evidenceIds, evidence.map((item) => item.id));
  });
}

test("unknown citation IDs are rejected in every assessment field", () => {
  const evidence = [evidenceFor()];
  for (const field of ["rationale", "value", "targetUsers", "alternatives", "gap", "feasibility", "duplicateSaturation"] as const) {
    const output = assessment(evidence);
    output[field].evidenceIds = [randomUUID()];
    assert.throws(() => validateConceptReview(output, evidence), /unknown evidence IDs/);
  }
  assert.throws(() => validateConceptReview({ ...assessment(evidence), gapStatus: "not_established" }, evidence), /documented unresolved gap/);
  assert.throws(() => validateConceptReview({ ...assessment(evidence), value: { text: "Unproven", evidenceIds: [] } }, evidence), /lacks value evidence/);
  assert.throws(() => validateConceptReview(assessment([], "do_not_add"), evidence), /requires source evidence/);
});

test("images and asserted existing-product capabilities are not source evidence; no evidence means no LLM", async () => {
  const image = { ...evidenceFor(), url: "https://example.org/hand.png", excerpt: "Image supposedly proves a useful working prosthetic." };
  const claim = { ...evidenceFor(), adapter: "concept_claim", excerpt: "This is an existing working reef monitor." };
  const vision = { ...evidenceFor(), adapter: "vision" };
  assert.deepEqual(conceptSourceEvidence([image, claim, vision]), []);
  let calls = 0;
  const generate: typeof generateStructured = async () => { calls++; throw new Error("Must not invoke Claude"); };
  for (const records of [[], [image, claim, vision]]) {
    const result = await runConceptReviewer(imageReviewConcepts[0], records, [], generate);
    assert.equal(result.recommendation, "needs_evidence");
    assert.equal(result.gapStatus, "not_established");
    assert.deepEqual(result.rationale.evidenceIds, []);
  }
  assert.equal(calls, 0);
});

function harness(profile: SearchCycleProfile = "image_review") {
  let cycle = newSearchCycle(profile, at);
  const runs = new Map<string, PipelineRun>();
  const snapshots: SearchCycle[] = [];
  const events: string[] = [];
  let stopped = false;
  let locked = true;
  let count = 3;
  const progress = { ...initialWorkerProgress(50, at), pausedReason: "no_progress" as const,
    pausedAt: at, briefIndex: 3, noProgressRuns: 8 };
  const d: SearchCycleDependencies = {
    list: async () => [structuredClone(cycle)],
    claim: async () => {
      if (cycle.status !== "queued") return null;
      cycle = { ...cycle, status: "running", startedAt: at };
      return structuredClone(cycle);
    },
    save: async (value) => {
      assert.ok(locked, "no persistence after lock loss");
      cycle = projectCycle(value, at);
      snapshots.push(structuredClone(cycle));
      return structuredClone(cycle);
    },
    createRun: async (cycleId, conceptId, input, cursor) => {
      assert.equal(cycleId, cycle.id);
      assert.ok(locked);
      const run = pipelineRunSchema.parse({ id: randomUUID(), ...input, reviewMode: "human_review", status: "queued", stage: "queued",
        message: "Waiting", warnings: [], error: null, createdAt: at, updatedAt: at,
        artifactIds: { evidence: [], candidates: [], dossiers: [], problems: [], projects: [] } });
      runs.set(run.id, run);
      if (cursor !== undefined) { assert.equal(cursor, progress.briefIndex); progress.briefIndex++; }
      cycle = projectCycle({ ...cycle, results: cycle.results.map((result) => result.conceptId === conceptId
        ? { ...result, runId: run.id, runStatus: run.status, status: "running" } : result) }, at);
      return { cycle: structuredClone(cycle), run };
    },
    getRun: async (id) => { assert.ok(runs.has(id)); return structuredClone(runs.get(id)!); },
    updateRun: async (id, changes) => {
      assert.ok(locked);
      const run = pipelineRunSchema.parse({ ...runs.get(id), ...changes });
      runs.set(id, run); return run;
    },
    saveArtifact: async (kind, item) => { assert.ok(locked); events.push(`save:${kind}:${item.id}`); },
    projects: async () => [], approvedIds: async () => new Set(Array.from({ length: count }, (_, i) => String(i))),
    progress: async () => ({ ...progress }), checkpoint: async () => { assert.ok(locked); events.push("cooldown"); },
    search: async (_sources, query, limit) => { assert.equal(limit, 5); events.push(`search:${query}`); return { evidence: [evidenceFor(query)], warnings: [] }; },
    review: async (concept, evidence) => { events.push(`review:${concept.id}`); return assessment(evidence); },
    execute: async (runId, options) => {
      assert.ok(locked);
      assert.equal(options?.humanReviewOnly, true);
      assert.equal(options?.maxTarget, 50);
      assert.equal(await options?.shouldContinue?.(), true, "sticky automatic pause is not a manual guard");
      const result = cycle.results.find((item) => item.runId === runId)!;
      assert.ok(result, "run reference is durable before execution");
      if (profile === "image_review") {
        assert.ok(result.evaluatedAt);
        assert.ok(snapshots.some((snapshot) => snapshot.results.some((item) => item.conceptId === result.conceptId && item.status === "evaluated")));
        assert.ok(options?.seed?.candidate.problemHypothesis.startsWith(result.title));
        assert.deepEqual(options?.seed?.evidence, result.evidence);
      } else assert.equal(options?.seed, undefined);
      events.push(`execute:${result.conceptId}`);
      const run = await d.updateRun(runId, { status: "completed", stage: "complete", message: "Draft retained for human review",
        artifactIds: { ...runs.get(runId)!.artifactIds, projects: [randomUUID()] } });
      await options?.onRunUpdate?.(run);
      assert.deepEqual(cycle.results.find((item) => item.runId === runId)?.projectIds, run.artifactIds.projects, "refs update before execution returns");
    },
    now: () => at,
  };
  const options = { target: 50, limit: 5, verifyLock: async () => { if (!locked) throw new Error("lost lock"); }, stopping: () => stopped };
  return { d, options, runs, events, snapshots, progress,
    get cycle() { return cycle; }, setCycle: (value: SearchCycle) => { cycle = value; },
    stop: () => { stopped = true; }, loseLock: () => { locked = false; }, setCount: (value: number) => { count = value; } };
}

test("five separate evaluations persist before pipeline work; each linked run and project is retained", async () => {
  const h = harness();
  const pause = { ...h.progress };
  const cycle = await processPendingSearchCycle(h.options, h.d);
  assert.equal(cycle?.status, "completed");
  assert.equal(cycle?.results.length, 5);
  assert.equal(cycle?.runIds.length, 5);
  assert.equal(cycle?.projectIds.length, 5);
  assert.equal(h.events.filter((event) => event.startsWith("search:")).length, 10);
  assert.equal(h.events.filter((event) => event.startsWith("review:")).length, 5);
  assert.deepEqual(h.progress, pause, "manual images do not clear/alter the automatic circuit breaker");
  assert.equal(await processPendingSearchCycle(h.options, h.d), null, "completed cycle is never replayed");
});

test("no-source image cycle yields five needs_evidence assessments without a model or proposal run", async () => {
  const h = harness();
  h.d.search = async () => ({ evidence: [], warnings: ["source unavailable with sensitive provider details"] });
  h.d.review = (concept, evidence, projects) => runConceptReviewer(concept, evidence, projects, async () => { throw new Error("No model call allowed"); });
  const cycle = await processPendingSearchCycle(h.options, h.d);
  assert.equal(cycle?.results.length, 5);
  assert.ok(cycle?.results.every((result) => result.status === "completed" && result.assessment?.recommendation === "needs_evidence"));
  assert.deepEqual(cycle?.runIds, []);
  assert.doesNotMatch(JSON.stringify(cycle), /sensitive provider details/);
});

test("one failed concept does not hide evidence or prevent the other four evaluations", async () => {
  const h = harness();
  const original = h.d.review;
  h.d.review = async (...args) => { if (args[0].id === "prosthetic") throw new Error("provider secret"); return original(...args); };
  const cycle = await processPendingSearchCycle(h.options, h.d);
  assert.equal(cycle?.status, "failed");
  assert.equal(cycle?.results.filter((result) => result.status === "completed").length, 4);
  const failed = cycle?.results.find((result) => result.status === "failed");
  assert.equal(failed?.title, "Open-source prosthetic hand");
  assert.equal(failed?.evidence.length, 2);
  assert.doesNotMatch(JSON.stringify(cycle), /provider secret/);
});

test("at target image assessment remains allowed but all proposals stop with an explanation", async () => {
  const h = harness();
  h.setCount(50);
  const cycle = await processPendingSearchCycle({ ...h.options, target: 100 }, h.d);
  assert.equal(h.events.filter((event) => event.startsWith("review:")).length, 5);
  assert.ok(cycle?.results.every((result) => result.status === "skipped" && /target 50 reached/.test(result.message)));
  assert.deepEqual(cycle?.runIds, []);
});

test("frontier scan consumes exactly one normal bounded current-cursor query and preserves sticky pause", async () => {
  const h = harness("frontier_scan");
  const before = { ...h.progress };
  const cycle = await processPendingSearchCycle(h.options, h.d);
  assert.equal(cycle?.runIds.length, 1);
  assert.equal([...h.runs.values()][0]?.query, discoveryBriefAt(before.briefIndex));
  assert.deepEqual(h.progress, { ...before, briefIndex: before.briefIndex + 1 });
  assert.deepEqual(h.events.filter((event) => event.startsWith("execute:")), ["execute:frontier"]);
});

test("frontier at target is terminal with no source work, run, or cursor advance", async () => {
  const h = harness("frontier_scan");
  h.setCount(50);
  const cycle = await processPendingSearchCycle(h.options, h.d);
  assert.equal(cycle?.results[0]?.status, "skipped");
  assert.equal(h.runs.size, 0);
  assert.equal(h.progress.briefIndex, 3);
});

test("shutdown finishes current assessment persistence, interrupts remaining concepts and never retries", async () => {
  const h = harness();
  const original = h.d.review;
  h.d.review = async (...args) => { const review = await original(...args); h.stop(); return review; };
  const cycle = await processPendingSearchCycle(h.options, h.d);
  assert.equal(cycle?.status, "failed");
  assert.equal(cycle?.results[0]?.assessment?.recommendation, "propose");
  assert.ok(cycle?.results.every((result) => result.status === "interrupted"));
  assert.equal(h.events.filter((event) => event.startsWith("review:")).length, 1);
  assert.equal(h.runs.size, 0);
  assert.equal(await processPendingSearchCycle(h.options, h.d), null);
});

for (const runStatus of ["queued", "running"] as const) {
  test(`crash recovery fails only this cycle's ${runStatus} run, retaining refs and not retrying`, async () => {
    const h = harness();
    const cycle = { ...h.cycle, status: "running" as const, startedAt: at };
    h.setCycle(cycle);
    const { run } = await h.d.createRun(cycle.id, "reef", { query: "reef monitoring", sources: ["github"], limit: 5 });
    const projectId = randomUUID();
    await h.d.updateRun(run.id, { status: runStatus, artifactIds: { ...run.artifactIds, projects: [projectId] } });
    const unrelated = { ...run, id: randomUUID(), status: "running" as const };
    h.runs.set(unrelated.id, unrelated);
    assert.equal(await processPendingSearchCycle(h.options, h.d), null);
    assert.equal(h.cycle.status, "failed");
    assert.deepEqual(h.cycle.projectIds, [projectId]);
    assert.equal(h.runs.get(run.id)?.status, "failed");
    assert.equal(h.runs.get(unrelated.id)?.status, "running");
    assert.equal(h.events.some((event) => event.startsWith("execute:")), false);
    assert.equal(await processPendingSearchCycle(h.options, h.d), null);
  });
}

test("loss of worker lock after source work stops all writes and downstream spend", async () => {
  const h = harness();
  h.d.search = async () => { h.loseLock(); return { evidence: [evidenceFor()], warnings: [] }; };
  await assert.rejects(processPendingSearchCycle(h.options, h.d), /lost lock/);
  assert.equal(h.cycle.status, "running", "new lock owner must recover instead of racing writes");
  assert.equal(h.events.length, 0);
  assert.equal(h.snapshots.length, 1, "only the pre-search checkpoint is persisted");
});

test("a queued but unclaimed request survives busy worker shutdown", async () => {
  const h = harness();
  h.stop();
  assert.equal(await processPendingSearchCycle(h.options, h.d), null);
  assert.equal(h.cycle.status, "queued");
  assert.ok(h.cycle.results.every((result) => result.status === "pending"));
});

test("lost create-run response cannot orphan or erase the committed run ownership link", async () => {
  const h = harness();
  const createRun = h.d.createRun;
  let calls = 0;
  h.d.createRun = async (...args) => {
    const linked = await createRun(...args);
    if (calls++ === 0) throw new Error("Connection lost after commit");
    return linked;
  };
  const cycle = await processPendingSearchCycle(h.options, h.d);
  assert.equal(cycle?.status, "failed");
  assert.equal(cycle?.results[0]?.status, "failed");
  assert.ok(cycle?.results[0]?.runId);
  assert.equal(h.runs.get(cycle.results[0].runId)?.status, "failed");
  assert.equal(cycle.runIds.length, 5);
  assert.equal(cycle.results.filter((result) => result.status === "completed").length, 4);
});

test("shutdown during proposal work retains refs and interrupts remaining concepts", async () => {
  const h = harness();
  const execute = h.d.execute;
  h.d.execute = async (...args) => { await execute(...args); h.stop(); };
  const cycle = await processPendingSearchCycle(h.options, h.d);
  assert.equal(cycle?.status, "failed");
  assert.equal(cycle?.runIds.length, 1);
  assert.equal(cycle?.projectIds.length, 1);
  assert.ok(cycle?.results[0]?.assessment);
  assert.ok(cycle?.results.every((result) => result.status === "interrupted"));
  assert.equal(h.events.filter((event) => event.startsWith("review:")).length, 1);
});

test("lock loss during catalog read is checked again before concept review", async () => {
  const h = harness();
  h.d.projects = async () => { h.loseLock(); return []; };
  await assert.rejects(processPendingSearchCycle(h.options, h.d), /lost lock/);
  assert.equal(h.events.some((event) => event.startsWith("review:")), false);
});

test("terminal cycle commit with a lost response remains terminal rather than being overwritten", async () => {
  const h = harness("frontier_scan");
  const save = h.d.save;
  h.d.save = async (cycle) => {
    const saved = await save(cycle);
    if (saved.status === "completed") throw new Error("Connection lost after terminal commit");
    return saved;
  };
  const cycle = await processPendingSearchCycle(h.options, h.d);
  assert.equal(cycle?.status, "completed");
  assert.equal(cycle?.runIds.length, 1);
});