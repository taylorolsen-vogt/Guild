import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { assessMissionAlignment, calculateMeasurements, runCurator } from "../agents/curator.js";
import { runInvestigator } from "../agents/investigator.js";
import {
  canonicalProblemSchema,
  createEvidence,
  solutionReferenceSchema,
  type CandidateProblem,
  type CanonicalProblem,
  type Evidence,
  type ProblemDossier,
} from "../schemas/index.js";

const at = "2026-09-11T00:00:00.000Z";
const missionAssessment: Omit<CanonicalProblem["missionAlignment"], "status"> = {
  frontierCapability: "yes",
  broadlyReusable: "yes",
  engineeringCore: "yes",
  feasibleGuildContribution: "yes",
  primarilyRoutineDelivery: "no",
  frontierDomains: ["energy"],
  exclusionReasons: [],
  rationale: "Reusable engineering capability.",
};

type EvidenceInput = Pick<Evidence, "id" | "title" | "publisher" | "sourceType" | "excerpt" | "observedAt" | "publishedAt">;
type ProblemInput = Pick<CanonicalProblem, "id" | "title" | "statement" | "categories">;
interface CuratorInput {
  candidate: CandidateProblem;
  dossier: Omit<ProblemDossier, "createdAt">;
  evidence: EvidenceInput[];
  existingProblems: ProblemInput[];
}
interface MissionInput {
  problem: ProblemInput & { evidenceIds: string[] };
  evidence: EvidenceInput[];
}

function evidence(overrides: Partial<Evidence> = {}): Evidence {
  return {
    ...createEvidence({
      url: "https://example.com/report", title: "Battery electrolyte report", publisher: "Lab",
      sourceType: "academic_paper", observedAt: at, excerpt: "Documented electrolyte degradation.",
      adapter: "test", query: "battery electrolyte",
    }),
    ...overrides,
  };
}

function candidate(evidenceIds: string[]): CandidateProblem {
  return {
    id: randomUUID(), claim: "Battery electrolyte degradation", problemHypothesis: "Battery electrolyte durability",
    evidenceIds, observedAt: at, status: "candidate",
  };
}

function dossier(value: CandidateProblem, overrides: Partial<ProblemDossier> = {}): ProblemDossier {
  return {
    id: randomUUID(), candidateId: value.id, verdict: "supported", verdictReason: "Battery electrolyte gap",
    evidenceIds: value.evidenceIds, existingSolutions: [], priorAttempts: [], contradictions: [], openQuestions: [],
    createdAt: at, ...overrides,
  };
}

function problem(evidenceIds: string[], overrides: Partial<CanonicalProblem> = {}): CanonicalProblem {
  return canonicalProblemSchema.parse({
    id: randomUUID(), title: "Battery electrolyte", statement: "Battery electrolyte durability",
    categories: ["energy"], sourceCandidateIds: [randomUUID()], dossierIds: [randomUUID()],
    evidenceIds, relatedProblemIds: [],
    measurements: {
      independentSourceCount: 1, sourceTypeCount: 1, mentionCount: evidenceIds.length,
      newestEvidenceAt: at, existingSolutionCount: 0, failedAttemptCount: 0,
      affectedPopulationEstimate: null, affectedPopulationEvidenceIds: [],
    },
    approval: "pending", reviewedBy: null, reviewedAt: null, createdAt: at, updatedAt: at,
    ...overrides,
  });
}

function curatorOutput(evidenceIds: string[], overrides: Record<string, unknown> = {}) {
  return {
    action: "create", canonicalProblemId: null, title: "Battery electrolyte", statement: "Durable electrolyte needed",
    categories: ["energy"], relatedProblemIds: [], evidenceIds, missionAssessment, ...overrides,
  };
}

