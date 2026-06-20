// Procedural seed image generator.
//
// Lingbot requires BOTH a prompt and a reference image before generation can
// begin. Earlier we curated five JPGs and routed keywords to them. That kept
// the visual identity stable but made the app feel like a chooser, not a
// dream-painter.
//
// The replacement: every "Begin" generates a unique procedural seed image
// from a string (typically a hash of the user's first transcript, or just
// Math.random() if they haven't spoken yet). Same prompt, different seed
// image → visibly different world. Different prompt, same seed image →
// completely different world. The image is purely a tonal/colour anchor for
// the model; the *real* scene description lives in the text prompt.
//
// We use OffscreenCanvas when available, falling back to a regular canvas.
// The output is a 1024x576 PNG (16:9) that the model can ingest as a
// reference frame.

export interface SeedPalette {
  /** Top-of-frame colour (sky / upper). */
  top: string;
  /** Bottom-of-frame colour (ground / lower). */
  bottom: string;
  /** Accent (single radial highlight, e.g. sun / moon). */
  accent: string;
}

/** Hash a string into a 32-bit unsigned integer. */
export function hash32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Pick a palette deterministically from a string. */
export function paletteFromString(s: string): SeedPalette {
  const h = hash32(s || String(Math.random()));
  // 4 hue stops across 360°, offset by the hash.
  const h1 = h % 360;
  const h2 = (h1 + 40 + (h >> 8) % 60) % 360;
  const h3 = (h1 + 200) % 360;
  return {
    top: hsl(h1, 55, 60),
    bottom: hsl(h2, 50, 25),
    accent: hsl(h3, 70, 70),
  };
}

function hsl(h: number, s: number, l: number): string {
  return `hsl(${h.toFixed(0)} ${s}% ${l}%)`;
}

export interface SeedImageOptions {
  /** Width in pixels. */
  width?: number;
  /** Height in pixels. */
  height?: number;
  /** Seed for deterministic noise. */
  seed?: number;
}

const W = 1024;
const H = 576;

/**
 * Generate a procedural seed image as a Blob (PNG). Returns a Blob that can
 * be uploaded via the Reactor `uploadFile(blob)` API.
 *
 * The image is a vertical gradient (top→bottom) with a soft radial accent
 * (sun/moon) and a layer of low-frequency noise to break banding.
 */
export async function generateSeedImage(opts: SeedImageOptions = {}): Promise<Blob> {
  const width = opts.width ?? W;
  const height = opts.height ?? H;
  const seed = opts.seed ?? Math.floor(Math.random() * 0xffffffff);
  const palette = paletteFromString(String(seed));

  // Use OffscreenCanvas in workers/SSR, regular canvas everywhere else.
  const canvas: OffscreenCanvas | HTMLCanvasElement =
    typeof OffscreenCanvas !== "undefined"
      ? new OffscreenCanvas(width, height)
      : Object.assign(document.createElement("canvas"), { width, height });

  const ctx = (canvas as any).getContext("2d") as
    | OffscreenCanvasRenderingContext2D
    | CanvasRenderingContext2D
    | null;
  if (!ctx) {
    throw new Error("Canvas 2D context unavailable in this browser");
  }

  // 1. Vertical gradient.
  const grad = ctx.createLinearGradient(0, 0, 0, height);
  grad.addColorStop(0, palette.top);
  grad.addColorStop(0.6, mix(palette.top, palette.bottom, 0.55));
  grad.addColorStop(1, palette.bottom);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);

  // 2. Soft radial accent (sun/moon) positioned by seed.
  const rng = mulberry32(seed);
  const ax = width * (0.25 + rng() * 0.5);
  const ay = height * (0.15 + rng() * 0.35);
  const ar = Math.min(width, height) * (0.18 + rng() * 0.15);
  const radial = ctx.createRadialGradient(ax, ay, 0, ax, ay, ar);
  radial.addColorStop(0, withAlpha(palette.accent, 0.85));
  radial.addColorStop(0.5, withAlpha(palette.accent, 0.25));
  radial.addColorStop(1, withAlpha(palette.accent, 0));
  ctx.fillStyle = radial;
  ctx.fillRect(0, 0, width, height);

  // 3. Low-frequency noise to break banding and add texture.
  drawNoise(ctx, width, height, rng, 0.06);

  // 4. Subtle horizon line to give the model a sense of "ground".
  ctx.fillStyle = withAlpha("#000", 0.18);
  ctx.fillRect(0, height * 0.62, width, 1);
  ctx.fillStyle = withAlpha("#000", 0.1);
  ctx.fillRect(0, height * 0.66, width, 1);

  // 5. Vignette.
  const vg = ctx.createRadialGradient(
    width / 2,
    height / 2,
    Math.min(width, height) * 0.3,
    width / 2,
    height / 2,
    Math.max(width, height) * 0.7
  );
  vg.addColorStop(0, withAlpha("#000", 0));
  vg.addColorStop(1, withAlpha("#000", 0.35));
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, width, height);

  if (canvas instanceof OffscreenCanvas) {
    return canvas.convertToBlob({ type: "image/png" });
  }
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png");
  });
}

function drawNoise(
  ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D,
  w: number,
  h: number,
  rng: () => number,
  opacity: number
) {
  const img = ctx.createImageData(w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rng() - 0.5) * 255 * opacity;
    d[i] = clamp255(d[i] + n);
    d[i + 1] = clamp255(d[i + 1] + n);
    d[i + 2] = clamp255(d[i + 2] + n);
    d[i + 3] = 255;
  }
  // ImageData path requires putting the data back. For OffscreenCanvas the
  // putImageData is the same API.
  ctx.putImageData(img, 0, 0);
}

function clamp255(v: number) {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

function mix(a: string, b: string, t: number) {
  const pa = parseHsl(a);
  const pb = parseHsl(b);
  const h = pa.h + (pb.h - pa.h) * t;
  const s = pa.s + (pb.s - pa.s) * t;
  const l = pa.l + (pb.l - pa.l) * t;
  return hsl(h, s, l);
}

function parseHsl(s: string): { h: number; s: number; l: number } {
  const m = /hsl\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*\)/.exec(s);
  if (!m) return { h: 0, s: 0, l: 0 };
  return { h: parseFloat(m[1]), s: parseFloat(m[2]), l: parseFloat(m[3]) };
}

function withAlpha(hsl: string, alpha: number) {
  const { h, s, l } = parseHsl(hsl);
  return `hsla(${h.toFixed(0)} ${s}% ${l}% / ${alpha})`;
}

/** Small, fast, seedable PRNG. */
function mulberry32(a: number) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}