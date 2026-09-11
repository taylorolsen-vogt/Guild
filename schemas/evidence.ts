import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

export const sourceTypeSchema = z.enum([
  "academic_paper",
  "government_challenge",
  "government_report",
  "issue_report",
  "community_report",
  "field_report",
  "procurement_notice",
  "grant_notice",
  "news_report",
]);

export const evidenceSchema = z.object({
  id: z.string().uuid(),
  url: z.string().url(),
  title: z.string().min(1),
  publisher: z.string().min(1),
  sourceType: sourceTypeSchema,
  observedAt: z.string().datetime(),
  publishedAt: z.string().datetime().optional(),
  excerpt: z.string().min(1),
  contentHash: z.string().length(64),
  adapter: z.string().min(1),
  query: z.string().min(1),
});

export type Evidence = z.infer<typeof evidenceSchema>;
export type SourceType = z.infer<typeof sourceTypeSchema>;

export function createEvidence(input: Omit<Evidence, "id" | "contentHash">): Evidence {
  return evidenceSchema.parse({
    ...input,
    id: randomUUID(),
    contentHash: createHash("sha256")
      .update(`${input.url}\n${input.title}\n${input.excerpt}`)
      .digest("hex"),
  });
}