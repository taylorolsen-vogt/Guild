import type { Evidence } from "../schemas/evidence.js";

export interface SourceSearchOptions {
  query: string;
  limit: number;
}

export interface SourceAdapter {
  readonly name: string;
  search(options: SourceSearchOptions): Promise<Evidence[]>;
}