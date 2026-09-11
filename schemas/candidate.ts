import { z } from "zod";

export const candidateProblemSchema = z.object({
  id: z.string().uuid(),
  claim: z.string().min(1),
  problemHypothesis: z.string().min(1),
  evidenceIds: z.array(z.string().uuid()).min(1),
  observedAt: z.string().datetime(),
  status: z.literal("candidate"),
});

export const candidateProblemListSchema = z.object({
  candidates: z.array(candidateProblemSchema),
});

export type CandidateProblem = z.infer<typeof candidateProblemSchema>;