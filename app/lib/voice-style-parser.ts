// Voice transcript → style chip parser.
//
// Users say things like "a misty forest in noir style at sunset". We
// detect the style/time tokens in the trailing clause and route them
// to the style chip system. The cleaned prompt (with the style/time
// phrase removed) is what we send to the model.
//
// The parser is conservative: it never falsely strips words that
// happen to look like style tokens. Style tokens are matched only at
// the end of the transcript (where English speakers tend to put
// style modifiers), and only when they match a known preset/variant
// label.

import { STYLE_PRESETS, TIME_VARIANTS } from "./style-presets";

export interface ParsedVoiceStyle {
  cleanedPrompt: string;
  styleId: string | null;
  variantId: string | null;
}

// Build a flat lookup of "lowercase label" → id for both presets and
// variants. Matched case-insensitively against the transcript tail.
const STYLE_LOOKUP: Array<{ id: string; label: string }> = [
  ...STYLE_PRESETS.map((p) => ({ id: p.id, label: p.label.toLowerCase() })),
  ...TIME_VARIANTS.map((v) => ({ id: v.id, label: v.label.toLowerCase() })),
];

// Suffix patterns the user typically uses to introduce a style.
// We match them AFTER extracting the candidate style name. This
// means "in noir style" → "noir", "with cyberpunk vibes" → "cyberpunk".
const STYLE_INTROS = [
  /\bin\s+(?:a\s+)?(.+?)\s+style\b[\s.,!]*$/i,
  /\bwith\s+(?:a\s+)?(.+?)\s+(?:style|vibes?|look|aesthetic)\b[\s.,!]*$/i,
  /\bmake\s+it\s+(.+?)\b[\s.,!]*$/i,
  /\bapply\s+(?:a\s+)?(.+?)\s+(?:style|filter)\b[\s.,!]*$/i,
  /\bgo\s+(.+?)\s+style\b[\s.,!]*$/i,
];

const TIME_INTROS = [
  /\bat\s+(.+?)[\s.,!]*$/i,
  /\bin\s+the\s+(.+?)[\s.,!]*$/i,
  /\bduring\s+(?:a\s+|the\s+)?(.+?)[\s.,!]*$/i,
];

/**
 * Inspect a voice transcript for style/variant mentions. Returns the
 * cleaned prompt (style phrase stripped from the tail) plus any chip
 * ids detected. The model still receives a high-quality prompt.
 */
export function parseVoiceStyle(raw: string): ParsedVoiceStyle {
  let text = raw.trim();
  if (!text) return { cleanedPrompt: text, styleId: null, variantId: null };

  let styleId: string | null = null;
  let variantId: string | null = null;

  // Try each style-intro pattern against the end of the transcript.
  for (const pattern of STYLE_INTROS) {
    const m = text.match(pattern);
    if (!m) continue;
    const candidate = m[1].trim().toLowerCase();
    const hit = matchStyleOrVariant(candidate);
    if (hit) {
      if (hit.kind === "style") {
        styleId = hit.id;
      } else {
        variantId = hit.id;
      }
      text = text.slice(0, m.index).trim();
      break;
    }
  }

  // Try time-of-day intro patterns against what remains.
  for (const pattern of TIME_INTROS) {
    const m = text.match(pattern);
    if (!m) continue;
    const candidate = m[1].trim().toLowerCase();
    const hit = matchStyleOrVariant(candidate);
    if (hit && hit.kind === "variant") {
      variantId = hit.id;
      text = text.slice(0, m.index).trim();
      break;
    }
    // No chip found for the time phrase; leave it in the prompt.
    break;
  }

  // Strip a trailing punctuation mark we may have left dangling.
  text = text.replace(/[\s.,!]+$/, "");

  return { cleanedPrompt: text, styleId, variantId };
}

function matchStyleOrVariant(
  candidate: string,
): { kind: "style" | "variant"; id: string } | null {
  const normalized = candidate.replace(/[^a-z0-9]+/g, " ").trim();
  if (!normalized) return null;
  // Exact match first — "noir" → STYLE_PRESETS[noir].
  for (const entry of STYLE_LOOKUP) {
    if (entry.label === normalized) {
      const isVariant = TIME_VARIANTS.some((v) => v.id === entry.id);
      return { kind: isVariant ? "variant" : "style", id: entry.id };
    }
  }
  // Substring match: "cyberpunk neon" → cyberpunk (the first label token).
  const firstWord = normalized.split(/\s+/)[0];
  if (!firstWord) return null;
  for (const entry of STYLE_LOOKUP) {
    if (
      entry.label === firstWord ||
      entry.label.startsWith(firstWord + " ") ||
      firstWord.startsWith(entry.label)
    ) {
      const isVariant = TIME_VARIANTS.some((v) => v.id === entry.id);
      return { kind: isVariant ? "variant" : "style", id: entry.id };
    }
  }
  return null;
}
