import { createEvidence, type Evidence } from "../schemas/evidence.js";
import type { SourceAdapter, SourceSearchOptions } from "./types.js";

interface GitHubIssue {
  html_url: string;
  title: string;
  body: string | null;
  created_at: string;
  repository_url: string;
}

export const githubAdapter: SourceAdapter = {
  name: "github",
  async search({ query, limit }: SourceSearchOptions): Promise<Evidence[]> {
    const url = new URL("https://api.github.com/search/issues");
    url.searchParams.set("q", `${truncateQuery(query)} is:issue`);
    url.searchParams.set("per_page", String(limit));
    url.searchParams.set("sort", "updated");

    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "user-agent": "the-engineers/0.1",
    };
    if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

    const response = await fetch(url, { headers });
    if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
    const payload = (await response.json()) as { items?: GitHubIssue[] };

    return (payload.items ?? []).map((issue) => createEvidence({
      url: issue.html_url,
      title: issue.title,
      publisher: issue.repository_url.replace("https://api.github.com/repos/", "GitHub: "),
      sourceType: "issue_report",
      observedAt: new Date().toISOString(),
      publishedAt: new Date(issue.created_at).toISOString(),
      excerpt: truncate(issue.body ?? issue.title),
      adapter: this.name,
      query,
    }));
  },
};

function truncate(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 2_000);
}

function truncateQuery(value: string): string {
  return value
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}