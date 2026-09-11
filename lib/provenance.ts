export function assertKnownEvidenceIds(ids: string[], allowedIds: Set<string>, context: string): void {
  const unknown = ids.filter((id) => !allowedIds.has(id));
  if (unknown.length > 0) {
    throw new Error(`${context} cited unknown evidence IDs: ${unknown.join(", ")}`);
  }
}