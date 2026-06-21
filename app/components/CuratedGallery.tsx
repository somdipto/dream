"use client";

// A small "Discover" view that lets the user browse curated starting
// dreams. Lives inside the existing SessionSidebar — opening the
// sidebar shows sessions on one tab and curated dreams on the other.
//
// QA6: each scene now renders a 128x72 deterministic thumbnail
// using the same `generateSeedImage` function the model uses for
// its anchor image. Thumbnails are cached in a Map<seed, blobUrl>
// so a re-render (e.g. switching tabs) is free.

import { useEffect, useState } from "react";
import { CURATED_SCENES, groupByCategory } from "../lib/curated-scenes";
import { generateSeedImage } from "../lib/seed-image";

interface CuratedGalleryProps {
  onPick: (scene: { prompt: string; seed: number }) => void;
  onClose: () => void;
}

// Cache of seed → objectURL so we don't re-rasterize on
// every re-render. Survives the component lifecycle as long
// as the module is loaded.
//
// QA11/A11Y-13: revoke URLs on `beforeunload` to avoid
// leaks across page navigations. ~30 scenes × ~40KB per
// PNG = ~1.2MB of blob URLs held until the tab closes.
// On long sessions with sidebars frequently opened/closed,
// this matters.
//
// QA16: the beforeunload listener was previously registered
// at module scope. Each HMR re-evaluation of this module
// added a fresh listener that was never removed, so after a
// few hot-reloads the dev tab carried N listeners and
// navigated with N revoke-loops. We now keep a singleton
// registration via a module-level flag, and also expose a
// `teardownThumbs()` helper for tests and explicit cleanup.
const thumbCache = new Map<number, string>();
const pendingSeeds = new Set<number>();
let beforeunloadInstalled = false;

function installBeforeUnloadOnce() {
  if (beforeunloadInstalled) return;
  if (typeof window === "undefined") return;
  beforeunloadInstalled = true;
  window.addEventListener("beforeunload", () => {
    for (const url of thumbCache.values()) {
      try {
        URL.revokeObjectURL(url);
      } catch {
        /* noop */
      }
    }
    thumbCache.clear();
  });
}

installBeforeUnloadOnce();

export function teardownThumbs() {
  for (const url of thumbCache.values()) {
    try {
      URL.revokeObjectURL(url);
    } catch {
      /* noop */
    }
  }
  thumbCache.clear();
  pendingSeeds.clear();
  beforeunloadInstalled = false;
}

async function loadThumb(seed: number, setUrl: (s: string | null) => void) {
  if (thumbCache.has(seed)) {
    setUrl(thumbCache.get(seed) ?? null);
    return;
  }
  if (pendingSeeds.has(seed)) {
    // Coalesce concurrent calls for the same seed.
    return;
  }
  pendingSeeds.add(seed);
  try {
    const blob = await generateSeedImage({ seed, width: 128, height: 72 });
    if (blob) {
      const url = URL.createObjectURL(blob);
      thumbCache.set(seed, url);
      setUrl(url);
    } else {
      setUrl(null);
    }
  } catch {
    setUrl(null);
  } finally {
    pendingSeeds.delete(seed);
  }
}

function Thumbnail({ seed, alt }: { seed: number; alt: string }) {
  const [url, setUrl] = useState<string | null>(thumbCache.get(seed) ?? null);
  useEffect(() => {
    if (url) return;
    // QA16/R3: previous version unconditionally called
    // setUrl from inside an unawaited loadThumb. If the user
    // scrolled past a still-loading thumbnail (closing the
    // sidebar before the image finished), the promise would
    // resolve on an unmounted component and leak the blob
    // URL into `thumbCache` for the rest of the session.
    // mountedRef gates the setUrl and revokes the blob URL
    // we just minted if the component unmounted before the
    // image landed.
    let mounted = true;
    let mintedUrl: string | null = null;
    void loadThumb(seed, (s) => {
      if (!mounted) {
        // The component is gone. If we minted a fresh URL
        // here, the cache would hold it forever — revoke it
        // immediately so the bytes are GC'd.
        if (s && s.startsWith("blob:") && !thumbCache.has(seed)) {
          URL.revokeObjectURL(s);
        }
        return;
      }
      if (s && s.startsWith("blob:")) mintedUrl = s;
      setUrl(s);
    });
    return () => {
      mounted = false;
      // Only revoke URLs we minted ourselves; cache URLs are
      // shared with other thumbnails and live as long as the
      // cache does.
      if (mintedUrl) {
        // Cache may already hold this URL by now — if so,
        // we want to keep it. If not, revoke.
        if (thumbCache.get(seed) !== mintedUrl) {
          URL.revokeObjectURL(mintedUrl);
        }
      }
    };
  }, [seed, url]);
  if (!url) {
    return (
      <div
        className="h-[72px] w-[128px] shrink-0 animate-pulse rounded-md bg-white/5"
        aria-label={alt}
      />
    );
  }
  return (
    <img
      src={url}
      alt={alt}
      width={128}
      height={72}
      loading="lazy"
      decoding="async"
      className="h-[72px] w-[128px] shrink-0 rounded-md object-cover"
    />
  );
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
            <ul className="space-y-1.5">
              {g.scenes.map((s) => (
                <li key={s.id}>
                  <button
                    onClick={() => onPick({ prompt: s.prompt, seed: s.seed })}
                    className="flex w-full items-start gap-3 rounded-xl border border-white/10 bg-white/5 p-2.5 text-left transition hover:border-white/25 hover:bg-white/10"
                  >
                    <Thumbnail seed={s.seed} alt={s.prompt} />
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