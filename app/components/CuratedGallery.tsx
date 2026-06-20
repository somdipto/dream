"use client";

// A small "Discover" view that lets the user browse curated starting
// dreams. Lives inside the existing SessionSidebar — opening the
// sidebar shows sessions on one tab and curated dreams on the other.

import { CURATED_SCENES, groupByCategory } from "../lib/curated-scenes";

interface CuratedGalleryProps {
  onPick: (scene: { prompt: string; seed: number }) => void;
  onClose: () => void;
}

export function CuratedGallery({ onPick, onClose }: CuratedGalleryProps) {
  const groups = groupByCategory();
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-4 pb-3 pt-4">
        <h2 className="text-sm font-semibold text-white">Discover</h2>
        <button
          onClick={onClose}
          className="text-[10px] uppercase tracking-wider text-white/40 hover:text-white/70"
        >
          Close
        </button>
      </div>
      <p className="px-4 text-xs text-white/50">
        Hand-picked starting points — tap one to walk in.
      </p>
      <div className="mt-3 flex-1 space-y-4 overflow-y-auto px-4 pb-4">
        {groups.map((g) => (
          <section key={g.category}>
            <h3 className="mb-1.5 text-[10px] uppercase tracking-wider text-white/40">
              {g.category}
            </h3>
            <ul className="space-y-1">
              {g.scenes.map((s) => (
                <li key={s.id}>
                  <button
                    onClick={() => onPick({ prompt: s.prompt, seed: s.seed })}
                    className="flex w-full items-start gap-3 rounded-xl border border-white/10 bg-white/5 p-2.5 text-left transition hover:border-white/25 hover:bg-white/10"
                  >
                    <span className="mt-0.5 text-lg" aria-hidden>
                      {s.emoji}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-xs font-medium text-white">
                        {s.prompt.length > 80 ? s.prompt.slice(0, 77) + "…" : s.prompt}
                      </span>
                      <span className="mt-0.5 block text-[10px] text-white/40">
                        seed {s.seed.toString(16)}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

export { CURATED_SCENES };