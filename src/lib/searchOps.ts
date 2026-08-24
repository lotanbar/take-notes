/** First occurrence of `query` in `text`, with `radius` chars of context on each side. */
export function buildSnippet(text: string, query: string, radius = 40): string | null {
  return buildSnippetMatch(text, query, radius)?.text ?? null;
}

export interface SnippetMatch {
  text: string;
  matchStart: number;
  matchLength: number;
  sourceOffset: number;
}

/** A context snippet plus exact highlight and navigation offsets. */
export function buildSnippetMatch(text: string, query: string, radius = 40): SnippetMatch | null {
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return null;
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + query.length + radius);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  const raw = text.slice(start, end);
  const leadingTrim = raw.length - raw.trimStart().length;
  const body = raw.trim();
  return {
    text: prefix + body + suffix,
    matchStart: prefix.length + idx - start - leadingTrim,
    matchLength: query.length,
    sourceOffset: idx,
  };
}
