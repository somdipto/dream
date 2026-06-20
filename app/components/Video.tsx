"use client";

import { useEffect, useState } from "react";
import {
  LingbotMainVideoView,
  useLingbot,
  useLingbotState,
} from "@reactor-models/lingbot";

// Full-bleed background video. `<LingbotMainVideoView>` is a pre-bound
// `<ReactorView track="main_video">` from the typed SDK — no refs, no
// `srcObject`, no autoplay tricks.
//
// The container background is a *vivid aurora gradient* (not pure
// black) so that during the several seconds between "user clicks
// Paint" and "the first real frame arrives," the user sees a
// beautiful animated background — not a black void that reads as
// "broken app." A single CSS animation on the gradient stops the
// moment the model starts producing real frames.
//
// Overlay logic:
//   - status !== "ready" → "Connecting to Reactor…" / "Preparing your
//     world…" centered on the aurora
//   - status === "ready" but no image_accepted yet → "Speak or type
//     your first scene"
//   - status === "ready" + has_image but not started → "Painting your
//     dream…" with an animated aurora
//   - status === "ready" + started → transparent (let the video play)
//
// The video element itself fades in over 600ms once we have a real
// frame — LingBot's first frames are sometimes near-black, and a
// hard cut from aurora to a black video looks like a regression.
//
// The overlay fades in/out so it doesn't strobe on brief state
// changes.

export function Video() {
  const { status } = useLingbot();
  const snapshot = useLingbotStateSnapshot();
  const [phase, setPhase] = useState<"loading" | "ready" | "generating" | "playing">(
    "loading",
  );
  // Keep aurora + overlay visible for a few seconds AFTER `started`
  // flips, because Reactor sets `started=true` the moment it accepts
  // `start()` — but the first actual frame can still be 2–8 seconds
  // away. Without this grace window the user sees a black void where
  // a frame should be. (Real-world bug report, June 2026.)
  const [paintGraceUntil, setPaintGraceUntil] = useState<number>(0);

  useEffect(() => {
    if (status !== "ready") {
      setPhase("loading");
      return;
    }
    if (!snapshot?.has_image) {
      setPhase("ready");
      return;
    }
    if (!snapshot?.started) {
      setPhase("generating");
      return;
    }
    // Just started — give the canvas ~6 seconds to actually emit its
    // first non-black frame before we drop the aurora.
    setPaintGraceUntil(Date.now() + 6000);
    setPhase("playing");
  }, [status, snapshot?.has_image, snapshot?.started]);

  const [now, setNow] = useState<number>(Date.now());
  useEffect(() => {
    if (phase !== "playing") return;
    // Tick once per second until the grace window expires, then stop.
    // Cheap; re-renders a single number.
    const tick = () => setNow(Date.now());
    const handle = window.setInterval(tick, 500);
    return () => window.clearInterval(handle);
  }, [phase]);

  const showOverlay = phase !== "playing" || now < paintGraceUntil;
  const showAurora = phase !== "playing" || now < paintGraceUntil;

  return (
    <div className="relative h-full w-full overflow-hidden bg-[#0a0612]">
      {/* Aurora background — only visible while we're NOT playing real
          video frames. Pure-black → user thinks app is broken. Aurora
          → user sees something beautiful while waiting. */}
      {showAurora && (
        <div
          className="pointer-events-none absolute inset-0"
          aria-hidden="true"
          data-testid="video-aurora"
        >
          <div className="absolute inset-0 animate-[aurora-shift_18s_ease-in-out_infinite] bg-[radial-gradient(ellipse_at_top_left,rgba(99,102,241,0.55),transparent_55%),radial-gradient(ellipse_at_bottom_right,rgba(236,72,153,0.45),transparent_55%),radial-gradient(ellipse_at_top_right,rgba(34,211,238,0.40),transparent_55%),radial-gradient(ellipse_at_bottom_left,rgba(168,85,247,0.40),transparent_55%)] bg-[length:200%_200%]" />
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_40%,rgba(255,255,255,0.10),transparent_60%)]" />
        </div>
      )}

      {/* The video itself fades in over 600ms. The first frame from
          LingBot can be near-black; a hard cut from aurora to black
          video reads as "did I just break it?" */}
      <div
        className={[
          "absolute inset-0 transition-opacity duration-700 ease-out",
          phase === "playing" ? "opacity-100" : "opacity-0",
        ].join(" ")}
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