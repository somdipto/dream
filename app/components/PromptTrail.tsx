"use client";

// Paint Trail — a horizontal strip at the top of the canvas
// that shows the user's last 20 spoken/typed prompts as
// fading pills. Makes the dream legible to a passive
// observer (a hackathon judge watching over the user's
// shoulder): they can see WHAT the user said without
// having to open the sidebar.
//
// Each pill fades out over 90 seconds. Newest = brightest.
// Listens to `dream:loadScene` events.

import { useEffect, useState } from "react";
import { dreamBus } from "../lib/event-bus";

interface Pill {
  prompt: string;
  timestamp: number;
  id: string;
}

const MAX_PILLS = 20;
const FADE_MS = 90_000;

export function PromptTrail() {
  const [pills, setPills] = useState<Pill[]>([]);

  useEffect(() => {
    function onLoad(d: { prompt: string; seed: number }) {
      if (!d?.prompt) return;
      const id = `${d.seed}-${Date.now()}`;
      setPills((prev) => {
        // De-dup by exact prompt within 2s (handles the
        // same prompt being re-loaded by the share URL or
        // by the user tapping a chip twice rapidly).
        const last = prev[prev.length - 1];
        if (last && last.prompt === d.prompt && Date.now() - last.timestamp < 2000) {
          return prev;
        }
        const next = [...prev, { prompt: d.prompt, timestamp: Date.now(), id }];
        return next.slice(-MAX_PILLS);
      });
    }
    const off = dreamBus.on("dream:loadScene", onLoad);
    return off;
  }, []);

  // Trim expired pills every 5s. Cheap; user is unlikely to
  // notice the gap between fade and removal.
  useEffect(() => {
    const id = setInterval(() => {
      setPills((prev) => {
        const cutoff = Date.now() - FADE_MS;
        const next = prev.filter((p) => p.timestamp > cutoff);
        return next.length === prev.length ? prev : next;
      });
    }, 5_000);
    return () => clearInterval(id);
  }, []);

  if (pills.length === 0) return null;

  const now = Date.now();
  return (
    <div
      className="pointer-events-none fixed inset-x-0 top-0 z-30 flex justify-center px-3 pt-[max(3.5rem,env(safe-area-inset-top))]"
      data-testid="prompt-trail"
      aria-hidden="true"
    >
      <div className="flex max-w-full gap-1.5 overflow-x-auto [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
        {pills.map((p) => {
          const age = now - p.timestamp;
          const opacity = Math.max(0.15, 1 - age / FADE_MS);
          return (
            <span
              key={p.id}
              className="shrink-0 max-w-[180px] truncate rounded-full border border-white/10 bg-black/55 px-2.5 py-1 text-[10px] text-white/90 backdrop-blur"
              style={{ opacity }}
              title={p.prompt}
              data-testid="prompt-trail-pill"
            >
              {p.prompt}
            </span>
          );
        })}
      </div>
    </div>
  );
}