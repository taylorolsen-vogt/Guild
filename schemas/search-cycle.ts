import { randomUUID } from "node:crypto";
import { z } from "zod";
import { evidenceSchema } from "./evidence.js";
import { pipelineRunSchema } from "./run.js";

export const searchCycleProfileSchema = z.enum(["image_review", "frontier_scan"]);
export type SearchCycleProfile = z.infer<typeof searchCycleProfileSchema>;

/** These are concept labels, NOT evidence of an existing product or unmet need. */
export const imageReviewConcepts = [
  { id: "reef", title: "Autonomous reef monitoring module", searchTerms: ["autonomous reef monitoring", "coral monitoring sensors"], context: "Assess a replicable autonomous reef observation module for marine researchers and reef stewards; establish actual users and gaps from sources, not the illustration." },
  { id: "prosthetic", title: "Open-source prosthetic hand", searchTerms: ["open prosthetic hand", "prosthetic hand limitations"], context: "Assess open prosthetic hand engineering against existing open alternatives, user requirements, safety and validation; do not assume a pictured hand is novel or clinically usable." },
  { id: "shelter", title: "Emergency shelter system", searchTerms: ["emergency shelter engineering", "modular shelter limitations"], context: "Assess reusable emergency shelter engineering for displaced people and responders, distinguishing documented technical gaps from routine aid delivery or an attractive rendering." },
  { id: "orbital", title: "Modular orbital sensor platform", searchTerms: ["modular orbital sensors", "cubesat sensor limitations"], context: "Assess a modular orbital sensing platform against open spacecraft alternatives, with a feasible terrestrial prototype and documented integration or validation gap; an image is not flight heritage." },
  { id: "agriculture", title: "Autonomous precision agriculture rover", searchTerms: ["precision agriculture rover", "agricultural robot limitations"], context: "Assess open autonomous precision agriculture rovers for growers and researchers, including field reliability, repairability and existing open alternatives; do not infer capability from an image." },
] as const;
export type ImageReviewConcept = typeof imageReviewConcepts[number];

export const citedAssessmentSchema = z.object({
  text: z.string().trim().min(1).max(1400),
  evidenceIds: z.array(z.string().uuid()).max(40),
});
export const conceptReviewSchema = z.object({
  recommendation: z.enum(["propose", "do_not_add", "needs_evidence"]),
  gapStatus: z.enum(["documented", "not_established", "already_addressed"]),
  rationale: citedAssessmentSchema,
  value: citedAssessmentSchema,
  targetUsers: citedAssessmentSchema,
  alternatives: citedAssessmentSchema,
  gap: citedAssessmentSchema,
  feasibility: citedAssessmentSchema,
  duplicateSaturation: citedAssessmentSchema,
});
export type ConceptReview = z.infer<typeof conceptReviewSchema>;

export const searchCycleResultSchema = z.object({
  conceptId: z.string().min(1),
  title: z.string().min(1),
  searchTerms: z.array(z.string().min(1).max(120)).default([]),
  status: z.enum(["pending", "searching", "evaluated", "running", "completed", "failed", "interrupted", "skipped"]).default("pending"),
  assessment: conceptReviewSchema.nullable().default(null),
  evaluatedAt: z.string().datetime().nullable().default(null),
  evidence: z.array(evidenceSchema).default([]),
  evidenceIds: z.array(z.string().uuid()).default([]),
  runId: z.string().uuid().nullable().default(null),
  runStatus: pipelineRunSchema.shape.status.nullable().default(null),
  projectIds: z.array(z.string().uuid()).default([]),
  artifactIds: pipelineRunSchema.shape.artifactIds.default({ evidence: [], candidates: [], dossiers: [], problems: [], projects: [] }),
  warnings: z.array(z.string()).default([]),
  message: z.string().default("Waiting for the worker"),
  error: z.string().nullable().default(null),
});
export type SearchCycleResult = z.infer<typeof searchCycleResultSchema>;

export const searchCycleSchema = z.object({
  id: z.string().uuid(),
  profile: searchCycleProfileSchema,
  status: z.enum(["queued", "running", "completed", "failed"]).default("queued"),
  results: z.array(searchCycleResultSchema).default([]),
  runIds: z.array(z.string().uuid()).default([]),
  projectIds: z.array(z.string().uuid()).default([]),
  message: z.string().default("Waiting for the worker"),
  error: z.string().nullable().default(null),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable().default(null),
  finishedAt: z.string().datetime().nullable().default(null),
});
export type SearchCycle = z.infer<typeof searchCycleSchema>;

export function newSearchCycle(profile: SearchCycleProfile, at = new Date().toISOString()): SearchCycle {
  searchCycleProfileSchema.parse(profile);
  return searchCycleSchema.parse({
    id: randomUUID(), profile, status: "queued", createdAt: at, updatedAt: at,
    results: profile === "image_review"
      ? imageReviewConcepts.map(({ id, title, searchTerms }) => ({ conceptId: id, title, searchTerms }))
      : [{ conceptId: "frontier", title: "Frontier scan" }],
  });
}

/** Recompute projections instead of allowing refs to drift from their owning result. */
export function projectCycle(cycle: SearchCycle, at = new Date().toISOString()): SearchCycle {
  return searchCycleSchema.parse({ ...cycle, updatedAt: at,
    runIds: [...new Set(cycle.results.flatMap((result) => result.runId ? [result.runId] : []))],
    projectIds: [...new Set(cycle.results.flatMap((result) => result.projectIds))],
  });
}