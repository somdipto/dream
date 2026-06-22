"use client";

// DreamFeed — F10: a horizontally-scrollable strip of the user's most
// recent scenes across ALL sessions, newest first. Lives in the bottom-
// rail of the world. Each chip shows a 96x54 thumbnail (deterministic
// from the scene's seed) and a truncated prompt.
//
// Why this exists:
//   - The sidebar is the deep, multi-session journal. The feed is the
//     "what did I just paint?" surface — answerable in 1 second.
//   - Users paint dozens of scenes in a single session and want to
//     re-pick a recent one without expanding the sidebar.
//   - The existing PromptHistoryChips (per-session, no thumbnails) is
//     hidden inside the Begin overlay, not visible in the live world.
//
// Replay: tapping a chip emits the same dream:loadScene event the
// sidebar's scene click does, so the same paint path runs — just with
// the historical scene's seed. Visual re-rolls use a fresh seed, but
// for a scene you already loved, replaying with the same seed is the
// right default (audit feedback).
//
// Hidden when there are no scenes yet (Begin overlay case). Positioned
// above the prompt-history strip on desktop, above the QuickFlick strip
// on mobile. Stays out of the way of the main prompt bar.
//
// A11Y: chips are real <button>s with aria-label, 44x44 minimum hit
// target. The container is keyboard-scrollable. Thumbnail placeholder
// announces the alt text while the seed image is generating.

import { useEffect, useMemo, useRef, useState } from "react";
import { dreamBus } from "../lib/event-bus";
import { generateSeedImage } from "../lib/seed-image";
import type { Scene, Session } from "../lib/session-types";

interface DreamFeedProps {
  sessions: Session[];
  /** Called when the user taps a chip — same sink the sidebar uses. */
  onReplay: (scene: Scene) => void;
  /** Optional max scenes to show. Defaults to 12. */
  max?: number;
}

interface FeedEntry {
  session: Session;
  scene: Scene;
}

export function DreamFeed({ sessions, onReplay, max = 12 }: DreamFeedProps) {
  // Flatten all sessions into a single time-ordered list of (scene,
  // session) pairs, newest first. We don't mutate the Session[] —
  // just project.
  const entries: FeedEntry[] = useMemo(() => {
    const out: FeedEntry[] = [];
    for (const s of sessions) {
      for (const sc of s.scenes) {
        out.push({ session: s, scene: sc });
      }
    }
    out.sort((a, b) => b.scene.timestamp - a.scene.timestamp);
    return out.slice(0, max);
  }, [sessions, max]);

  if (entries.length === 0) return null;

  return (
    <div
      className="pointer-events-auto fixed bottom-44 left-0 right-0 z-30 flex justify-center px-3 md:bottom-32"
      data-testid="dream-feed"
    >
      <div className="max-w-full">
        <p className="mb-1.5 text-center text-[10px] uppercase tracking-wider text-white/45">
          Recent dreams
        </p>
        <div
          className="flex max-w-[92vw] gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden md:max-w-3xl"
          role="list"
          aria-label="Recent dreams, tap to replay"
        >
          {entries.map((e) => (
            <FeedChip
              key={`${e.session.id}-${e.scene.id}`}
              entry={e}
              onPick={() => onReplay(e.scene)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function FeedChip({
  entry,
  onPick,
}: {
  entry: FeedEntry;
  onPick: () => void;
}) {
  const [thumb, setThumb] = useState<string | null>(null);

  useEffect(() => {
    // Per-effect cancellation flag. We deliberately do NOT share a
    // mountedRef across effects — when `entry.scene.seed` changes,
    // both effects' cleanups run in unmount order, and the first
    // one's `mountedRef.current = false` would make the second
    // one's "are we unmounting?" check return true even though
    // the component is still mounted. Using a local `cancelled`
    // scoped to this effect's closure is the right primitive.
    let minted: string | null = null;
    let cancelled = false;
    void (async () => {
      try {
        const blob = await generateSeedImage({
          seed: entry.scene.seed,
          width: 96,
          height: 54,
        });
        if (!blob || cancelled) return;
        const url = URL.createObjectURL(blob);
        minted = url;
        if (!cancelled) setThumb(url);
      } catch {
        // Thumbnail failed — show a seed chip instead.
      }
    })();
    return () => {
      cancelled = true;
      if (minted) {
        URL.revokeObjectURL(minted);
      }
    };
  }, [entry.scene.seed]);

  return (
    <button
      type="button"
      onClick={onPick}
      role="listitem"
      aria-label={`Replay: ${entry.scene.prompt}`}
      title={entry.scene.prompt}
      data-testid="dream-feed-chip"
      data-scene-id={entry.scene.id}
      className="group flex w-[112px] shrink-0 flex-col items-stretch gap-1 rounded-lg border border-white/10 bg-black/60 p-1.5 text-left text-white/85 backdrop-blur transition hover:border-white/30 hover:bg-black/80"
    >
      <div className="relative h-[54px] w-[96px] overflow-hidden rounded bg-white/5">
        {thumb ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={thumb}
            alt=""
            width={96}
            height={54}
            className="h-full w-full object-cover"
          />
        ) : (
          <div
            className="flex h-full w-full items-center justify-center text-[10px] uppercase text-white/35"
            aria-hidden="true"
          >
            seed {entry.scene.seed.toString(16).slice(0, 4)}
          </div>
        )}
        {entry.scene.favorite ? (
          <span
            aria-hidden="true"
            className="absolute right-1 top-1 text-[10px] text-white"
            title="Favorite"
          >
            ★
          </span>
        ) : null}
      </div>
      <p className="line-clamp-2 max-w-full text-[10px] leading-tight text-white/80 group-hover:text-white">
        {entry.scene.prompt}
      </p>
    </button>
  );
}

/**
 * Replay a scene: emit the same dream:loadScene event the sidebar
 * emits, with the scene's stored seed. This makes the model's
 * anchor re-render the same way it did for the original paint.
 * Callers should also call setActive on the scene's session so
 * the sidebar reflects the replay target.
 */
export function replayScene(scene: Scene) {
  dreamBus.emit("dream:loadScene", { prompt: scene.prompt, seed: scene.seed });
}
