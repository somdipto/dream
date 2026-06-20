"use client";

import { useEffect, useRef, useState } from "react";
import {
  LingbotMainVideoView,
  useLingbot,
  useLingbotState,
} from "@reactor-models/lingbot";
import { recordBlackScreen } from "../lib/black-screen-log";
import { setLastImageUrl } from "../lib/last-image";

// Full-bleed background video. `<LingbotMainVideoView>` is a pre-bound
// `<ReactorView track="main_video">` from the typed SDK — no refs, no
// `srcObject`, no autoplay tricks.
//
// CRITICAL: the user has reported seeing a black/blank screen while
// prompting. There are four distinct failure modes this guards against:
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
//   4. **The pre-video base color** — between Begin and the first
//      frame, the user sees the <Video> container's background. The
//      old base was #0a0612 (deep purple-black) which read as "the
//      app is broken" on screens where the aurora gradient was
//      washed out. M9.13 changes the base to a soft warm cream so
//      even if the video never paints, the user sees a friendly
//      surface — not a void.
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

  // QA2: replaced the 250ms re-tick with a one-shot setTimeout
  // scheduled for the moment the grace window ends. The old
  // code called setState every 250ms while playing, re-rendering
  // the entire Video subtree 4×/sec for the lifetime of the
  // connection. With the new code, aurora opacity is computed
  // from the snapshot state and only re-renders when the
  // grace window actually ends OR when darkFrames / phase flips.
  const [now, setNow] = useState<number>(Date.now());
  useEffect(() => {
    if (phase !== "playing") return;
    const remaining = paintGraceUntil - Date.now();
    if (remaining <= 0) {
      // Already past grace — flip once and done.
      setNow(Date.now());
      return;
    }
    const handle = window.setTimeout(() => setNow(Date.now()), remaining + 50);
    return () => window.clearTimeout(handle);
  }, [phase, paintGraceUntil]);

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
      setAuroraOpacity(0.75);
    } else {
      // M9.13: bumped the safety net from 30% → 45%. The user
      // reported "blank dark black screen" — even a brief drop to
      // dark video frames reads as broken. 45% is bright enough
      // to clearly tint the screen without dominating the video.
      setAuroraOpacity(0.45);
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
    // Throttle log writes so a long-lived dark stream doesn't
    // flood the log with one event per second. One event per
    // dark episode is enough.
    const darkSinceRef = { current: 0 };
    // QA5: cache the tainted-canvas state. Without this,
    // every 2-second tick tries drawImage + getImageData on
    // the cross-origin Lingbot video, throws SecurityError,
    // and we silently `setDarkFrames(false)` — meaning a
    // genuinely dark scene is never detected. After the
    // first failed draw we skip the per-tick work and
    // respect the previous dark-frame state.
    let canvasTainted = false;
    function sampleDark() {
      const v = document.querySelector('[data-testid="video-stage"] video');
      if (!(v instanceof HTMLVideoElement)) return;
      if (v.videoWidth === 0 || v.videoHeight === 0) {
        setDarkFrames(true);
        if (!darkSinceRef.current) {
          darkSinceRef.current = Date.now();
          recordBlackScreen({
            source: "dark-frame-watchdog",
            prompt: null,
            seed: null,
            sessionId: null,
            luma: null,
            note: "video element has 0x0 dimensions — likely never started",
          });
        }
        return;
      }
      if (canvasTainted) {
        // We already know the canvas is tainted. We can't
        // sample — but don't blindly mark the video as
        // fine either. If the previous sample said dark,
        // keep showing the dark overlay; if it said fine,
        // keep showing fine. This stops the regression
        // where a tainted canvas always reported "fine"
        // even when the video was completely black.
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
        const dark = avg < 22;
        setDarkFrames(dark);
        if (dark && !darkSinceRef.current) {
          darkSinceRef.current = Date.now();
          recordBlackScreen({
            source: "dark-frame-watchdog",
            prompt: null,
            seed: null,
            sessionId: null,
            luma: avg,
            note: `sampled luma ${avg.toFixed(1)}/255`,
          });
        } else if (!dark && darkSinceRef.current) {
          darkSinceRef.current = 0;
        }
      } catch {
        // CORS-tainted canvas — cache the tainted state
        // and leave darkFrames at its last known value
        // (instead of clobbering it with false). The
        // previous code unconditionally setDarkFrames(false)
        // which would mask a genuinely black video behind
        // a tainted canvas.
        canvasTainted = true;
      }
    }
    darkWatchdogRef.current = setInterval(sampleDark, 2000);
    // QA5: do NOT sample on the first tick — the video
    // element starts at 0x0, so the immediate sample
    // would always log a "0x0 dimensions" black-screen
    // event for a totally normal startup. The interval
    // will sample 2s later, by which point the video has
    // its real dimensions.
    return () => {
      if (darkWatchdogRef.current) {
        clearInterval(darkWatchdogRef.current);
        darkWatchdogRef.current = null;
      }
    };
  }, [phase]);

  const showOverlay = phase !== "playing" || now < paintGraceUntil;

  // QA5 / F5: scene-fade transition. When a new paint
  // arrives, fade the previous frame out to a warm cream
  // briefly, then fade the new frame in. This hides the
  // "frame pop" when the SDK emits a near-black first
  // chunk and gives the world a sense of breathing.
  // Driven by `pulseKey` which increments every time the
  // SDK reports a new `image_accepted` event.
  const [pulseKey, setPulseKey] = useState(0);
  const lastImageRef = useRef<string | null>(null);
  useEffect(() => {
    const img = snapshot?.image_url ?? null;
    if (img && img !== lastImageRef.current) {
      lastImageRef.current = img;
      setPulseKey((k) => k + 1);
      // QA5/F4: keep the in-memory snapshot URL buffer in
      // sync so a user-triggered "Download as PNG" can
      // reach the freshest frame without re-rendering.
      setLastImageUrl(img);
    }
  }, [snapshot?.image_url]);
  const [pulseTick, setPulseTick] = useState(0);
  useEffect(() => {
    if (pulseKey === 0) return;
    setPulseTick(pulseKey);
    const t = setTimeout(() => {
      // After the fade completes, drop the tick so the
      // overlay is fully transparent and not animating.
      setPulseTick(0);
    }, 700);
    return () => clearTimeout(t);
  }, [pulseKey]);

  return (
    // M9.13: the old `bg-[#0a0612]` (deep purple-black) was
    // responsible for the user's "blank black screen" report. Even
    // with the aurora layered on top, low-saturation screens showed
    // through to this base color and read as a void. Soft warm cream
    // (`#fef3e8`) is a "better than black" fallback: if the video
    // never paints, the user sees a friendly daylight surface, not
    // a black hole. The aurora gradient still tints it on top.
    <div className="relative h-full w-full overflow-hidden bg-[#fef3e8]">
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

      {/* QA5/F5: scene-fade transition overlay. A warm
          cream flash that pulses for 700ms every time a
          new image_accepted lands, hiding the SDK's
          near-black first chunks and giving the world a
          sense of motion. Backed by a CSS keyframe so we
          don't re-render on every frame. */}
      <div
        key={pulseTick}
        data-testid="video-pulse"
        aria-hidden="true"
        className={[
          "pointer-events-none absolute inset-0",
          pulseTick > 0 ? "animate-[dream-pulse_700ms_ease-out_forwards]" : "opacity-0",
        ].join(" ")}
        style={{
          background:
            "radial-gradient(ellipse at center, rgba(255,243,232,0.65) 0%, rgba(255,243,232,0.0) 60%)",
        }}
      />

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