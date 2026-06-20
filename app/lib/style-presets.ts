// Style preset library for the "Dream" input UI.
//
// The model produces dramatically different worlds depending on the
// stylistic suffix we append to the user's prompt. These presets are
// tuned to render well on LingBot (realtime world model) and to give
// the user a clear visual difference per chip click — they're not
// vague adjectives, they're paint-able visual anchors.

export interface StylePreset {
  id: string;
  label: string;       // chip text, e.g. "Cyberpunk"
  emoji: string;       // visible on the chip
  suffix: string;      // appended to user prompt
}

export const STYLE_PRESETS: StylePreset[] = [
  {
    id: "photoreal",
    label: "Photoreal",
    emoji: "📷",
    suffix: "photorealistic, 8K, cinematic lighting, shallow depth of field",
  },
  {
    id: "cyberpunk",
    label: "Cyberpunk",
    emoji: "🌃",
    suffix: "neon-lit cyberpunk city, rain-slick streets, holographic signage, teal and magenta, dense atmosphere",
  },
  {
    id: "watercolor",
    label: "Watercolor",
    emoji: "🎨",
    suffix: "soft watercolor painting, visible paper texture, ink outlines, pastel washes, hand-painted feel",
  },
  {
    id: "noir",
    label: "Noir",
    emoji: "🌫️",
    suffix: "black-and-white film noir, hard shadows, venetian-blind lighting, 1940s detective movie aesthetic",
  },
  {
    id: "vaporwave",
    label: "Vaporwave",
    emoji: "🌴",
    suffix: "vaporwave aesthetic, pink and cyan gradients, retro 80s grid, palm trees, marble statues, sunset glow",
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
  },
  {
    id: "sunset",
    label: "Sunset",
    emoji: "🌅",
    suffix: ", at golden hour sunset with warm orange-pink sky and long shadows",
  },
  {
    id: "dawn",
    label: "Dawn",
    emoji: "🌄",
    suffix: ", at early dawn with mist, soft lavender light, and dew on every surface",
  },
  {
    id: "rain",
    label: "Rain",
    emoji: "🌧️",
    suffix: ", in heavy rain with wet reflective surfaces, puddles, and grey overcast sky",
  },
];

export function findVariant(id: string | null): TimeVariant | null {
  if (!id) return null;
  return TIME_VARIANTS.find((v) => v.id === id) ?? null;
}