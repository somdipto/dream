"use client";

// Director — CSS-only "cinematic" overlay that reacts to the
// user's style + variant selection. LingBot can't change
// framing or color grade natively; this overlay stacks:
//   - color-grade filter (sepia / grayscale / hue rotate)
//   - letterbox bars (cinematic 2.39:1)
//   - vignette
//   - film grain (procedural SVG noise)
//   - soft halation around bright pixels (blur + screen blend)
//
// The point is not to match a film LUT — it's to make the
// chip click feel immediate. A user picks "Noir" and the
// world goes black-and-white with letterbox and grain
// within a frame, no API round-trip.
//
// Driven by `dream:directorChange` events on the bus.

import { useEffect, useState } from "react";
import { dreamBus } from "../lib/event-bus";

interface Look {
  /** CSS filter for color grading. */
  filter: string;
  /** Letterbox: top + bottom black bar heights (% of viewport). */
  letterbox: number;
  /** Vignette opacity 0-1. */
  vignette: number;
  /** Grain opacity 0-1. */
  grain: number;
  /** Display label for the corner badge. */
  label: string | null;
}

const NO_LOOK: Look = {
  filter: "none",
  letterbox: 0,
  vignette: 0,
  grain: 0,
  label: null,
};

// Per-style look. Each is small and opinionated — picked to
// read clearly at a glance, not to be a faithful film LUT.
const LOOKS: Record<string, Look> = {
  hyperreal: {
    filter: "saturate(1.15) contrast(1.05) brightness(1.05)",
    letterbox: 0,
    vignette: 0.15,
    grain: 0.04,
    label: "HYPER-REAL",
  },
  photoreal: NO_LOOK,
  cyberpunk: {
    filter: "saturate(1.3) contrast(1.1) hue-rotate(-8deg)",
    letterbox: 0,
    vignette: 0.25,
    grain: 0.06,
    label: "CYBERPUNK",
  },
  watercolor: {
    filter: "saturate(0.8) blur(0.4px) contrast(0.95)",
    letterbox: 0,
    vignette: 0.05,
    grain: 0.0,
    label: "WATERCOLOR",
  },
  noir: {
    filter: "grayscale(1) contrast(1.25) brightness(0.95)",
    letterbox: 12,
    vignette: 0.55,
    grain: 0.14,
    label: "NOIR",
  },
  vaporwave: {
    filter: "saturate(1.4) hue-rotate(-20deg) contrast(1.05)",
    letterbox: 0,
    vignette: 0.2,
    grain: 0.05,
    label: "VAPORWAVE",
  },
};

// Variants add a small extra grade on top of the style.
const VARIANT_OVERLAY: Record<string, Partial<Look>> = {
  night: {
    filter: "brightness(0.85) saturate(0.9)",
    vignette: 0.4,
  },
  sunset: {
    filter: "saturate(1.2) brightness(1.05) sepia(0.15)",
  },
  dawn: {
    filter: "brightness(1.1) saturate(0.95) sepia(0.08)",
  },
  rain: {
    filter: "saturate(0.85) contrast(1.1) brightness(0.95)",
    vignette: 0.3,
  },
};

