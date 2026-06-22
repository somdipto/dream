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
//
// F9: QuickFlickStrip — a row of preset chips that fire
// the same bus events a physical flick would. Long-press
// (500ms) on a chip paints the world. Useful for demo,
// accessibility, and faster iteration.

import { useEffect, useState, useCallback, useRef } from "react";
import { dreamBus } from "../lib/event-bus";
import {
  flickToPrompt,
  useMotionFlicks,
  type FlickKind,
} from "../hooks/useMotionFlicks";

const PRESETS: Array<{ kind: FlickKind; label: string; icon: string }> = [
  { kind: "spin", label: "Spin", icon: "🔄" },
  { kind: "dive", label: "Dive", icon: "⬇️" },
  { kind: "lift", label: "Lift", icon: "⬆️" },
  { kind: "roll", label: "Roll", icon: "↔️" },
];

function QuickFlickStrip({
  enabled,
  voiceListening,
  onPaint,
}: {
  enabled: boolean;
  voiceListening: boolean;
  onPaint?: (kind: string, prompt: string) => void;
}) {
  // Long-press timer per chip.
  const timersRef = useRef<Map<FlickKind, ReturnType<typeof setTimeout>>>(
    new Map(),
  );
  const [pressed, setPressed] = useState<FlickKind | null>(null);

  const cancel = useCallback(() => {
    timersRef.current.forEach((t) => clearTimeout(t));
    timersRef.current.clear();
    setPressed(null);
  }, []);

  // Round 8 fix: cancel any armed 500ms timer when flicks
  // are disabled or when voice starts listening. Without
  // this, a timer started before voiceListening flipped
  // to true would fire 500ms later and emit a stale flick.
  useEffect(() => {
    if (!enabled || voiceListening) cancel();
  }, [enabled, voiceListening, cancel]);

  const start = useCallback((kind: FlickKind) => {
    if (!enabled || voiceListening) return;
    cancel();
    setPressed(kind);
    const timer = setTimeout(() => {
      const prompt = flickToPrompt(kind);
      dreamBus.emit("flick:prompt", { kind, prompt });
      onPaint?.(kind, prompt);
      setPressed(null);
      timersRef.current.delete(kind);
    }, 500);
    timersRef.current.set(kind, timer);
  }, [enabled, voiceListening, onPaint, cancel]);

  // Cancel on unmount or leave page.
  useEffect(() => () => cancel(), [cancel]);

  // If the user lifts before 500ms, cancel.
  if (!enabled) return null;

  return (
    <div
      className="pointer-events-auto fixed bottom-28 left-1/2 z-40 flex -translate-x-1/2 gap-3 rounded-full border border-white/15 bg-black/60 px-3 py-1.5 shadow-lg backdrop-blur md:bottom-16"
      data-testid="quick-flick-strip"
    >
      {PRESETS.map((p) => (
        <button
          key={p.kind}
          type="button"
          disabled={voiceListening}
          onTouchStart={() => start(p.kind)}
          onMouseDown={() => start(p.kind)}
          onTouchEnd={cancel}
          onMouseUp={cancel}
          onMouseLeave={cancel}
          aria-label={`Quick flick: ${p.label}`}
          className={[
            "flex flex-col items-center justify-center rounded-full border px-2 py-1 transition-all min-w-[52px] min-h-[52px]",
            pressed === p.kind
              ? "border-white/60 bg-white/20"
              : "border-white/10 bg-white/5 hover:bg-white/10",
          ].join(" ")}
        >
          <span className="text-lg">{p.icon}</span>
          <span className="mt-0.5 text-[9px] uppercase text-white/55">
            {p.label}
          </span>
        </button>
      ))}
    </div>
  );
}

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
  // R11-3: the previous version emitted onto dreamBus inside
  // useMotionFlicks' onFlick, then immediately re-listened for
  // the same event inside this component to forward it to
  // onPaint. That was a redundant roundtrip — by the time
  // the listener fired, dreamBus had already dispatched the
  // event to other subscribers (the actual paint pipeline in
  // LingbotApp). Calling onPaint directly here is cheaper,
  // avoids a setTimeout-0 hop on the bus, and removes a
  // possible ordering bug where the listener attached
  // AFTER the first emit missed the event.
  //
  // The flick:prompt bus event is still emitted (for the
  // QuickFlickStrip path below, which uses the bus to
  // dispatch), so external subscribers are unchanged.
  useMotionFlicks({
    paused: !enabled || voiceListening,
    onFlick: (e) => {
      const prompt = flickToPrompt(e.kind);
      dreamBus.emit("flick:prompt", { kind: e.kind, prompt });
      onPaint?.(e.kind, prompt);
    },
  });

  return (
    <>
      <QuickFlickStrip
        enabled={enabled}
        voiceListening={voiceListening}
        onPaint={onPaint}
      />
    </>
  );
}
