import { z } from "zod";

export const difficultySchema = z.object({
  level: z.enum(["easy", "medium", "hard"]),
  rationale: z.string().trim().min(1),
});

export const difficultyRubric = `Classify the work, not the person's credentials; difficulty is not a credential gate.
Easy: basic tools, readily available materials, a hobbyist following instructions, and low-risk validation.
Medium: prior practical skill, some specialized tools, or integration work beyond basic assembly.
Hard: advanced engineering or research, professional equipment, or high-risk validation.
Consider the full scoped build and validation, including prerequisites, resources, integration, and risks.
Use the highest level required by essential work; explain concrete drivers and uncertainty without inventing requirements.`;

export const taskSchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1),
  description: z.string().min(1),
  discipline: z.string().min(1),
  instructions: z.array(z.string().min(1)).min(1),
  inputs: z.array(z.string().min(1)),
  outputs: z.array(z.string().min(1)).min(1),
  completionCriteria: z.array(z.string().min(1)).min(1),
  dependencyTaskIds: z.array(z.string().uuid()),
  milestoneId: z.string().uuid(),
  evidenceIds: z.array(z.string().uuid()).min(1),
  status: z.literal("proposed"),
});

export const milestoneSchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1),
  objective: z.string().min(1),
  successCriteria: z.array(z.string().min(1)).min(1),
});

export const deliverableSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
});

export const riskSchema = z.object({
  description: z.string().min(1),
  mitigation: z.string().min(1),
});

export const blueprintSchema = z.object({
  overview: z.string().min(1),
  prerequisites: z.array(z.string().min(1)),
  components: z.array(z.object({
    name: z.string().min(1),
    purpose: z.string().min(1),
    interfaces: z.array(z.string().min(1)),
  })).min(1),
  buildSequence: z.array(z.string().min(1)).min(1),
  validationPlan: z.array(z.string().min(1)).min(1),
});

export const verificationRecordSchema = z.object({
  status: z.enum(["active", "possibly_completed", "completed", "inconclusive"]),
  summary: z.string().min(1),
  evidenceIds: z.array(z.string().uuid()).min(1),
  checkedAt: z.string().datetime(),
});

export const agentReviewSchema = z.object({
  decision: z.enum(["pending", "approved", "rejected"]).default("pending"),
  rationale: z.string().nullable().default(null),
  findings: z.array(z.string().min(1)).default([]),
  reviewedAt: z.string().datetime().nullable().default(null),
});

export const projectSchema = z.object({
  id: z.string().uuid(),
  canonicalProblemId: z.string().uuid(),
  title: z.string().min(1),
  executiveSummary: z.string().min(1),
  objective: z.string().min(1),
  rationale: z.string().min(1),
  difficulty: difficultySchema.nullable().default(null),
  beneficiaries: z.array(z.string().min(1)).min(1),
  scope: z.object({
    included: z.array(z.string().min(1)).min(1),
    excluded: z.array(z.string().min(1)).min(1),
  }),
  blueprint: blueprintSchema,
  approach: z.array(z.string().min(1)).min(1),
  deliverables: z.array(deliverableSchema).min(1),
  unknowns: z.array(z.string().min(1)),
  constraints: z.array(z.string().min(1)),
  risks: z.array(riskSchema).min(1),
  successMetrics: z.array(z.string().min(1)).min(1),
  resourceNeeds: z.array(z.string().min(1)).min(1),
  evidenceIds: z.array(z.string().uuid()).min(1),
  milestones: z.array(milestoneSchema).min(1),
  tasks: z.array(taskSchema).min(1),
  agentReview: agentReviewSchema.default({
    decision: "pending",
    rationale: null,
    findings: [],
    reviewedAt: null,
  }),
  reviewMode: z.enum(["human_review", "agent_direct"]),
  decision: z.enum(["pending", "selected", "rejected"]),
  decidedBy: z.string().min(1).nullable(),
  decidedAt: z.string().datetime().nullable(),
  lifecycleStatus: z.enum(["unverified", "active", "possibly_completed", "completed"]).default("unverified"),
  verificationHistory: z.array(verificationRecordSchema).default([]),
  status: z.enum(["draft", "archived"]).default("draft"),
  createdAt: z.string().datetime(),
});

export const projectListSchema = z.object({ projects: z.array(projectSchema) });
export type Project = z.infer<typeof projectSchema>;