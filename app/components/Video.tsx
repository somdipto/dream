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
// Overlay logic:
//   - status === "ready" but no image_accepted yet → "Preparing your
//     world…" so the user doesn't think the app is broken
//   - status === "ready" + has_image but not started → "Tap Paint or
//     speak to begin"
//   - status === "ready" + started → transparent (let the video play)
//
// The overlay fades in/out so it doesn't strobe on brief state changes.

export function Video() {
  const { status } = useLingbot();
  const snapshot = useLingbotStateSnapshot();
  const [phase, setPhase] = useState<"loading" | "ready" | "generating" | "playing">(
    "loading",
  );

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
    setPhase("playing");
  }, [status, snapshot?.has_image, snapshot?.started]);

  const showOverlay = phase !== "playing";

  return (
    <div className="relative h-full w-full overflow-hidden bg-black">
      <LingbotMainVideoView
        className="h-full w-full"
        videoObjectFit="cover"
      />
      {showOverlay && (
        <div
          className="pointer-events-none absolute inset-0 flex items-center justify-center bg-gradient-to-b from-black/40 via-black/20 to-black/40 backdrop-blur-sm transition-opacity duration-500"
          data-testid="video-overlay"
        >
          <div className="max-w-sm px-6 text-center">
            {phase === "loading" && (
              <>
                <div className="mx-auto h-2 w-2 animate-pulse rounded-full bg-amber-400" />
                <p className="mt-4 text-sm text-white/80">
                  {status === "connecting"
                    ? "Connecting to Reactor…"
                    : status === "waiting"
                      ? "Waiting for a GPU…"
                      : "Preparing your world…"}
                </p>
              </>
            )}
            {phase === "ready" && (
              <>
                <p className="text-xs uppercase tracking-widest text-emerald-300/80">
                  World connected
                </p>
                <p className="mt-2 text-sm text-white/80">
                  Speak or type your first scene
                </p>
              </>
            )}
            {phase === "generating" && (
              <>
                <div className="mx-auto h-2 w-2 animate-pulse rounded-full bg-emerald-400" />
                <p className="mt-4 text-sm text-white/80">
                  Painting your dream…
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
// separately so the inner effect can re-run cleanly.
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