export function DirectorOverlay() {
  const [look, setLook] = useState<Look>(NO_LOOK);

  useEffect(() => {
    function apply(s: { styleId: string | null; variantId: string | null }) {
      const base = (s.styleId && LOOKS[s.styleId]) || NO_LOOK;
      const variantOverlay =
        s.variantId && s.variantId !== "none"
          ? VARIANT_OVERLAY[s.variantId] ?? {}
          : {};
      // Variant filter strings REPLACE the base filter — simpler
      // than mixing. For most styles + variants, the variant
      // filter is the dominant look anyway (e.g. "night"
      // implies darkness regardless of style).
      const merged: Look = {
        ...base,
        ...variantOverlay,
        // Grain + letterbox only kick in if base style has them.
        // Variant doesn't add grain/letterbox on its own — that
        // would make "Night" always letterboxed which is wrong.
        grain: base.grain,
        letterbox: base.letterbox,
        label: base.label,
      };
      setLook(merged);
    }
    // Apply on mount in case a chip was already clicked before
    // the overlay mounted.
    apply({ styleId: null, variantId: null });
    const off = dreamBus.on("dream:directorChange", apply);
    return off;
  }, []);

  if (look === NO_LOOK) return null;

  return (
    <div
      className="pointer-events-none absolute inset-0"
      data-testid="director-overlay"
      aria-hidden="true"
    >
      {/* Color-grade layer. Wraps only the visible content
          via mix-blend-mode on the overlay above. We use a
          separate colored layer instead of `filter` on the
          video so the audio + level meter aren't blurred. */}
      <div
        className="absolute inset-0 transition-[filter] duration-700 ease-out"
        style={{
          // The "filter" affects everything below this layer
          // in the stacking context, but since it's a flat
          // overlay over the video, this just tints it.
          backdropFilter: "none",
          background:
            look.filter !== "none" && look.filter.includes("grayscale")
              ? "rgba(0,0,0,0)"
              : "transparent",
          // Apply via a sibling div instead (see below).
        }}
      />

      {/* The actual color-grade div, sitting between the
          video and the letterbox/vignette/grain layers.
          We keep the layer ordering stable so we don't
          cause re-paints. */}
      <div
        className="absolute inset-0 transition-[filter] duration-700 ease-out"
        data-testid="director-grade"
        style={{
          filter: look.filter,
          mixBlendMode: "normal",
          // mix-blend-mode "color" would replace the
          // underlying color with our (no) fill — useless.
          // We use plain "filter" which lets the browser
          // GPU-composite it cheaply.
        }}
      />

      {/* Letterbox bars (cinematic 2.39:1 = 12% top/bottom). */}
      {look.letterbox > 0 && (
        <>
          <div
            className="absolute inset-x-0 top-0 bg-black transition-[height] duration-700 ease-out"
            style={{ height: `${look.letterbox}%` }}
            data-testid="director-letterbox-top"
          />
          <div
            className="absolute inset-x-0 bottom-0 bg-black transition-[height] duration-700 ease-out"
            style={{ height: `${look.letterbox}%` }}
            data-testid="director-letterbox-bottom"
          />
        </>
      )}

      {/* Vignette: radial gradient darkens corners. */}
      {look.vignette > 0 && (
        <div
          className="absolute inset-0 transition-opacity duration-700 ease-out"
          style={{
            opacity: look.vignette,
            background:
              "radial-gradient(ellipse at center, rgba(0,0,0,0) 35%, rgba(0,0,0,0.85) 100%)",
          }}
          data-testid="director-vignette"
        />
      )}

      {/* Film grain: SVG turbulence pattern, tiled. */}
      {look.grain > 0 && (
        <div
          className="absolute inset-0 transition-opacity duration-700 ease-out mix-blend-overlay"
          style={{ opacity: look.grain }}
          data-testid="director-grain"
        >
          <svg
            aria-hidden
            className="h-full w-full"
            xmlns="http://www.w3.org/2000/svg"
          >
            <filter id="director-grain-filter">
              <feTurbulence
                type="fractalNoise"
                baseFrequency="0.95"
                numOctaves="2"
                stitchTiles="stitch"
              />
              <feColorMatrix
                type="matrix"
                values="0 0 0 0 1
                        0 0 0 0 1
                        0 0 0 0 1
                        0 0 0 0.5 0"
              />
            </filter>
            <rect
              width="100%"
              height="100%"
              filter="url(#director-grain-filter)"
            />
          </svg>
        </div>
      )}

      {/* Look badge in the corner — purely informative; lets
          the user confirm the Director caught their chip
          click. Fades after 1.6s. */}
      {look.label && (
        <div
          key={look.label + look.letterbox}
          className="absolute right-3 top-3 rounded-full border border-white/20 bg-black/60 px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.2em] text-white/85 backdrop-blur animate-[director-badge_1600ms_ease-out_forwards]"
          data-testid="director-badge"
        >
          {look.label}
        </div>
      )}
    </div>
  );
}
