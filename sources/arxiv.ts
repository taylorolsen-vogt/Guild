import { XMLParser } from "fast-xml-parser";
import { createEvidence, type Evidence } from "../schemas/evidence.js";
import type { SourceAdapter, SourceSearchOptions } from "./types.js";

interface ArxivEntry {
  id: string;
  title: string;
  summary: string;
  published?: string;
}

export const arxivAdapter: SourceAdapter = {
  name: "arxiv",
  async search({ query, limit }: SourceSearchOptions): Promise<Evidence[]> {
    const url = new URL("https://export.arxiv.org/api/query");
    url.searchParams.set("search_query", `all:${query}`);
    url.searchParams.set("start", "0");
    url.searchParams.set("max_results", String(limit));

    const response = await fetch(url, { headers: { "user-agent": "the-engineers/0.1" } });
    if (!response.ok) throw new Error(`arXiv returned ${response.status}`);

    const parsed = new XMLParser().parse(await response.text()) as {
      feed?: { entry?: ArxivEntry | ArxivEntry[] };
    };
    const rawEntries = parsed.feed?.entry;
    const entries = rawEntries ? (Array.isArray(rawEntries) ? rawEntries : [rawEntries]) : [];

    return entries.map((entry) => createEvidence({
      url: entry.id,
      title: clean(entry.title),
      publisher: "arXiv",
      sourceType: "academic_paper",
      observedAt: new Date().toISOString(),
      ...(entry.published ? { publishedAt: new Date(entry.published).toISOString() } : {}),
      excerpt: clean(entry.summary),
      adapter: this.name,
      query,
    }));
  },
};

function clean(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}