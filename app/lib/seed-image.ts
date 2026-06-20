// Procedural seed image generator.
//
// Lingbot requires BOTH a prompt and a reference image before generation
// can begin. The image is an *anchor frame*: its colours and gradients bias
// the first chunk of generation.
//
// The user's hard requirement: every prompt must produce a scene driven by
// the prompt text alone, not by a remembered image. So we cannot keep the
// same anchor between phrases — we must reset + swap image every time.
//
// To make the anchor itself as *invisible* as possible (so it doesn't read
// as "a template" the user can see), we generate:
//
//   - A near-flat coloured noise field.
//   - A barely-perceptible vertical hue shift (≈5 % lightness, low
//     saturation). The model needs *some* structure to interpolate from;
//     a perfectly flat image produces garbage.
//   - NO radial accent (sun), NO horizon line, NO vignette. Those are the
//     visual cues that made earlier versions read as "stock template".
//
// Output: a 1024×576 PNG that the model uses as a degenerate anchor.
// Visually it's a soft wash of one hue; semantically it's a clean slate
// for the prompt text to paint the actual scene.
//
// Hash inputs: `prompt text + session nonce`. Same prompt twice in a row
// yields different images. Same prompt across two sessions yields
// different images. This is what the user asked for ("generated from
// scratch, no template").

export interface SeedPalette {
  /** Top-of-frame colour. */
  top: string;
  /** Bottom-of-frame colour (close to top — kept near-flat). */
  bottom: string;
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

/** Pick a near-monochrome palette deterministically from a string. */
export function paletteFromString(s: string): SeedPalette {
  const h = hash32(s || String(Math.random()));
  // Single base hue, shifted ±15° between top and bottom (very subtle).
  const base = h % 360;
  return {
    top: hsl(base, 30, 50),
    bottom: hsl((base + 15 + (h >> 8) % 15) % 360, 30, 45),
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
 * Generate a procedural seed image as a Blob (PNG).
 *
 * The output is a soft wash of one hue — a degenerate anchor frame that
 * doesn't bias the model toward any specific scene composition. The
 * prompt text alone drives the actual scene.
 *
 * Returns `null` when no canvas is available in the current
 * environment (some privacy-mode browsers, SSR, very old WebViews).
 * The caller treats null as "no anchor image — try prompt-only".
 */
export async function generateSeedImage(opts: SeedImageOptions = {}): Promise<Blob | null> {
  const width = opts.width ?? W;
  const height = opts.height ?? H;
  const seed = opts.seed ?? Math.floor(Math.random() * 0xffffffff);
  const palette = paletteFromString(String(seed));

  if (typeof document === "undefined") return null;

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
    // eslint-disable-next-line no-console
    console.warn("[dream] Canvas 2D context unavailable — proceeding without anchor image");
    return null;
  }

  // 1. Near-flat vertical gradient — top→bottom within ~5 % lightness,
  //    same hue family. Gives the model *some* non-uniform input without
  //    biasing toward sky/ground composition.
  const grad = ctx.createLinearGradient(0, 0, 0, height);
  grad.addColorStop(0, palette.top);
  grad.addColorStop(1, palette.bottom);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);

  // 2. Low-frequency coloured noise to break banding and give the model
  //    a few random texture cues. Slightly more aggressive than before —
  //    we *want* it to look like "model-generated noise" rather than
  //    "stock gradient".
  const rng = mulberry32(seed);
  drawNoise(ctx, width, height, rng, 0.12);

  // That's it. No sun, no horizon, no vignette. The prompt paints the
  // scene from here.

  if (canvas instanceof OffscreenCanvas) {
    try {
      return await canvas.convertToBlob({ type: "image/png" });
    } catch {
      return null;
    }
  }
  return new Promise<Blob | null>((resolve) => {
    canvas.toBlob((b) => resolve(b), "image/png");
  });
}

function drawNoise(
  ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D,
  w: number,
  h: number,
  rng: () => number,
  opacity: number
) {
  // Read the current pixels (the gradient drawn just before us), add
  // per-channel noise, write back. The earlier version did this on a
  // freshly-zeroed buffer and then putImageData replaced the gradient
  // with monochrome noise — audit bug #9.
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rng() - 0.5) * 255 * opacity;
    d[i] = clamp255(d[i] + n);
    d[i + 1] = clamp255(d[i + 1] + n);
    d[i + 2] = clamp255(d[i + 2] + n);
    // Alpha is already 255 from the gradient; leave it alone.
  }
  ctx.putImageData(img, 0, 0);
}

function clamp255(v: number) {
  return v < 0 ? 0 : v > 255 ? 255 : v;
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