async function withModel<Input>(
  output: unknown,
  run: (inputs: Input[], requests: string[]) => Promise<void>,
): Promise<void> {
  const originalFetch = globalThis.fetch;
  const names = ["ANTHROPIC_API_KEY", "CLAUDE_MODEL", "ANTHROPIC_API_URL"] as const;
  const originalEnvironment = names.map((name) => [name, process.env[name]] as const);
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.CLAUDE_MODEL = "test-model";
  process.env.ANTHROPIC_API_URL = "https://example.invalid/messages";
  const inputs: Input[] = [];
  const requests: string[] = [];
  // Every request is intercepted: these tests never call a paid model or any service.
  globalThis.fetch = async (_url, init) => {
    const request = String(init?.body);
    requests.push(request);
    const body = JSON.parse(request) as { messages: Array<{ content: string }> };
    inputs.push(JSON.parse(body.messages[0]!.content) as Input);
    return new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(output) }] }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  };
  try {
    await run(inputs, requests);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, value] of originalEnvironment) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("Curator sends only deduplicated candidate/dossier/solution/attempt citations, with clipped model text", async () => {
  const cited = Array.from({ length: 4 }, () => evidence());
  const [first, second, solution, attempt] = cited as [Evidence, Evidence, Evidence, Evidence];
  first.excerpt = `${"relevant ".repeat(10_000)}RELEVANT_TAIL`;
  first.title = "battery ".repeat(1_000);
  first.publisher = "lab ".repeat(1_000);
  const value = candidate([first.id, first.id]);
  const report = dossier(value, {
    evidenceIds: [second.id, first.id],
    existingSolutions: [{ name: "Existing", description: "Partial solution", evidenceIds: [solution.id, first.id] }],
    priorAttempts: [{ name: "Attempt", description: "Failed test", evidenceIds: [attempt.id, solution.id] }],
  });
  const unrelated = Array.from({ length: 100 }, () => evidence({ excerpt: "UNRELATED_ARCHIVE ".repeat(10_000) }));
  const archive = [...unrelated, ...cited, first];
  const original = structuredClone({ value, report, cited });
  await withModel<CuratorInput>(curatorOutput(cited.map((item) => item.id)), async (inputs, requests) => {
    const result = await runCurator(value, report, archive, []);
    assert.equal(inputs.length, 1);
    const input = inputs[0]!;
    assert.deepEqual(input.evidence.map((item) => item.id), cited.map((item) => item.id));
    assert.deepEqual(input.candidate.evidenceIds, [first.id]);
    assert.deepEqual(input.dossier.existingSolutions[0]!.evidenceIds, [solution.id, first.id]);
    assert.deepEqual(input.dossier.priorAttempts[0]!.evidenceIds, [attempt.id, solution.id]);
    assert.ok(input.evidence[0]!.excerpt.length <= 2_000);
    assert.ok(input.evidence[0]!.title.length <= 300);
    assert.ok(input.evidence[0]!.publisher.length <= 200);
    assert.ok(requests[0]!.length < 20_000);
    assert.ok(!requests[0]!.includes("UNRELATED_ARCHIVE"));
    assert.ok(!requests[0]!.includes("RELEVANT_TAIL"));
    assert.deepEqual(result.measurements, calculateMeasurements(cited, report));
    assert.deepEqual({ value, report, cited }, original);
  });
});

test("Curator caps evidence at 80 and retains full merged provenance and measurements", async () => {
  const cited = Array.from({ length: 90 }, (_, index) => evidence({
    publisher: `Lab ${index}`, excerpt: "support ".repeat(2_000),
  }));
  const historical = evidence({ publisher: "Historical source", sourceType: "government_report", publishedAt: "2026-09-12T00:00:00.000Z" });
  const unrelated = evidence({ publisher: "Unrelated", sourceType: "news_report", publishedAt: "2026-09-13T00:00:00.000Z" });
  const value = candidate(cited.map((item) => item.id));
  const report = dossier(value);
  const missingHistoricalId = randomUUID();
  const merged = problem([...value.evidenceIds, historical.id, missingHistoricalId, cited[0]!.id], {
    createdAt: "2026-08-01T00:00:00.000Z", categories: ["legacy"],
  });
  const original = structuredClone(merged);
  await withModel<CuratorInput>(curatorOutput([cited[0]!.id], {
    action: "merge", canonicalProblemId: merged.id, relatedProblemIds: [merged.id],
  }), async (inputs, requests) => {
    const result = await runCurator(value, report, [unrelated, historical, ...cited].reverse(), [merged]);
    const input = inputs[0]!;
    assert.equal(input.evidence.length, 80);
    assert.deepEqual(input.evidence.map((item) => item.id), value.evidenceIds.slice(0, 80));
    assert.deepEqual(input.candidate.evidenceIds, value.evidenceIds.slice(0, 80));
    assert.deepEqual(input.dossier.evidenceIds, value.evidenceIds.slice(0, 80));
    assert.ok(!requests[0]!.includes(cited[80]!.id));
    assert.ok(!requests[0]!.includes(historical.id));
    assert.ok(!requests[0]!.includes(missingHistoricalId));
    assert.ok(requests[0]!.length < 210_000);
    assert.equal(result.id, merged.id);
    assert.equal(result.createdAt, merged.createdAt);
    assert.deepEqual(result.evidenceIds, [...new Set(merged.evidenceIds)]);
    assert.deepEqual(result.sourceCandidateIds, [...merged.sourceCandidateIds, value.id]);
    assert.deepEqual(result.dossierIds, [...merged.dossierIds, report.id]);
    assert.deepEqual(result.categories, ["legacy", "energy"]);
    assert.deepEqual(result.relatedProblemIds, []);
    assert.deepEqual(result.measurements, calculateMeasurements([...cited, historical], report));
    assert.equal(result.measurements.mentionCount, 91);
    assert.equal(result.measurements.newestEvidenceAt, historical.publishedAt);
    assert.deepEqual(merged, original);
  });
});

