import "dotenv/config";
import { runApprover } from "../agents/approver.js";
import { closeDatabase, listArtifacts, saveArtifact } from "../db/repository.js";
import { canonicalProblemSchema, evidenceSchema, projectSchema } from "../schemas/index.js";

const [projects, problems, evidence] = await Promise.all([
  listArtifacts("project", projectSchema),
  listArtifacts("problem", canonicalProblemSchema),
  listArtifacts("evidence", evidenceSchema),
]);
const problemById = new Map(problems.map((problem) => [problem.id, problem]));
const evidenceById = new Map(evidence.map((item) => [item.id, item]));

try {
  for (const project of projects) {
    if (project.status === "archived" || project.agentReview.decision !== "pending") continue;
    const problem = problemById.get(project.canonicalProblemId);
    if (!problem || problem.missionAlignment.status !== "aligned") continue;
    const projectEvidence = project.evidenceIds.flatMap((id) => {
      const item = evidenceById.get(id);
      return item ? [item] : [];
    });
    const reviewed = await runApprover(project, problem, projectEvidence);
    await saveArtifact("project", reviewed);
    console.log(`${reviewed.agentReview.decision}: ${reviewed.title}`);
  }
} finally {
  await closeDatabase();
}