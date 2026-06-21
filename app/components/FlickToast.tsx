"use client";

// FlickToast — ephemeral feedback when a physical gesture (spin, dive,
// lift, roll) paints the world. Shows for 1.2s after any flick:prompt
// event on the bus, with the prompt text and a gesture icon.
//
// Product intent: the user's gyroscope gesture (sharp phone motion) is
// a "physical prompt" that mutates the world. Without feedback, the
// user doesn't know their gesture registered. This toast confirms it.

import { useEffect, useState } from "react";
import { dreamBus } from "../lib/event-bus";

const ICONS: Record<string, string> = {
  spin: "🔄",
  dive: "⬇️",
  lift: "⬆️",
  roll: "↔️",
};

export function FlickToast() {
  const [visible, setVisible] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [kind, setKind] = useState<string>("");

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = dreamBus.on("flick:prompt", (d: { prompt: string; kind: string }) => {
      setPrompt(d.prompt);
      setKind(d.kind);
      setVisible(true);
      // Clear any pending hide timer — a new flick replaces the old.
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setVisible(false), 1200);
    });
    return () => {
      off();
      if (timer) clearTimeout(timer);
    };
  }, []);

  if (!visible) return null;

  return (
    <div
      className="pointer-events-none fixed bottom-24 left-1/2 z-50 -translate-x-1/2 animate-[fade-in-up_300ms_ease-out] md:bottom-12"
      role="status"
      aria-live="polite"
      aria-atomic="true"
      data-testid="flick-toast"
    >
      <div className="rounded-full border border-white/20 bg-black/80 px-4 py-2 text-center shadow-xl backdrop-blur">
        <span className="text-xl" aria-hidden="true">
          {ICONS[kind] || "✨"}
        </span>
        <p className="mt-1 max-w-[240px] text-xs text-white/90">
          {prompt}
        </p>
      </div>
    </div>
  );
}
