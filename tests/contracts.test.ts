import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { calculateMeasurements, deriveMissionStatus } from "../agents/curator.js";
import { runPlanner } from "../agents/planner.js";
import { assertKnownEvidenceIds } from "../lib/provenance.js";
import { createEvidence } from "../schemas/evidence.js";
import { canonicalProblemSchema } from "../schemas/problem.js";

test("evidence creation records immutable provenance", () => {
  const evidence = createEvidence({
    url: "https://example.com/report",
    title: "Field report",
    publisher: "Example Lab",
    sourceType: "field_report",
    observedAt: "2026-09-09T00:00:00.000Z",
    excerpt: "A documented failure mode.",
    adapter: "test",
    query: "failure mode",
  });

  assert.equal(evidence.contentHash.length, 64);
  assert.equal(evidence.url, "https://example.com/report");
});

test("unknown evidence citations are rejected", () => {
  assert.throws(
    () => assertKnownEvidenceIds([randomUUID()], new Set(), "test"),
    /unknown evidence IDs/,
  );
});

test("canonical problems expose measurements and no synthetic score", () => {
  const id = randomUUID();
  const candidateId = randomUUID();
  const dossierId = randomUUID();
  const evidenceId = randomUUID();
  const problem = canonicalProblemSchema.parse({
    id,
    title: "Verified problem",
    statement: "A supported, bounded problem statement.",
    sourceCandidateIds: [candidateId],
    dossierIds: [dossierId],
    evidenceIds: [evidenceId],
    categories: ["infrastructure"],
    relatedProblemIds: [],
    measurements: {
      independentSourceCount: 1,
      sourceTypeCount: 1,
      mentionCount: 1,
      newestEvidenceAt: "2026-09-09T00:00:00.000Z",
      existingSolutionCount: 0,
      failedAttemptCount: 0,
      affectedPopulationEstimate: null,
      affectedPopulationEvidenceIds: [],
    },
    approval: "pending",
    reviewedBy: null,
    reviewedAt: null,
    createdAt: "2026-09-09T00:00:00.000Z",
    updatedAt: "2026-09-09T00:00:00.000Z",
  });

  assert.equal("score" in problem, false);
});

test("planner can draft a proposal before human approval", async () => {
  const evidenceId = randomUUID();
  const problem = canonicalProblemSchema.parse({
    id: randomUUID(),
    title: "Pending problem",
    statement: "This problem has not been approved.",
    sourceCandidateIds: [randomUUID()],
    dossierIds: [randomUUID()],
    evidenceIds: [evidenceId],
    categories: [],
    relatedProblemIds: [],
    measurements: {
      independentSourceCount: 1,
      sourceTypeCount: 1,
      mentionCount: 1,
      newestEvidenceAt: "2026-09-09T00:00:00.000Z",
      existingSolutionCount: 0,
      failedAttemptCount: 0,
      affectedPopulationEstimate: null,
      affectedPopulationEvidenceIds: [],
    },
    missionAlignment: alignedMissionAssessment(),
    approval: "pending",
    reviewedBy: null,
    reviewedAt: null,
    createdAt: "2026-09-09T00:00:00.000Z",
    updatedAt: "2026-09-09T00:00:00.000Z",
  });

  await assert.rejects(() => runPlanner(problem, []), /Set ANTHROPIC_API_KEY/);
});

test("mission status rejects routine delivery without an opaque score", () => {
  assert.equal(deriveMissionStatus({
    ...alignedMissionAssessment(),
    primarilyRoutineDelivery: "yes",
    exclusionReasons: ["Routine service delivery"],
  }), "not_aligned");
});

test("curator measurements are derived from evidence and dossier records", () => {
  const first = createEvidence({
    url: "https://example.com/one",
    title: "First report",
    publisher: "Lab A",
    sourceType: "field_report",
    observedAt: "2026-09-08T00:00:00.000Z",
    excerpt: "First observation.",
    adapter: "test",
    query: "test",
  });
  const second = createEvidence({
    url: "https://example.com/two",
    title: "Second report",
    publisher: "Lab B",
    sourceType: "academic_paper",
    observedAt: "2026-09-09T00:00:00.000Z",
    excerpt: "Second observation.",
    adapter: "test",
    query: "test",
  });
  const dossier = {
    id: randomUUID(),
    candidateId: randomUUID(),
    verdict: "supported" as const,
    verdictReason: "Independent reports agree.",
    evidenceIds: [first.id, second.id],
    existingSolutions: [{ name: "Existing", description: "Partial solution", evidenceIds: [first.id] }],
    priorAttempts: [{ name: "Attempt", description: "Did not resolve the issue", evidenceIds: [second.id] }],
    contradictions: [],
    openQuestions: [],
    createdAt: "2026-09-09T00:00:00.000Z",
  };

  assert.deepEqual(calculateMeasurements([first, second], dossier), {
    independentSourceCount: 2,
    sourceTypeCount: 2,
    mentionCount: 2,
    newestEvidenceAt: "2026-09-09T00:00:00.000Z",
    existingSolutionCount: 1,
    failedAttemptCount: 1,
    affectedPopulationEstimate: null,
    affectedPopulationEvidenceIds: [],
  });
});

function alignedMissionAssessment() {
  return {
    status: "aligned" as const,
    frontierCapability: "yes" as const,
    broadlyReusable: "yes" as const,
    engineeringCore: "yes" as const,
    feasibleGuildContribution: "yes" as const,
    primarilyRoutineDelivery: "no" as const,
    frontierDomains: ["frontier energy"],
    exclusionReasons: [],
    rationale: "Creates reusable frontier engineering capability.",
  };
}