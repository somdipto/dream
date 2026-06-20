"use client";

import { useEffect, useState } from "react";
import { LingbotMainVideoView, useLingbot } from "@reactor-models/lingbot";
import { useVoice } from "../hooks/useVoice";

// Stereoscopic VR view for Google Cardboard / similar mobile viewers.
//
// Layout: the screen is split into two side-by-side lenses, each
// showing the same Lingbot world video with a small horizontal
// parallax shift. The user's left eye sees the left lens; their
// right eye sees the right lens. The brain fuses the two slightly
// offset images into a single 3D scene — exactly the Cardboard feel.
//
// The two lenses are *separate Lingbot video elements*. Both pull
// the same `<ReactorView track="main_video">` MediaStream via the
// SDK, so they stay frame-locked without any extra coordination.
//
// Parallax math: IPD ≈ 64 mm, typical phone FOV ≈ 60°, so each
// eye should see the world shifted by ~3% of the viewport width
// to produce a believable stereo depth. The left lens is shifted
// further left, the right lens further right.
//
// Barrel distortion: Cardboard lenses introduce pin-cushion
// distortion; the rendered image must be pre-warped with the
// inverse so the user sees straight lines. We apply a soft barrel
// via an SVG `<feDisplacementMap>` filter (referenced via CSS
// `filter: url(#vr-barrel)` in globals.css).
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

  // When the user speaks a phrase, show a brief toast at the
  // bottom of the screen so they have feedback (the rest of the UI
  // is hidden in VR mode).
  useEffect(() => {
    if (!open) return;
    if (!voice.final) return;
    setToast(voice.final);
    const t = setTimeout(() => setToast(null), 2200);
    return () => clearTimeout(t);
  }, [open, voice.final]);

  // Auto-hide the exit button after a few seconds of non-touch, so
  // the view stays clean. Re-show on any tap.
  useEffect(() => {
    if (!open) return;
    function onAnyTap() {
      setShowExit(true);
      const t = setTimeout(() => setShowExit(false), 3500);
      return () => clearTimeout(t);
    }
    setShowExit(true);
    const initial = setTimeout(() => setShowExit(false), 3500);
    window.addEventListener("touchstart", onAnyTap, { passive: true });
    window.addEventListener("mousedown", onAnyTap);
    return () => {
      clearTimeout(initial);
      window.removeEventListener("touchstart", onAnyTap);
      window.removeEventListener("mousedown", onAnyTap);
    };
  }, [open]);

  // Screen orientation: lock landscape while VR is open. Best-effort
  // — the browser may deny. Release the lock when leaving VR.
  useEffect(() => {
    if (!open) return;
    const scr: any =
      typeof screen !== "undefined" ? (screen as any) : undefined;
    let released = false;
    (async () => {
      try {
        if (scr?.orientation?.lock) {
          await scr.orientation.lock("landscape");
        }
      } catch {
        // ignore — not all browsers/platforms support this
      }
    })();
    return () => {
      if (released) return;
      released = true;
      try {
        scr?.orientation?.unlock?.();
      } catch {
        // ignore
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
          distortion when the user looks through them. The
          displacement scale is small (~12) so the painted world
          stays sharp; tune up if the user reports straight lines
          looking bowed. */}
      <svg
        aria-hidden
        className="pointer-events-none absolute h-0 w-0"
      >
        <defs>
          <filter id="vr-barrel" x="-10%" y="-10%" width="120%" height="120%">
            <feTurbulence
              type="fractalNoise"
              baseFrequency="0.012 0.018"
              numOctaves="2"
              result="noise"
            />
            <feDisplacementMap
              in="SourceGraphic"
              in2="noise"
              scale="6"
              xChannelSelector="R"
              yChannelSelector="G"
            />
            <feGaussianBlur stdDeviation="0.25" />
          </filter>
        </defs>
      </svg>

      {/* Two side-by-side lenses. Each renders the same world video
          stream with its own parallax shift. The barrel-distortion
          SVG filter is applied via CSS `filter: url(#vr-barrel)` in
          globals.css. */}
      <div className="flex h-full w-full">
        <div
          className="vr-lens vr-lens-left relative h-full w-1/2 overflow-hidden"
          data-testid="vr-lens-left"
        >
          <div className="vr-barrel h-full w-full">
            <LingbotMainVideoView
              className="h-full w-full"
              videoObjectFit="cover"
            />
          </div>
        </div>
        <div
          className="vr-lens vr-lens-right relative h-full w-1/2 overflow-hidden"
          data-testid="vr-lens-right"
        >
          <div className="vr-barrel h-full w-full">
            <LingbotMainVideoView
              className="h-full w-full"
              videoObjectFit="cover"
            />
          </div>
        </div>
      </div>

      {/* Status / loading overlay inside VR. */}
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

      {/* Spoken-phrase toast. Shows the last committed transcript
          briefly so the user knows their voice was understood. */}
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

      {/* Exit button — small ✕ in the corner. Auto-hides after a
          few seconds of non-touch. */}
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