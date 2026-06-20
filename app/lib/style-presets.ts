// Style preset library for the "Dream" input UI.
//
// The model produces dramatically different worlds depending on the
// stylistic suffix we append to the user's prompt. These presets are
// tuned to render well on LingBot (realtime world model) and to give
// the user a clear visual difference per chip click — they're not
// vague adjectives, they're paint-able visual anchors.
//
// Each preset can declare `conflictsWith` — time-of-day or weather
// variants that, when paired, send contradictory instructions to the
// model (e.g. Noir + Sunset). When a conflict is detected the UI
// dims the offending chips and `composePrompt` downgrades the
// conflicting token rather than firing both at the model.

export interface StylePreset {
  id: string;
  label: string;       // chip text, e.g. "Cyberpunk"
  emoji: string;       // visible on the chip
  suffix: string;      // appended to user prompt
  /** TimeVariant ids that should be visually + semantically downgraded when paired. */
  conflictsWith?: string[];
}

export const STYLE_PRESETS: StylePreset[] = [
  {
    // GTLI-style hyper-realism. Promoted to the top because users on
    // desktop (where this is most visible) overwhelmingly prefer the
    // photoreal look over stylized looks. The suffix is tuned to push
    // LingBot toward the Geodiffusion / world-realism aesthetic:
    // global illumination, tonemapped natural light, raytraced GI,
    // 35mm-equivalent DOF, ground-truth color.
    id: "hyperreal",
    label: "Hyper-Real",
    emoji: "✨",
    suffix: "hyperrealistic photograph, global illumination, raytraced, ground-truth color, natural lighting, 35mm lens, shallow depth of field, 8K, physically based rendering, sharp focus, no stylization",
    conflictsWith: ["watercolor", "vaporwave"],
  },
  {
    id: "photoreal",
    label: "Photoreal",
    emoji: "📷",
    suffix: "photorealistic, 8K, cinematic lighting, shallow depth of field",
    conflictsWith: ["watercolor", "vaporwave"],
  },
  {
    id: "cyberpunk",
    label: "Cyberpunk",
    emoji: "🌃",
    suffix: "neon-lit cyberpunk city, rain-slick streets, holographic signage, teal and magenta, dense atmosphere",
    conflictsWith: ["noir", "watercolor"],
  },
  {
    id: "watercolor",
    label: "Watercolor",
    emoji: "🎨",
    suffix: "soft watercolor painting, visible paper texture, ink outlines, pastel washes, hand-painted feel",
    conflictsWith: ["hyperreal", "photoreal", "cyberpunk", "noir"],
  },
  {
    id: "noir",
    label: "Noir",
    emoji: "🌫️",
    suffix: "black-and-white film noir, hard shadows, venetian-blind lighting, 1940s detective movie aesthetic",
    // Conflict with everything color-driven — sunset/rain/dawn produce
    // chromatic cues that fight a monochrome palette.
    conflictsWith: ["sunset", "rain", "dawn", "watercolor", "cyberpunk", "vaporwave"],
  },
  {
    id: "vaporwave",
    label: "Vaporwave",
    emoji: "🌴",
    suffix: "vaporwave aesthetic, pink and cyan gradients, retro 80s grid, palm trees, marble statues, sunset glow",
    conflictsWith: ["hyperreal", "photoreal", "noir", "rain", "night"],
  },
];

export function findPreset(id: string | null): StylePreset | null {
  if (!id) return null;
  return STYLE_PRESETS.find((p) => p.id === id) ?? null;
}

// Time-of-day and weather variants. The model can render the same
// scene under drastically different lighting; these let the user
// "recolor" an existing prompt without rewriting it.
export interface TimeVariant {
  id: string;
  label: string;
  emoji: string;
  suffix: string;
  conflictsWith?: string[];   // style ids that conflict with this variant
}

export const TIME_VARIANTS: TimeVariant[] = [
  {
    id: "none",
    label: "Default",
    emoji: "✨",
    suffix: "",
  },
  {
    id: "night",
    label: "Night",
    emoji: "🌙",
    suffix: ", at night with moonlit blue light and starfield overhead",
    conflictsWith: ["sunset", "dawn", "rain"],
  },
  {
    id: "sunset",
    label: "Sunset",
    emoji: "🌅",
    suffix: ", at golden hour sunset with warm orange-pink sky and long shadows",
    conflictsWith: ["noir", "night", "rain"],
  },
  {
    id: "dawn",
    label: "Dawn",
    emoji: "🌄",
    suffix: ", at early dawn with mist, soft lavender light, and dew on every surface",
    conflictsWith: ["noir", "night", "sunset"],
  },
  {
    id: "rain",
    label: "Rain",
    emoji: "🌧️",
    suffix: ", in heavy rain with wet reflective surfaces, puddles, and grey overcast sky",
    conflictsWith: ["noir", "sunset", "night", "vaporwave"],
  },
];

export function findVariant(id: string | null): TimeVariant | null {
  if (!id) return null;
  return TIME_VARIANTS.find((v) => v.id === id) ?? null;
}

/**
 * Returns true if the (presetId, variantId) pair is in conflict.
 * The caller should visually dim one of the chips and downgrade the
 * conflicting suffix token (see `composePrompt`).
 */
export function hasConflict(
  presetId: string | null,
  variantId: string | null,
): boolean {
  if (!presetId || !variantId || variantId === "none") return false;
  const preset = findPreset(presetId);
  const variant = findVariant(variantId);
  if (!preset || !variant) return false;
  return (
    preset.conflictsWith?.includes(variantId) === true ||
    variant.conflictsWith?.includes(presetId) === true
  );
}

/**
 * Compose the final paint-time prompt by joining the user's raw text
 * with the selected preset + variant suffixes. When the pair is in
 * conflict, the variant's time-of-day language is dropped (keeps the
 * user's subject + style; only discards the contradictory atmospheric
 * descriptor).
 */
export function composePrompt(
  raw: string,
  presetId: string | null,
  variantId: string | null,
): string {
  const preset = findPreset(presetId);
  const variant = findVariant(variantId);
  const useVariant = variant && (!variant.suffix || !hasConflict(presetId, variantId));
  const parts: string[] = [];
  if (raw) parts.push(raw);
  if (preset) parts.push(preset.suffix);
  if (useVariant && variant.suffix) parts.push(variant.suffix);
  return parts.join(", ");
}