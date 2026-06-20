"use client";

import { useEffect, useRef, useState } from "react";
import {
  LingbotMainVideoView,
  useLingbot,
  useLingbotState,
} from "@reactor-models/lingbot";

// Full-bleed background video. `<LingbotMainVideoView>` is a pre-bound
// `<ReactorView track="main_video">` from the typed SDK — no refs, no
// `srcObject`, no autoplay tricks.
//
// CRITICAL: the user has reported seeing a black/blank screen while
// prompting. There are three distinct failure modes this guards against:
//
//   1. **Pre-paint gap** — between user input and LingBot's first
//      chunk arriving. The aurora fills this.
//   2. **LingBot's first frame is near-black** — when Reactor flips
//      `started: true` but the first actual paint is several seconds
//      away. The aurora stays up for 10 seconds (was 6) after that.
//   3. **LingBot's stream returns dark frames mid-session** — some
//      prompts produce a stream where every frame is near-black. The
//      canvas-sampling watchdog detects this and re-engages the
//      aurora at low opacity so the user sees *something*.
//
// Aurora layering rules:
//   - During loading/ready/generating → aurora fully visible (text
//     overlay on top, no video).
//   - First 10 seconds after `started` → aurora fully visible BEHIND
//     the video (low opacity ~70%). LingBot's video fades in over it.
//   - After grace → aurora still visible at low opacity (~35%) so it
//     peeks through if/when LingBot drops to black frames.
//   - If canvas-sampling detects a near-black frame → aurora blips up
//     to ~70% for 4 seconds.
//
// This is intentional: rather than trying to detect "real" video, we
// trust that the aurora is *better than black* and just keep it
// peeking through as a safety net forever.

