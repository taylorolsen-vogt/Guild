import "dotenv/config";
import { assessMissionAlignment } from "../agents/curator.js";
import { closeDatabase, listArtifacts, saveArtifact } from "../db/repository.js";
import { canonicalProblemSchema, evidenceSchema, projectSchema } from "../schemas/index.js";

try {
  const [problems, evidence, projects] = await Promise.all([
    listArtifacts("problem", canonicalProblemSchema),
    listArtifacts("evidence", evidenceSchema),
    listArtifacts("project", projectSchema),
  ]);
  const evidenceById = new Map(evidence.map((item) => [item.id, item]));

  for (const problem of problems) {
    const problemEvidence = problem.evidenceIds.flatMap((id) => {
      const item = evidenceById.get(id);
      return item ? [item] : [];
    });
    const missionAlignment = await assessMissionAlignment(problem, problemEvidence);
    await saveArtifact("problem", canonicalProblemSchema.parse({
      ...problem,
      missionAlignment,
      updatedAt: new Date().toISOString(),
    }));

    if (missionAlignment.status !== "aligned") {
      const relatedProjects = projects.filter((project) =>
        project.canonicalProblemId === problem.id && project.status !== "archived",
      );
      await Promise.all(relatedProjects.map((project) => saveArtifact("project", projectSchema.parse({
        ...project,
        decision: "rejected",
        decidedBy: "Mission gate",
        decidedAt: new Date().toISOString(),
        status: "archived",
      }))));
    }

    console.log(`${missionAlignment.status}: ${problem.title}`);
  }
} finally {
  await closeDatabase();
}