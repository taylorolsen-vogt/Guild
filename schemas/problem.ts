import { z } from "zod";

export const solutionReferenceSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  url: z.string().url().optional(),
  evidenceIds: z.array(z.string().uuid()).min(1),
});

export const problemDossierSchema = z.object({
  id: z.string().uuid(),
  candidateId: z.string().uuid(),
  verdict: z.enum(["supported", "uncertain", "rejected"]),
  verdictReason: z.string().min(1),
  evidenceIds: z.array(z.string().uuid()).min(1),
  existingSolutions: z.array(solutionReferenceSchema),
  priorAttempts: z.array(solutionReferenceSchema),
  contradictions: z.array(z.string()),
  openQuestions: z.array(z.string()),
  createdAt: z.string().datetime(),
});

export const measurementsSchema = z.object({
  independentSourceCount: z.number().int().nonnegative(),
  sourceTypeCount: z.number().int().nonnegative(),
  mentionCount: z.number().int().nonnegative(),
  newestEvidenceAt: z.string().datetime().nullable(),
  existingSolutionCount: z.number().int().nonnegative(),
  failedAttemptCount: z.number().int().nonnegative(),
  affectedPopulationEstimate: z.number().nonnegative().nullable(),
  affectedPopulationEvidenceIds: z.array(z.string().uuid()),
});

export const missionCriterionSchema = z.enum(["yes", "no", "uncertain"]);

export const missionAlignmentSchema = z.object({
  status: z.enum(["aligned", "not_aligned", "uncertain", "unassessed"]),
  frontierCapability: missionCriterionSchema,
  broadlyReusable: missionCriterionSchema,
  engineeringCore: missionCriterionSchema,
  feasibleGuildContribution: missionCriterionSchema,
  primarilyRoutineDelivery: missionCriterionSchema,
  frontierDomains: z.array(z.string().min(1)),
  exclusionReasons: z.array(z.string().min(1)),
  rationale: z.string().min(1),
}).default({
  status: "unassessed",
  frontierCapability: "uncertain",
  broadlyReusable: "uncertain",
  engineeringCore: "uncertain",
  feasibleGuildContribution: "uncertain",
  primarilyRoutineDelivery: "uncertain",
  frontierDomains: [],
  exclusionReasons: [],
  rationale: "Mission alignment has not been assessed.",
});

export const canonicalProblemSchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1),
  statement: z.string().min(1),
  sourceCandidateIds: z.array(z.string().uuid()).min(1),
  dossierIds: z.array(z.string().uuid()).min(1),
  evidenceIds: z.array(z.string().uuid()).min(1),
  categories: z.array(z.string().min(1)),
  relatedProblemIds: z.array(z.string().uuid()),
  measurements: measurementsSchema,
  missionAlignment: missionAlignmentSchema,
  approval: z.enum(["pending", "approved", "rejected"]),
  reviewedBy: z.string().min(1).nullable(),
  reviewedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type ProblemDossier = z.infer<typeof problemDossierSchema>;
export type CanonicalProblem = z.infer<typeof canonicalProblemSchema>;
export type MissionAlignment = z.infer<typeof missionAlignmentSchema>;