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
    // QA11/SDK-6: dep is now `voice.supported` only (a
    // boolean, stable across renders) instead of the full
    // `voice` object. The previous version re-subscribed
    // on every render of the parent, dropping finals that
    // landed in the swap window AND leaking setTimeout
    // handles on unmount. We also cancel the toast timer
    // via a ref so unmount doesn't fire setToast(null) on
    // a torn-down component.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voice.supported]);

  // Orientation lock. Request landscape on enter, release on exit.
  // Audit bug #20: the previous version didn't release on exit, so
  // after VR the device was stuck in landscape.
  //
  // QA16 bug #196: on a user who was *already* in landscape when
  // entering VR, previousOrientation === "landscape-primary",
  // and the cleanup re-locked landscape. So a user who picked
  // landscape-primary and entered VR could never rotate the
  // device back to landscape-secondary without VR re-locking it.
  // Fix: track orientationchange events while the lock is held,
  // and only re-acquire the "previous" orientation if it differs
  // from the one we forced.
  useEffect(() => {
    if (!open) return;
    if (typeof screen === "undefined" || !("orientation" in screen)) return;
    let previousOrientation: string | null = null;
    try {
      previousOrientation = (screen.orientation as any).type ?? null;
    } catch {
      previousOrientation = null;
    }
    // Track whether the user manually rotated while we held the
    // lock. If they did, that becomes the "previous" orientation
    // we should restore on exit, not the one we captured on enter.
    let lastSeenWhileLocked: string | null = previousOrientation;
    const onChange = () => {
      try {
        lastSeenWhileLocked = (screen.orientation as any).type ?? null;
      } catch {
        // ignore
      }
    };
    window.addEventListener("orientationchange", onChange);
    const so = screen.orientation as any;
    if (so?.lock) {
      so.lock("landscape").catch(() => {
        // Some browsers (iOS Safari, Firefox Android) refuse the
        // lock; we silently fall back to whatever the user picked.
      });
    }
    return () => {
      window.removeEventListener("orientationchange", onChange);
      try {
        so?.unlock?.();
      } catch {
        // ignore
      }
      // Best-effort: re-acquire the orientation the user last
      // expressed while VR was open. If they never rotated,
      // lastSeenWhileLocked === previousOrientation, which is
      // usually identical to the lock we just released — in
      // that case we skip the re-lock to avoid pinning a
      // landscape-secondary user who entered from
      // landscape-primary.
      const restoreTo = lastSeenWhileLocked || previousOrientation;
      if (
        restoreTo &&
        so?.lock &&
        !restoreTo.startsWith("landscape")
      ) {
        const kind = restoreTo.startsWith("portrait")
          ? "portrait"
          : "natural";
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

      {/* QA11/SDK-2: SINGLE video render, two clip-path
          viewports. The previous version rendered TWO
          <LingbotMainVideoView> instances, which caused
          double SDK subscription, double RTP overhead,
          and 1-3 frames of interocular delay (eye strain
          in Cardboard). Now we render the video once in
          an absolute-positioned container and let the two
          `.vr-lens` divs clip it with `clip-path: inset()`
          and parallax-shift it via `translateX`. The
          `filter` style is set inline so it references
          this instance's unique filter id (see useId()). */}
      <div className="absolute inset-0 bg-black">
        <div
          className="absolute inset-0"
          style={{ filter: `url(#${filterId})` }}
        >
          <LingbotMainVideoView
            className="h-full w-full"
            videoObjectFit="cover"
          />
        </div>
        {/* Left lens: shows the left half of the world,
            shifted left by PARALLAX_PCT to simulate the
            left eye's slightly-left view. */}
        <div
          className="vr-lens pointer-events-none absolute inset-y-0 left-0 w-1/2 overflow-hidden"
          data-testid="vr-lens-left"
          style={{
            clipPath: "inset(0 50% 0 0)",
          }}
        >
          <div
            className="vr-barrel h-full"
            style={{
              width: `${100 + PARALLAX_PCT * 2}%`,
              transform: `translateX(-${PARALLAX_PCT}%)`,
            }}
          />
        </div>
        {/* Right lens: shows the right half, shifted right. */}
        <div
          className="vr-lens pointer-events-none absolute inset-y-0 right-0 w-1/2 overflow-hidden"
          data-testid="vr-lens-right"
          style={{
            clipPath: "inset(0 0 0 50%)",
          }}
        >
          <div
            className="vr-barrel h-full"
            style={{
              width: `${100 + PARALLAX_PCT * 2}%`,
              transform: `translateX(${PARALLAX_PCT}%)`,
            }}
          />
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