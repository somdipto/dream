"use client";

// MobileFlickPaint — headless component that listens for
// physical flicks via useMotionFlicks and routes each one
// through the dream bus as a paint. Mounted only on mobile;
// desktop ignores it.
//
// The product intent: fuse gyroscope (physical motion) with
// voice (text prompts). GyroController already handles the
// "walk + look" path via setMovement / setLook. This
// component closes the loop on the "express via gesture"
// path — a flick is a physical prompt that the world
// reacts to.
//
// Disabled while the user is speaking, so a phone tilt
// during voice recording never trips a paint mid-sentence.

import { useEffect } from "react";
import { dreamBus } from "../lib/event-bus";
import {
  flickToPrompt,
  useMotionFlicks,
} from "../hooks/useMotionFlicks";

export function MobileFlickPaint({
  enabled,
  voiceListening,
  onPaint,
}: {
  enabled: boolean;
  /** True while the user is recording voice — pause flicks then. */
  voiceListening: boolean;
  /** Optional sink for analytics / logging. */
  onPaint?: (kind: string, prompt: string) => void;
}) {
  // The FlickPaint pipeline emits onto dreamBus as a
  // "flick:prompt" event, so any component (DesktopDream,
  // MobileDream, the voice pipeline) can listen for it the
  // same way it listens for chip taps. The bridge in
  // LingbotApp translates "flick:prompt" into the same
  // paint flow the rest of the app uses.
  useEffect(() => {
    const off = dreamBus.on(
      "flick:prompt",
      (d: { prompt: string; kind: string }) => {
        onPaint?.(d.kind, d.prompt);
      },
    );
    return off;
  }, [onPaint]);

  useMotionFlicks({
    paused: !enabled || voiceListening,
    onFlick: (e) => {
      const prompt = flickToPrompt(e.kind);
      dreamBus.emit("flick:prompt", { kind: e.kind, prompt });
    },
  });
  return null;
}
