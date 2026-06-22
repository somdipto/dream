// Surprise Me — a random-curation button for when the user
// doesn't know what to dream. Picks uniformly from CURATED_SCENES
// and emits the same dream:loadScene event the gallery uses.
"use client";

import { dailyDream, CURATED_SCENES } from "../lib/curated-scenes";
import { dreamBus } from "../lib/event-bus";

export function SurpriseButton() {
  function surprise() {
    // Use dailyDream 50% of the time (time-of-day rotation),
    // and a fully random pick the other 50% for variety.
    const scene = Math.random() < 0.5
      ? dailyDream()
      : CURATED_SCENES[Math.floor(Math.random() * CURATED_SCENES.length)];
    dreamBus.emit("dream:loadScene", { prompt: scene.prompt, seed: scene.seed });
  }

  return (
    <button
      type="button"
      onClick={surprise}
      className="inline-flex items-center gap-1.5 rounded-full border border-white/20 bg-white/5 px-3 py-1.5 text-[11px] font-medium text-white/80 transition hover:bg-white/10 hover:text-white"
      data-testid="surprise-btn"
    >
      🎲 Surprise Me
    </button>
  );
}