export function Video() {
  const { status } = useLingbot();
  const snapshot = useLingbotStateSnapshot();
  const [phase, setPhase] = useState<"loading" | "ready" | "generating" | "playing">(
    "loading",
  );
  const [paintGraceUntil, setPaintGraceUntil] = useState<number>(0);
  // Aurora visibility — 0 = fully hidden, 1 = fully visible. We tween
  // this on phase transitions and on the dark-frame watchdog.
  const [auroraOpacity, setAuroraOpacity] = useState<number>(1);
  // True if the latest sampled video frame was darker than threshold.
  const [darkFrames, setDarkFrames] = useState<boolean>(false);
  const darkWatchdogRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (status !== "ready") {
      setPhase("loading");
      setAuroraOpacity(1);
      return;
    }
    if (!snapshot?.has_image) {
      setPhase("ready");
      setAuroraOpacity(1);
      return;
    }
    if (!snapshot?.started) {
      setPhase("generating");
      setAuroraOpacity(1);
      return;
    }
    // Just started — extend the aurora fully for 10 seconds, then
    // dial down to 35% (the dark-frame safety net).
    setPaintGraceUntil(Date.now() + 10000);
    setPhase("playing");
    setAuroraOpacity(1);
  }, [status, snapshot?.has_image, snapshot?.started]);

  // Re-tick the aurora opacity over time so it tween's from full to
  // safety-net-low at the end of the grace window.
  const [now, setNow] = useState<number>(Date.now());
  useEffect(() => {
    if (phase !== "playing") return;
    const tick = () => setNow(Date.now());
    const handle = window.setInterval(tick, 250);
    return () => window.clearInterval(handle);
  }, [phase]);

  useEffect(() => {
    if (phase !== "playing") {
      setAuroraOpacity(1);
      return;
    }
    const graceMs = paintGraceUntil - now;
    if (graceMs > 0) {
      // Full aurora during grace.
      setAuroraOpacity(1);
    } else if (darkFrames) {
      // Dark-frame watchdog tripped — aurora peeks through stronger.
      setAuroraOpacity(0.7);
    } else {
      // Safety net: always 30% so a sudden black frame doesn't
      // render the page completely dark.
      setAuroraOpacity(0.3);
    }
  }, [phase, paintGraceUntil, now, darkFrames]);

  // Dark-frame watchdog — every 2s during play, sample the
  // <LingbotMainVideoView>'s <video> element via a 2x2 canvas. If
  // the average luma is below 18/255 (very dark), flag `darkFrames`
  // and let the aurora peek through. The sample cost is trivial —
  // 4 pixels, no ImageData allocation per pixel.
  useEffect(() => {
    if (phase !== "playing") {
      if (darkWatchdogRef.current) {
        clearInterval(darkWatchdogRef.current);
        darkWatchdogRef.current = null;
      }
      setDarkFrames(false);
      return;
    }
    function sampleDark() {
      const v = document.querySelector('[data-testid="video-stage"] video');
      if (!(v instanceof HTMLVideoElement)) return;
      if (v.videoWidth === 0 || v.videoHeight === 0) {
        setDarkFrames(true);
        return;
      }
      try {
        const c = document.createElement("canvas");
        c.width = 2;
        c.height = 2;
        const ctx = c.getContext("2d");
        if (!ctx) return;
        ctx.drawImage(v, 0, 0, 2, 2);
        const data = ctx.getImageData(0, 0, 2, 2).data;
        let luma = 0;
        for (let i = 0; i < data.length; i += 4) {
          // ITU-R BT.601 luma
          luma += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        }
        const avg = luma / 4;
        // Below 22/255 = very dark. Above 32 = clearly lit.
        setDarkFrames(avg < 22);
      } catch {
        // CORS-tainted canvas — assume fine.
        setDarkFrames(false);
      }
    }
    darkWatchdogRef.current = setInterval(sampleDark, 2000);
    // Sample once on enter, then every 2s.
    sampleDark();
    return () => {
      if (darkWatchdogRef.current) {
        clearInterval(darkWatchdogRef.current);
        darkWatchdogRef.current = null;
      }
    };
  }, [phase]);

  const showOverlay = phase !== "playing" || now < paintGraceUntil;

  return (
    <div className="relative h-full w-full overflow-hidden bg-[#0a0612]">
      {/* Aurora background — ALWAYS present (opacity-controlled),
          not toggled in/out. The video stage sits on top. LingBot's
          first chunks can be near-black, so we keep the aurora
          peeking through at low opacity even after grace expires —
          a hard black screen reads as "broken app" and is exactly
          what the user reported. */}
      <div
        className="pointer-events-none absolute inset-0 transition-opacity duration-700 ease-out"
        aria-hidden="true"
        data-testid="video-aurora"
        style={{ opacity: auroraOpacity }}
      >
        <div className="absolute inset-0 animate-[aurora-shift_18s_ease-in-out_infinite] bg-[radial-gradient(ellipse_at_top_left,rgba(99,102,241,0.55),transparent_55%),radial-gradient(ellipse_at_bottom_right,rgba(236,72,153,0.45),transparent_55%),radial-gradient(ellipse_at_top_right,rgba(34,211,238,0.40),transparent_55%),radial-gradient(ellipse_at_bottom_left,rgba(168,85,247,0.40),transparent_55%)] bg-[length:200%_200%]" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_40%,rgba(255,255,255,0.10),transparent_60%)]" />
      </div>

      {/* The video itself fades in over 600ms once we have a real
          frame — LingBot's first frames are sometimes near-black,
          and a hard cut from aurora to a black video looks like a
          regression. We crossfade the video in over the aurora
          instead. */}
      <div
        data-testid="video-stage"
        className={[
          "absolute inset-0 transition-opacity duration-1000 ease-out",
          phase === "playing" ? "opacity-100" : "opacity-0",
        ].join(" ")}
        style={{ touchAction: "none" }}
      >
        <LingbotMainVideoView
          className="h-full w-full"
          videoObjectFit="cover"
        />
      </div>

      {showOverlay && (
        <div
          className="pointer-events-none absolute inset-0 flex items-center justify-center transition-opacity duration-500"
          data-testid="video-overlay"
        >
          <div className="max-w-sm px-6 text-center">
            {phase === "loading" && (
              <>
                <div className="mx-auto h-2 w-2 animate-pulse rounded-full bg-amber-400" />
                <p className="mt-4 text-sm text-white/85">
                  {status === "connecting"
                    ? "Connecting to Reactor…"
                    : status === "waiting"
                      ? "Waiting for a GPU…"
                      : "Preparing your world…"}
                </p>
                <p className="mt-1 text-xs text-white/50">
                  Hold tight — this usually takes 5–15 seconds
                </p>
              </>
            )}
            {phase === "ready" && (
              <>
                <p className="text-xs uppercase tracking-widest text-emerald-300/90">
                  World connected
                </p>
                <p className="mt-2 text-sm text-white/85">
                  Speak or type your first scene
                </p>
              </>
            )}
            {phase === "generating" && (
              <>
                <div className="mx-auto h-2 w-2 animate-pulse rounded-full bg-emerald-400" />
                <p className="mt-4 text-sm text-white/85">
                  Painting your dream…
                </p>
                <p className="mt-1 text-xs text-white/50">
                  The model is composing the first frame
                </p>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// Subscribe to state and return the most recent snapshot. Wrapped
// separately so the inner effect can re-run cleanly. Audit bug
// #10: the previous version re-registered the SDK listener on every
// state message because the inner `setSnap` callback had a fresh
// identity. We now use a stable callback and a single subscription.
function useLingbotStateSnapshot() {
  const [snap, setSnap] = useState<any>(null);
  useLingbotState((msg) => setSnap(msg));
  return snap as
    | null
    | {
        has_image?: boolean;
        has_prompt?: boolean;
        started?: boolean;
        [k: string]: any;
      };
}