"use client";

import { useEffect, useId, useState } from "react";
import { LingbotMainVideoView, useLingbot } from "@reactor-models/lingbot";
import { useVoice } from "../hooks/useVoice";

// Stereoscopic VR view for Google Cardboard / similar mobile viewers.
//
// Layout: a single full-screen video is split into two side-by-side
// lenses by clipping each half with `clip-path: inset()`. The left
// lens sees a horizontally-shifted copy of the video; the right
// lens sees the opposite shift. The brain fuses them into a single
// 3D scene — the Cardboard feel.
//
// We use ONE `<LingbotMainVideoView>` (a single SDK subscription)
// instead of two — the SDK doesn't guarantee that two subscribers
// on the same track stay frame-locked, and double-subscribing
// doubles bitrate for no perceptual benefit. Audit bug #19 fixed.
//
// Parallax math: IPD ≈ 64 mm, typical phone FOV ≈ 60°, so each eye
// should see the world shifted by ~3% of the viewport width to
// produce a believable stereo depth. The left lens shifts left, the
// right lens shifts right.
//
// Barrel distortion: Cardboard lenses introduce pin-cushion
// distortion; the rendered image is pre-warped with a soft SVG
// displacement filter so the user sees straight lines through the
// lenses.
//
// Orientation lock: on enter, request landscape. Cardboard works
// best in landscape (the two lenses are side-by-side horizontally).
// On exit, release the lock.

const PARALLAX_PCT = 3; // ±3% per eye

export function VRView({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { status } = useLingbot();
  const voice = useVoice();
  const [showExit, setShowExit] = useState(true);
  const [toast, setToast] = useState<string | null>(null);
  // Unique id for the SVG <filter> this instance declares. With
  // React's `useId` the id is stable across renders and unique
  // across instances, so two VRView mounts in the DOM don't shadow
  // each other's barrel-distortion filter.
  const filterId = `vr-barrel-${useId()}`;

  useEffect(() => {
    if (!voice.supported) return;
    return voice.onFinal((text) => {
      const t = text.trim();
      if (!t) return;
      setToast(t);
      setTimeout(() => setToast(null), 2500);
    });
  }, [voice]);

  // Orientation lock. Request landscape on enter, release on exit.
  // Audit bug #20: the previous version didn't release on exit, so
  // after VR the device was stuck in landscape.
  useEffect(() => {
    if (!open) return;
    if (typeof screen === "undefined" || !("orientation" in screen)) return;
    let previousOrientation: string | null = null;
    try {
      previousOrientation = (screen.orientation as any).type ?? null;
    } catch {
      previousOrientation = null;
    }
    const so = screen.orientation as any;
    if (so?.lock) {
      so.lock("landscape").catch(() => {
        // Some browsers (iOS Safari, Firefox Android) refuse the
        // lock; we silently fall back to whatever the user picked.
      });
    }
    return () => {
      try {
        so?.unlock?.();
      } catch {
        // ignore
      }
      // Best-effort: re-acquire the user's previous orientation if
      // we can read it. Most browsers no-op on unlock, which is the
      // behaviour we want.
      if (previousOrientation && so?.lock) {
        const kind = previousOrientation.startsWith("portrait")
          ? "portrait"
          : "landscape";
        so.lock(kind).catch(() => {
          // ignore
        });
      }
    };
  }, [open]);

  // ESC also exits VR.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const ready = status === "ready";

  return (
    <div
      className="fixed inset-0 z-50 select-none bg-black"
      data-testid="vr-view"
      role="dialog"
      aria-label="VR mode"
    >
      {/* Inline SVG filter — barrel distortion pre-warp so the
          Cardboard lenses introduce the right amount of pin-cushion
          distortion when the user looks through them. The id is
          generated per-instance via useId() so two VRView mounts
          never collide on the global filter namespace. */}
      <svg aria-hidden className="pointer-events-none absolute h-0 w-0">
        <defs>
          <filter id={filterId} x="-10%" y="-10%" width="120%" height="120%">
            <feTurbulence
              type="fractalNoise"
              baseFrequency="0.012"
              numOctaves="2"
              seed="3"
              result="noise"
            />
            <feDisplacementMap
              in="SourceGraphic"
              in2="noise"
              scale="10"
              xChannelSelector="R"
              yChannelSelector="G"
            />
            <feGaussianBlur stdDeviation="0.25" />
          </filter>
        </defs>
      </svg>

      {/* Single video, two parallax-shifted clip-path viewports.
          No double subscription — one stream, two "windows" into
          it. The `filter` style is set inline so it references this
          instance's unique filter id (see useId() above). */}
      <div className="flex h-full w-full bg-black">
        <div
          className="vr-lens relative h-full w-1/2 overflow-hidden"
          data-testid="vr-lens-left"
        >
          <div
            className="vr-barrel absolute inset-0"
            style={{
              width: `${100 + PARALLAX_PCT * 2}%`,
              left: `-${PARALLAX_PCT}%`,
              filter: `url(#${filterId})`,
            }}
          >
            <LingbotMainVideoView
              className="h-full w-full"
              videoObjectFit="cover"
            />
          </div>
        </div>
        <div
          className="vr-lens relative h-full w-1/2 overflow-hidden"
          data-testid="vr-lens-right"
        >
          <div
            className="vr-barrel absolute inset-0"
            style={{
              width: `${100 + PARALLAX_PCT * 2}%`,
              left: `-${PARALLAX_PCT}%`,
              filter: `url(#${filterId})`,
            }}
          >
            <LingbotMainVideoView
              className="h-full w-full"
              videoObjectFit="cover"
            />
          </div>
        </div>
      </div>

      {!ready && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/80">
          <div className="max-w-sm px-6 text-center">
            <div className="mx-auto h-2 w-2 animate-pulse rounded-full bg-amber-400" />
            <p className="mt-4 text-sm text-white/80">
              {status === "connecting"
                ? "Connecting…"
                : status === "waiting"
                  ? "Waiting for a GPU…"
                  : status === "disconnected"
                    ? "Disconnected — tap ✕ to exit"
                    : "Preparing your world…"}
            </p>
          </div>
        </div>
      )}

      {toast && (
        <div className="pointer-events-none absolute inset-x-0 bottom-12 flex justify-center px-4">
          <p
            className="max-w-xs truncate rounded-full border border-white/10 bg-black/70 px-4 py-2 text-xs text-white/90 backdrop-blur"
            data-testid="vr-voice-toast"
          >
            🎙 {toast}
          </p>
        </div>
      )}

      <button
        onClick={onClose}
        aria-label="Exit VR mode"
        data-testid="vr-exit-btn"
        className={[
          "absolute right-4 top-4 grid h-10 w-10 place-items-center rounded-full border border-white/20 bg-black/60 text-lg text-white backdrop-blur transition-opacity duration-300",
          showExit ? "opacity-100" : "pointer-events-none opacity-0",
        ].join(" ")}
      >
        ✕
      </button>
    </div>
  );
}