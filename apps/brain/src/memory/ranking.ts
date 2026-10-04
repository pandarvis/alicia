import { words } from "./embedder.ts";

const RRF_K = 60;

/** FTS5 query from free text: each word quoted (no operator injection), any word may match. */
export function ftsQuery(text: string): string | null {
  const unique = [...new Set(words(text))];
  return unique.length === 0 ? null : unique.map((word) => `"${word}"`).join(" OR ");
}

/** Reciprocal rank fusion of several ranked id lists; ties keep first-seen order (stable sort). */
export function fuse(lists: readonly (readonly string[])[]): string[] {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((id, rank) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + rank + 1));
    });
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}