test("Curator graph ranks the entire archive deterministically and supplies at most 50 compact records", async () => {
  const source = evidence();
  const value = candidate([source.id]);
  const report = dossier(value);
  const graph = Array.from({ length: 75 }, () => problem([source.id], {
    title: "Astronomy ".repeat(1_000), statement: "Telescope ".repeat(10_000), categories: ["space"],
    missionAlignment: { status: "uncertain", ...missionAssessment, rationale: "HIDDEN_GRAPH_PAYLOAD ".repeat(10_000) },
  }));
  const best = problem([source.id]);
  graph.push(best);
  const originalIds = graph.map((item) => item.id);
  const expectedIds = [best.id, ...graph.slice(0, -1).map((item) => item.id).sort().slice(0, 49)];
  await withModel<CuratorInput>(curatorOutput([source.id], { relatedProblemIds: [best.id] }), async (inputs, requests) => {
    const result = await runCurator(value, report, [source], graph);
    await runCurator(value, report, [source], [...graph].reverse());
    assert.equal(inputs[0]!.existingProblems.length, 50);
    assert.deepEqual(inputs[0]!.existingProblems.map((item) => item.id), expectedIds);
    assert.deepEqual(inputs[1]!.existingProblems, inputs[0]!.existingProblems);
    assert.deepEqual(result.relatedProblemIds, [best.id]);
    for (const item of inputs[0]!.existingProblems) {
      assert.deepEqual(Object.keys(item).sort(), ["categories", "id", "statement", "title"]);
      assert.ok(item.title.length <= 300);
      assert.ok(item.statement.length <= 1_500);
    }
    assert.ok(!requests[0]!.includes("HIDDEN_GRAPH_PAYLOAD"));
    assert.ok(requests[0]!.length < 110_000);
    assert.deepEqual(graph.map((item) => item.id), originalIds);
  });
});

test("Curator rejects unknown, unrelated, and capped-out evidence citations even if present elsewhere", async () => {
  const cited = Array.from({ length: 81 }, () => evidence());
  const unrelated = evidence();
  const missing = randomUUID();
  const value = candidate([...cited.map((item) => item.id), missing]);
  const report = dossier(value);
  for (const id of [randomUUID(), missing, unrelated.id, cited[80]!.id]) {
    await withModel<CuratorInput>(curatorOutput([id]), async (inputs) => {
      await assert.rejects(runCurator(value, report, [...cited, unrelated], []), /unknown evidence IDs/);
      assert.ok(!JSON.stringify(inputs[0]).includes(id));
    });
  }
});

test("Curator rejects merge and related IDs omitted from the supplied graph, not just globally unknown IDs", async () => {
  const source = evidence();
  const value = candidate([source.id]);
  const report = dossier(value);
  const graph = Array.from({ length: 51 }, () => problem([source.id]));
  const hiddenId = graph.map((item) => item.id).sort().at(-1)!;
  for (const id of [hiddenId, randomUUID()]) {
    for (const kind of ["merge", "related"] as const) {
      const output = curatorOutput([source.id], kind === "merge"
        ? { action: "merge", canonicalProblemId: id }
        : { relatedProblemIds: [id] });
      await withModel<CuratorInput>(output, async (inputs) => {
        await assert.rejects(runCurator(value, report, [source], graph), /unknown problem|unknown related problems/);
        assert.ok(!inputs[0]!.existingProblems.some((item) => item.id === id));
      });
    }
  }
});

