import { createEvidence, type Evidence } from "../schemas/evidence.js";
import type { SourceAdapter, SourceSearchOptions } from "./types.js";

interface FederalRegisterDocument {
  html_url: string;
  title: string;
  abstract: string | null;
  publication_date: string;
  agencies: Array<{ name: string }>;
  type: string;
}

export const governmentAdapter: SourceAdapter = {
  name: "government",
  async search({ query, limit }: SourceSearchOptions): Promise<Evidence[]> {
    const url = new URL("https://www.federalregister.gov/api/v1/documents.json");
    url.searchParams.set("per_page", String(limit));
    url.searchParams.set("order", "newest");
    url.searchParams.set("conditions[term]", query);

    const response = await fetch(url, { headers: { "user-agent": "the-engineers/0.1" } });
    if (!response.ok) throw new Error(`Federal Register returned ${response.status}`);
    const payload = (await response.json()) as { results?: FederalRegisterDocument[] };

    return (payload.results ?? []).map((document) => createEvidence({
      url: document.html_url,
      title: document.title,
      publisher: document.agencies.map((agency) => agency.name).join(", ") || "Federal Register",
      sourceType: classify(document.type),
      observedAt: new Date().toISOString(),
      publishedAt: new Date(`${document.publication_date}T00:00:00.000Z`).toISOString(),
      excerpt: truncate(document.abstract ?? document.title),
      adapter: this.name,
      query,
    }));
  },
};

function classify(type: string): "government_report" | "procurement_notice" | "grant_notice" {
  const normalized = type.toLowerCase();
  if (normalized.includes("grant")) return "grant_notice";
  if (normalized.includes("procurement")) return "procurement_notice";
  return "government_report";
}

function truncate(value: string): string {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 2_000);
}