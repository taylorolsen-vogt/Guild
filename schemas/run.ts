import { z } from "zod";

export const reviewModeSchema = z.enum(["human_review", "agent_direct"]);

export const pipelineRunSchema = z.object({
  id: z.string().uuid(),
  query: z.string().min(1),
  sources: z.array(z.string().min(1)).min(1),
  limit: z.number().int().min(1).max(25),
  reviewMode: reviewModeSchema,
  status: z.enum(["queued", "running", "completed", "failed"]),
  stage: z.enum(["queued", "scout", "investigator", "curator", "planner", "approver", "complete", "failed"]),
  message: z.string().min(1),
  warnings: z.array(z.string()),
  artifactIds: z.object({
    evidence: z.array(z.string().uuid()),
    candidates: z.array(z.string().uuid()),
    dossiers: z.array(z.string().uuid()),
    problems: z.array(z.string().uuid()),
    projects: z.array(z.string().uuid()),
  }),
  error: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type PipelineRun = z.infer<typeof pipelineRunSchema>;
export type ReviewMode = z.infer<typeof reviewModeSchema>;