test("Mission assessment uses only capped cited excerpts and compact problem metadata", async () => {
  const cited = Array.from({ length: 90 }, () => evidence({ excerpt: "relevant ".repeat(5_000) }));
  const unrelated = evidence({ excerpt: "UNRELATED_MISSION_ARCHIVE ".repeat(100_000) });
  const value = problem(cited.map((item) => item.id), {
    title: "battery ".repeat(1_000), statement: "electrolyte ".repeat(10_000),
    missionAlignment: { status: "uncertain", ...missionAssessment, rationale: "OLD_ASSESSMENT_ARCHIVE ".repeat(10_000) },
  });
  const original = structuredClone(value);
  await withModel<MissionInput>(missionAssessment, async (inputs, requests) => {
    const result = await assessMissionAlignment(value, [unrelated, ...cited, cited[0]!]);
    const input = inputs[0]!;
    assert.equal(result.status, "aligned");
    assert.equal(input.evidence.length, 80);
    assert.deepEqual(input.problem.evidenceIds, value.evidenceIds.slice(0, 80));
    assert.deepEqual(input.evidence.map((item) => item.id), input.problem.evidenceIds);
    assert.ok(input.evidence.every((item) => item.excerpt.length <= 2_000));
    assert.deepEqual(Object.keys(input.problem).sort(), ["categories", "evidenceIds", "id", "statement", "title"]);
    assert.ok(!requests[0]!.includes("UNRELATED_MISSION_ARCHIVE"));
    assert.ok(!requests[0]!.includes("OLD_ASSESSMENT_ARCHIVE"));
    assert.ok(requests[0]!.length < 205_000);
    assert.deepEqual(value, original);
  });
});

test("Investigator normalizes null solution and prior-attempt URLs only at the model output boundary", async () => {
  const source = evidence();
  const value = candidate([source.id]);
  const references = [null, undefined, "https://example.com/solution"].map((url) => ({
    name: "Solution", description: "Partial solution", evidenceIds: [source.id], url,
  }));
  await withModel<unknown>({
    ...dossier(value), existingSolutions: references, priorAttempts: references,
  }, async () => {
    const result = await runInvestigator(value, [source]);
    for (const items of [result.existingSolutions, result.priorAttempts]) {
      assert.equal(items.length, 3);
      assert.equal(items[0]!.url, undefined);
      assert.equal(items[1]!.url, undefined);
      assert.equal(items[2]!.url, "https://example.com/solution");
      assert.deepEqual(items.map((item) => item.evidenceIds), references.map((item) => item.evidenceIds));
      assert.ok(!("url" in JSON.parse(JSON.stringify(items[0]))));
    }
    assert.equal(solutionReferenceSchema.safeParse(references[0]).success, false, "storage schema still rejects null");
  });
});

test("Investigator still rejects invalid non-null URLs in both reference arrays", async () => {
  const source = evidence();
  const value = candidate([source.id]);
  for (const field of ["existingSolutions", "priorAttempts"] as const) {
    for (const url of ["not a URL", "", 42]) {
      await withModel<unknown>({
        ...dossier(value),
        [field]: [{ name: "Solution", description: "Partial solution", evidenceIds: [source.id], url }],
      }, async () => {
        await assert.rejects(runInvestigator(value, [source]), /url/);
      });
    }
  }
});

test("Investigator null URL normalization does not invent evidence or accept unknown citations", async () => {
  const source = evidence();
  const value = candidate([source.id]);
  const reference = { name: "Solution", description: "Partial solution", evidenceIds: [] as string[], url: null };
  await withModel<unknown>({
    ...dossier(value), existingSolutions: [reference], priorAttempts: [reference],
  }, async () => {
    const result = await runInvestigator(value, [source]);
    assert.deepEqual(result.existingSolutions, []);
    assert.deepEqual(result.priorAttempts, []);
    assert.deepEqual(result.evidenceIds, [source.id]);
  });
  for (const field of ["existingSolutions", "priorAttempts"] as const) {
    await withModel<unknown>({
      ...dossier(value), [field]: [{ ...reference, evidenceIds: [randomUUID()] }],
    }, async () => {
      await assert.rejects(runInvestigator(value, [source]), /unknown evidence IDs/);
    });
  }
});