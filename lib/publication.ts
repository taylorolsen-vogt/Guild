import { projectSchema, type Project } from "../schemas/project.js";

export function isPublishedProject(project: Project): boolean {
  return project.agentReview.decision === "approved" && project.decision === "selected"
    && project.status !== "archived" && project.lifecycleStatus !== "completed";
}

export function applyPublicationDecision(project: Project, decision: "selected" | "rejected", reviewer: string, at: string): Project {
  if (!reviewer.trim()) throw new Error("A curator name is required.");
  if (project.agentReview.decision !== "approved") throw new Error("Only agent-approved plans can be curated.");
  if (project.status === "archived" || project.lifecycleStatus === "completed") throw new Error("Archived or completed plans cannot be published or curated.");
  if (project.decision === decision) return project;
  return projectSchema.parse({ ...project, decision, decidedBy: reviewer.trim(), decidedAt: at });
}