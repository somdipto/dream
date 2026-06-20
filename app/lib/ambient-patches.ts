// Ambient patch table for the Sound World feature. Extracted
// from useAmbient.ts in QA6 so it's unit-testable without a
// browser AudioContext.
//
// Each entry maps a keyword (matched greedily, longest first)
// to a procedural synth patch: filter type + cutoff, Q, noise
// color, master gain, and an LFO that modulates the cutoff for
// "breathing" sound.

export interface Patch {
  type: BiquadFilterType;
  cutoff: number;
  q: number;
  noiseColor: 0 | 1 | 2;
  gain: number;
  lfoRate: number;
  lfoDepth: number;
}

export const PATCHES: Array<[string, Patch]> = [
  ["underwater", { type: "lowpass", cutoff: 350, q: 1.5, noiseColor: 2, gain: 0.15, lfoRate: 0.1, lfoDepth: 80 }],
  ["rainstorm", { type: "lowpass", cutoff: 1200, q: 0.7, noiseColor: 0, gain: 0.18, lfoRate: 0.4, lfoDepth: 200 }],
  ["rain", { type: "lowpass", cutoff: 1000, q: 0.7, noiseColor: 0, gain: 0.12, lfoRate: 0.25, lfoDepth: 150 }],
  ["ocean", { type: "lowpass", cutoff: 500, q: 0.8, noiseColor: 2, gain: 0.18, lfoRate: 0.15, lfoDepth: 200 }],
  ["river", { type: "bandpass", cutoff: 800, q: 0.5, noiseColor: 1, gain: 0.15, lfoRate: 0.35, lfoDepth: 200 }],
  ["wind", { type: "bandpass", cutoff: 600, q: 0.4, noiseColor: 0, gain: 0.13, lfoRate: 0.18, lfoDepth: 300 }],
  ["storm", { type: "lowpass", cutoff: 700, q: 0.6, noiseColor: 0, gain: 0.18, lfoRate: 0.6, lfoDepth: 250 }],
  ["forest", { type: "lowpass", cutoff: 600, q: 0.7, noiseColor: 1, gain: 0.12, lfoRate: 0.1, lfoDepth: 100 }],
  ["cave", { type: "lowpass", cutoff: 300, q: 1.0, noiseColor: 1, gain: 0.13, lfoRate: 0.05, lfoDepth: 50 }],
  ["city", { type: "bandpass", cutoff: 1500, q: 0.5, noiseColor: 0, gain: 0.08, lfoRate: 1.2, lfoDepth: 400 }],
  ["space", { type: "lowpass", cutoff: 250, q: 0.3, noiseColor: 2, gain: 0.15, lfoRate: 0.04, lfoDepth: 40 }],
  ["desert", { type: "highpass", cutoff: 400, q: 0.4, noiseColor: 1, gain: 0.08, lfoRate: 0.2, lfoDepth: 80 }],
  ["night", { type: "lowpass", cutoff: 350, q: 0.6, noiseColor: 1, gain: 0.1, lfoRate: 0.08, lfoDepth: 60 }],
  ["snow", { type: "highpass", cutoff: 1200, q: 0.5, noiseColor: 0, gain: 0.07, lfoRate: 0.3, lfoDepth: 200 }],
];

export const DEFAULT_PATCH: Patch = {
  type: "lowpass",
  cutoff: 700,
  q: 0.6,
  noiseColor: 1,
  gain: 0.1,
  lfoRate: 0.2,
  lfoDepth: 120,
};

export function patchFor(prompt: string): Patch {
  const p = prompt.toLowerCase();
  let best: { key: string; patch: Patch; idx: number } | null = null;
  for (const [key, patch] of PATCHES) {
    const idx = p.indexOf(key);
    if (idx < 0) continue;
    if (!best || key.length > best.key.length) {
      best = { key, patch, idx };
    }
  }
  return best ? best.patch : DEFAULT_PATCH;
}