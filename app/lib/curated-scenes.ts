// Curated dreams — a small gallery of hand-picked starting points
// that showcase what the model can do. Each entry has a deterministic
// seed so the same prompt always lands in the same anchor frame.
//
// The list lives in code (not localStorage) because the gallery is
// global content, not user-generated. Clicking an entry fires the
// same `dream:loadScene` event the sidebar already uses, so the
// session journal still records the user's visit.

export interface CuratedScene {
  id: string;
  prompt: string;       // raw user-facing text
  seed: number;         // 32-bit unsigned
  emoji: string;        // visual anchor in the chip
  category: string;     // group label, e.g. "Nature", "City"
}

export const CURATED_SCENES: CuratedScene[] = [
  // Nature
  {
    id: "alpine-meadow",
    prompt: "a sunlit alpine meadow at golden hour with wildflowers and distant snow peaks",
    seed: 0xa1b2c3d4,
    emoji: "🌼",
    category: "Nature",
  },
  {
    id: "redwood-forest",
    prompt: "an old-growth redwood forest with shafts of morning light filtering through fog",
    seed: 0xb2c3d4e5,
    emoji: "🌲",
    category: "Nature",
  },
  {
    id: "arctic-iceberg",
    prompt: "a massive turquoise iceberg floating in still arctic water under a low pale sun",
    seed: 0xc3d4e5f6,
    emoji: "🧊",
    category: "Nature",
  },
  {
    id: "bamboo-grove",
    prompt: "a dense bamboo grove with rustling leaves and a stone path winding through",
    seed: 0xd4e5f6a7,
    emoji: "🎋",
    category: "Nature",
  },
  // City
  {
    id: "tokyo-alley",
    prompt: "a narrow tokyo alley at night, neon signs reflecting off wet pavement, vending machines glowing",
    seed: 0xe5f6a7b8,
    emoji: "🏮",
    category: "City",
  },
  {
    id: "venice-canal",
    prompt: "a quiet venice canal at dusk with gondolas and warm light spilling from shuttered windows",
    seed: 0xf6a7b8c9,
    emoji: "🛶",
    category: "City",
  },
  {
    id: "moroccan-souk",
    prompt: "a bustling moroccan souk with spice mounds, hanging lanterns, and arched sandstone walls",
    seed: 0xa7b8c9d0,
    emoji: "🏺",
    category: "City",
  },
  // Otherworldly
  {
    id: "mars-colony",
    prompt: "a small mars colony outpost with red dust, low dome habitats, and earth a pale dot in the sky",
    seed: 0xb8c9d0e1,
    emoji: "🚀",
    category: "Otherworld",
  },
  {
    id: "crystal-cave",
    prompt: "a vast crystal cave glowing with bioluminescent teal light, jagged mineral formations",
    seed: 0xc9d0e1f2,
    emoji: "💎",
    category: "Otherworld",
  },
  {
    id: "floating-islands",
    prompt: "floating islands suspended in a golden sky, waterfalls pouring into the clouds below",
    seed: 0xd0e1f2a3,
    emoji: "🏝️",
    category: "Otherworld",
  },
  // Cozy
  {
    id: "cozy-bookshop",
    prompt: "a cozy english bookshop with floor-to-ceiling shelves, a reading cat, and a fireplace crackling",
    seed: 0xe1f2a3b4,
    emoji: "📚",
    category: "Cozy",
  },
  {
    id: "japanese-tea-room",
    prompt: "a traditional japanese tea room looking onto a rain-soaked zen garden",
    seed: 0xf2a3b4c5,
    emoji: "🍵",
    category: "Cozy",
  },
];

export function findCurated(id: string | null): CuratedScene | null {
  if (!id) return null;
  return CURATED_SCENES.find((c) => c.id === id) ?? null;
}

export function groupByCategory(): Array<{ category: string; scenes: CuratedScene[] }> {
  const groups = new Map<string, CuratedScene[]>();
  for (const c of CURATED_SCENES) {
    if (!groups.has(c.category)) groups.set(c.category, []);
    groups.get(c.category)!.push(c);
  }
  return Array.from(groups.entries()).map(([category, scenes]) => ({ category, scenes }));
}

/**
 * Pick a curated scene deterministically from today's date string.
 * The same calendar day on the same device always yields the same
 * scene — so a user who comes back the next day sees a new starting
 * dream, and a user who closes/reopens the app today sees the same
 * dream. The selection rotates through `CURATED_SCENES` based on
 * a stable hash of `YYYY-MM-DD`.
 */
export function dailyDream(now: Date = new Date()): CuratedScene {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const key = `${y}-${m}-${d}`;
  let hash = 2166136261 >>> 0;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  const idx = hash % CURATED_SCENES.length;
  return CURATED_SCENES[idx];
}

/** Human-friendly "Dream of June 20" style title for the daily session. */
export function dailyDreamTitle(now: Date = new Date()): string {
  const month = now.toLocaleString("en-US", { month: "long" });
  return `Dream of ${month} ${now.getDate()}`;
}