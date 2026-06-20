// Standalone REM drift prompt builder. Extracted from
// useRemDrift.ts in QA6 so it's unit-testable without
// React. Same algorithm as before, just lifted out.

export function buildRemPrompt(history: string[], now: Date = new Date()): string {
  const last = history[history.length - 1] ?? "";
  const older = history.slice(0, -1);
  const stop = new Set([
    "the", "a", "an", "in", "on", "at", "of", "to", "with", "and",
    "or", "but", "is", "are", "was", "were", "be", "been", "being",
    "this", "that", "these", "those", "it", "its", "as", "by",
    "for", "from", "into", "over", "under", "between", "while",
    "during", "before", "after", "soft", "very", "just", "now",
  ]);
  const words: string[] = [];
  for (const p of older) {
    for (const w of p.split(/[\s,.!?;:]+/)) {
      const lw = w.toLowerCase();
      if (lw.length < 4) continue;
      if (stop.has(lw)) continue;
      if (words.includes(lw)) continue;
      words.push(lw);
      if (words.length >= 5) break;
    }
    if (words.length >= 5) break;
  }
  const prefix = words.length > 0 ? `${words.join(", ")} drifting into ` : "";
  const hour = now.getHours();
  const tod =
    hour < 5 ? "late night" :
    hour < 8 ? "predawn" :
    hour < 12 ? "early morning" :
    hour < 17 ? "afternoon" :
    hour < 20 ? "evening" :
    "night";
  return `${prefix}${last}, ${tod} light, slow camera drift, dreamlike`;
}