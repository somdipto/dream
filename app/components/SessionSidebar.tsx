"use client";

import { useEffect, useRef, useState } from "react";
import { useSessions } from "./SessionProvider";
import type { Session } from "../lib/session-types";
import { usePlatform } from "../hooks/usePlatform";
import { CuratedGallery } from "./CuratedGallery";
import { dreamBus } from "../lib/event-bus";

// Toggleable sidebar showing the user's saved sessions.
//
// Desktop: 320px fixed left rail. Hidden by default. The toggle button
//   sits in the top bar (passed in by the parent as `open`).
// Mobile: bottom sheet, swipe-up to expand. Toggle button in the top bar.
//
// The sidebar has two tabs:
//   - "Sessions" — the user's saved dream journal (default).
//   - "Discover" — a curated gallery of starting dreams.
//
// Audit bugs addressed:
//   - #24: removeScene now accepts (sessionId, sceneId) so removing a
//     scene from a non-active session works correctly.
//   - #25: clicking a session header re-paints its last scene via the
//     same `dream:loadScene` event the inner scene buttons use.
//   - #32: delete-session now goes through a 4s undo toast instead of
//     a single-tap permanent delete.
//   - #33: sessions can be renamed in place.

export interface SessionSidebarProps {
  open: boolean;
  onClose: () => void;
  onSelectScene?: (sessionId: string, sceneId: string) => void;
  onPickCurated?: (scene: { prompt: string; seed: number }) => void;
}

export function SessionSidebar({ open, onClose, onSelectScene, onPickCurated }: SessionSidebarProps) {
  const platform = usePlatform();
  const store = useSessions();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [tab, setTab] = useState<"sessions" | "discover">("sessions");
  // QA3: when true, the Sessions list shows ONLY scenes marked
  // as favorites (across all sessions). Toggled by a small chip
  // next to the Sessions tab.
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  // Undo-stack for delete-with-undo. Stores the removed session so we
  // can restore it on Undo tap. Cleared by timeout or by a new delete.
  const [pendingDelete, setPendingDelete] = useState<{
    session: Session;
    timeoutId: ReturnType<typeof setTimeout>;
  } | null>(null);
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Mobile swipe-down-to-close. Tracks a drag in progress.
  const dragRef = useRef<{ y: number; t: number; dy: number } | null>(null);
  const asideRef = useRef<HTMLElement | null>(null);
  // Element inside the sidebar that should receive focus when the
  // sidebar opens. We focus the first tab button so a screen-reader
  // user lands on a known landmark; Escape and clicking the close
  // button return focus to whatever element was focused before
  // (the topbar ☰ button — located by data-testid).
  const firstFocusableRef = useRef<HTMLButtonElement | null>(null);
  // Remember the element focused at the moment we opened, so we
  // can restore focus to it on close. (For most flows this is the
  // ☰ button in the top bar; we capture whatever it was at the
  // moment the sidebar opened.)
  const previouslyFocusedRef = useRef<Element | null>(null);

  const isDesktop = platform.isDesktop;
  // QA3: when favoritesOnly is true, sessions that have zero
  // favorited scenes are hidden. The remaining sessions keep
  // their sort order (most-recently-updated first).
  const sorted = [...store.sessions]
    .filter((s) =>
      favoritesOnly ? s.scenes.some((sc) => sc.favorite) : true,
    )
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const favoriteCount = store.sessions.reduce(
    (acc, s) => acc + s.scenes.filter((sc) => sc.favorite).length,
    0,
  );

  // Cleanup the undo timer when the sidebar closes.
  useEffect(() => {
    return () => {
      if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    };
  }, []);

  // Focus management: when the sidebar opens, move focus to the
  // first tab so a keyboard / screen-reader user lands on a known
  // landmark. When it closes, return focus to the element that was
  // focused before (usually the ☰ button in the top bar) so the
  // user doesn't lose their place in the document.
  //
  // We defer the focus on open by a frame because the sidebar is
  // animated in via Tailwind's `transition-transform` and focusing
  // a translate-y-full element too early can scroll the page.
  useEffect(() => {
    if (open) {
      previouslyFocusedRef.current =
        typeof document !== "undefined" ? document.activeElement : null;
      const t = setTimeout(() => {
        firstFocusableRef.current?.focus();
      }, 50);
      return () => clearTimeout(t);
    } else if (previouslyFocusedRef.current instanceof HTMLElement) {
      // Sidebar just closed — restore focus to the trigger.
      const el = previouslyFocusedRef.current;
      // Only restore if the element is still in the document and
      // not detached. (Rapid open/close cycles can detach nodes.)
      if (document.body.contains(el)) {
        // Use a microtask to give the close animation a chance to
        // start so focus restoration isn't visible as a "jump".
        queueMicrotask(() => el.focus());
      }
    }
    return undefined;
  }, [open]);

  // QA11/A11Y-1: Escape closes the sidebar. The sidebar is
  // the most-used dialog in the app and was missing an Escape
  // handler — keyboard users had to find the small × button.
  // Matches the pattern used by VRView (line 103-110) and
  // ShortcutsModal (line 611-613).
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Mobile-only swipe-down-to-close. Threshold: drag > 100px OR
  // velocity > 0.5 px/ms. We track only the first finger; secondary
  // fingers are ignored.
  useEffect(() => {
    if (isDesktop) return;
    const el = asideRef.current;
    if (!el) return;
    function onStart(e: TouchEvent) {
      if (!open) return;
      const t = e.touches[0];
      if (!t) return;
      // Only start a drag from the top ~30% of the sheet (the
      // grab-handle area). Touches lower on the sheet are content
      // scrolls and shouldn't dismiss the panel.
      const r = el!.getBoundingClientRect();
      if (t.clientY - r.top > r.height * 0.3) return;
      dragRef.current = { y: t.clientY, t: Date.now(), dy: 0 };
    }
    function onMove(e: TouchEvent) {
      const d = dragRef.current;
      if (!d) return;
      const t = e.touches[0];
      if (!t) return;
      d.dy = Math.max(0, t.clientY - d.y);
    }
    function onEnd() {
      const d = dragRef.current;
      if (!d) return;
      const elapsed = Math.max(1, Date.now() - d.t);
      const velocity = d.dy / elapsed;
      if (d.dy > 100 || velocity > 0.5) {
        onClose();
      }
      dragRef.current = null;
    }
    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: true });
    el.addEventListener("touchend", onEnd, { passive: true });
    el.addEventListener("touchcancel", onEnd, { passive: true });
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
    };
  }, [isDesktop, open, onClose]);

  function deleteWithUndo(session: Session) {
    // Capture the session at delete time so the "Undo" can put it back
    // even after another addScene/removeScene has reshuffled the list.
    setPendingDelete((curr) => {
      if (curr) clearTimeout(curr.timeoutId);
      // QA16: also clear the unmount-cleanup mirror so an
      // unmount during the 4.5s undo window doesn't leave a
      // dangling timeout that fires after the sidebar is gone.
      if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
      const timeoutId = setTimeout(() => setPendingDelete(null), 4500);
      undoTimerRef.current = timeoutId;
      return { session, timeoutId };
    });
    store.deleteSession(session.id);
  }

  function undoDelete() {
    if (!pendingDelete) return;
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    undoTimerRef.current = null;
    store.restoreSession(pendingDelete.session);
    setPendingDelete(null);
  }

  return (
    <>
      {open && (
        <div
          className="fixed inset-0 z-30 bg-black/30 backdrop-blur-sm md:hidden"
          onClick={onClose}
        />
      )}

      <aside
        ref={asideRef}
        className={[
          "fixed z-40 bg-black/85 text-white shadow-2xl backdrop-blur transition-transform",
          isDesktop
            ? [
                "left-0 top-0 h-full w-[320px] border-r border-white/10",
                open ? "translate-x-0" : "-translate-x-full pointer-events-none",
              ].join(" ")
            : [
                "bottom-0 left-0 right-0 max-h-[70vh] rounded-t-2xl border-t border-white/10",
                open ? "translate-y-0" : "translate-y-full",
              ].join(" "),
        ].join(" ")}
        aria-hidden={!open}
        // `inert` keeps Tab focus out of the hidden sidebar on desktop.
        // Polyfilled by React 19, but we still set aria-hidden above.
        // (Audit bug #34.)
        {...({ inert: !open } as { inert?: boolean })}
      >
        {/* Mobile-only drag handle. The grab-handle area is the top
            ~30% of the sheet (see the touchstart handler above). */}
        {!isDesktop && (
          <div className="flex justify-center pt-2">
            <span
              aria-hidden="true"
              className="h-1 w-10 rounded-full bg-white/20"
            />
          </div>
        )}
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
          <div className="flex gap-2" role="tablist" aria-label="Journal tabs">
            <button
              type="button"
              role="tab"
              aria-selected={tab === "sessions"}
              // QA11/A11Y-15: removed aria-pressed. Tabs
              // convey state via aria-selected; pressed
              // is for toggle buttons. SR users were
              // hearing "tab, selected, pressed" — a
              // double-state announcement that's
              // confusing.
              onClick={() => setTab("sessions")}
              data-testid="tab-sessions"
              ref={firstFocusableRef}
              className={[
                "rounded-full px-3 py-1 text-xs font-medium transition",
                tab === "sessions"
                  ? "bg-white text-black"
                  : "border border-white/15 bg-white/5 text-white/80 hover:bg-white/10",
              ].join(" ")}
            >
              Sessions {store.sessions.length > 0 && (
                <span className="ml-1 text-[10px] text-white/50">
                  {store.sessions.length}
                </span>
              )}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "discover"}
              onClick={() => setTab("discover")}
              data-testid="tab-discover"
              className={[
                "rounded-full px-3 py-1 text-xs font-medium transition",
                tab === "discover"
                  ? "bg-white text-black"
                  : "border border-white/15 bg-white/5 text-white/80 hover:bg-white/10",
              ].join(" ")}
            >
              Discover
            </button>
          </div>
          {/* QA3: Favorites filter — only shown on the Sessions
              tab so it doesn't overlap the Curated gallery. */}
          {tab === "sessions" ? (
            <button
              type="button"
              onClick={() => setFavoritesOnly((v) => !v)}
              aria-pressed={favoritesOnly}
              aria-label={favoritesOnly ? "Show all scenes" : "Show favorites only"}
              data-testid="favorites-toggle"
              className={[
                "grid h-9 w-9 place-items-center rounded-full border text-xs",
                favoritesOnly
                  ? "border-white/40 bg-white/15 text-white"
                  : "border-white/10 bg-white/5 text-white/55 hover:bg-white/10",
              ].join(" ")}
            >
              {favoritesOnly ? "♥" : "♡"}
            </button>
          ) : null}
          {/* QA6/F4: Read my last dream. Uses the Web Speech
              API (speechSynthesis) to narrate the user's last
              few scenes back to them. Stops on second click.
              Falls back gracefully on browsers without
              speechSynthesis (Safari iOS sometimes lags). */}
          {tab === "sessions" ? (
            <ReadLastDreamButton />
          ) : null}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close sidebar"
            className="grid h-9 w-9 place-items-center rounded-full border border-white/10 bg-white/5 text-xs text-white/80 hover:bg-white/10"
          >
            ×
          </button>
        </div>

        {tab === "discover" ? (
          <CuratedGallery
            onPick={(s) => {
              onPickCurated?.(s);
              onClose();
            }}
            onClose={() => setTab("sessions")}
          />
        ) : (
          <div className="overflow-y-auto px-2 py-2" style={{ maxHeight: "calc(100vh - 64px)" }}>
            {sorted.length === 0 ? (
              <div className="px-3 py-8 text-center">
                <p className="text-sm text-white/50">
                  {favoritesOnly
                    ? "No favorites yet."
                    : "No saved dreams yet."}
                </p>
                <p className="mt-1 text-xs text-white/40">
                  {favoritesOnly
                    ? "Tap the heart on any scene to add it here."
                    : "Paint or speak a scene and it will save here automatically."}
                </p>
              </div>
            ) : (
              <>
                {favoritesOnly && favoriteCount > 0 && (
                  <p className="px-3 pb-2 text-[10px] uppercase tracking-wider text-white/60">
                    {favoriteCount} favorite{favoriteCount === 1 ? "" : "s"}
                  </p>
                )}
                {sorted.map((s) => (
                  <SessionCard
                    key={s.id}
                    session={s}
                    isActive={s.id === store.activeSessionId}
                    isExpanded={expanded === s.id}
                    onToggle={() => setExpanded(expanded === s.id ? null : s.id)}
                    onLoad={() => {
                      store.loadSession(s.id);
                    // Re-paint the most recent scene of this session.
                    // Audit bug #25.
                    const last = s.scenes[s.scenes.length - 1];
                    if (last) onSelectScene?.(s.id, last.id);
                    onClose();
                  }}
                  onDelete={() => deleteWithUndo(s)}
                  onRename={(title) => store.renameSession(s.id, title)}
                  onRemoveScene={(sceneId) => store.removeScene(sceneId, s.id)}
                  onSelectScene={(sceneId) => {
                    onSelectScene?.(s.id, sceneId);
                  }}
                  onToggleFavorite={(sceneId) => store.toggleFavorite(sceneId, s.id)}
                  onFork={(sceneId) => {
                    // QA13/F11: fork at this scene, then
                    // jump to the fork's last scene. The
                    // fork becomes the new active session
                    // (forkSession sets it), and we close
                    // the sidebar so the user can see the
                    // new world paint.
                    const newId = store.forkSession({ sessionId: s.id, atSceneId: sceneId });
                    if (newId) {
                      const forked = store.sessions.find((x) => x.id === newId);
                      const last = forked?.scenes[forked.scenes.length - 1];
                      if (last) onSelectScene?.(newId, last.id);
                      onClose();
                    }
                  }}
                  onExport={() => {
                    // F7: download a session's scenes as JSON.
                    // No UI change other than a toast on success
                    // so the user can confirm the file saved.
                    const r = store.exportSession(s.id);
                    if (r.ok) {
                      dreamBus.emit("dream:toast", {
                        kind: "success",
                        message: `Saved ${r.filename ?? "session"}`,
                        ttlMs: 2500,
                      });
                    } else {
                      dreamBus.emit("dream:toast", {
                        kind: "error",
                        message: "Couldn't export session",
                        ttlMs: 3000,
                      });
                    }
                  }}
                />
                ))}
              </>
            )}
          </div>
        )}
      </aside>

      {/* Undo toast — anchored to the bottom-center so it doesn't sit
          over the Dream app's controls. */}
      {pendingDelete && (
        <div
          role="status"
          aria-live="polite"
          className="pointer-events-none fixed inset-x-0 bottom-24 z-50 flex justify-center px-4"
          data-testid="delete-undo-toast"
        >
          <div className="pointer-events-auto flex items-center gap-3 rounded-full border border-white/15 bg-black/90 px-4 py-2 text-xs text-white shadow-2xl backdrop-blur">
            <span className="text-white/85">
              Deleted "{truncate(pendingDelete.session.title, 28)}"
            </span>
            <button
              type="button"
              onClick={undoDelete}
              className="rounded-full bg-white/15 px-3 py-1 font-medium text-white hover:bg-white/25"
              data-testid="delete-undo-btn"
            >
              Undo
            </button>
          </div>
        </div>
      )}
    </>
  );
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

// QA5/F4: scene-to-PNG download. The sidebar doesn't have
// the rendered frame — only the prompt + seed. We replay
// the scene (loadScene), wait for the next `dream:paintDone`
// with ok:true, then read the most recent snapshot URL from
// a small in-memory buffer that the Lingbot state listener
// keeps up to date. If the paint fails or times out, we
// fall back to the deterministic seed-image function so
// the user always gets a PNG.
async function downloadScenePng(scene: { prompt: string; seed: number; id: string }) {
  const safe = scene.prompt.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 40) || "dream";
  const filename = `${safe}-${scene.seed.toString(16)}.png`;
  // Tell the world to render this scene fresh. The next
  // paint's URL will land in the bus's "last image url"
  // bucket (see Video.tsx and VoiceDream.tsx — they keep
  // it up to date on every snapshot).
  dreamBus.emit("dream:abortPaint", {} as never);
  dreamBus.emit("dream:loadScene", { prompt: scene.prompt, seed: scene.seed });
  let url: string | undefined;
  let done = false;
  const unsubscribeDone = dreamBus.on("dream:paintDone", (detail: { ok: boolean }) => {
    if (detail.ok) {
      done = true;
      url = readLastImageUrl();
    } else {
      done = true;
    }
  });
  try {
    for (let i = 0; i < 30; i++) {
      if (done) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!url) url = readLastImageUrl();
    let blob: Blob | null = null;
    if (url) {
      blob = await fetch(url).then((r) => r.blob()).catch(() => null);
    }
    if (!blob) {
      // Fall back to the deterministic seed image. This
      // works even if Reactor is down — the seed-image
      // function is pure client-side and stable.
      blob = await deterministicSeedImageBlob(scene.seed);
    }
    if (!blob) return;
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  } finally {
    unsubscribeDone();
  }
}

// Tiny in-memory buffer for the most-recent image URL.
// Set by Video.tsx / VoiceDream.tsx on every snapshot
// change; read by downloadScenePng. Lives outside React
// so a download triggered from a stale closure still
// gets the freshest frame.
import { readLastImageUrl, setLastImageUrl } from "../lib/last-image";
// Re-exported for backwards compatibility with other call sites
// that imported `setLastImageUrl` from this module.
export { setLastImageUrl };

// Generate a deterministic, in-browser placeholder for a
// given seed. The seed-image.ts module owns the actual
// algorithm; we wrap it lazily so this file doesn't
// depend on canvas at import time.
let seedImageFn: ((seed: number) => Promise<Blob | null>) | null = null;
async function deterministicSeedImageBlob(seed: number): Promise<Blob | null> {
  if (!seedImageFn) {
    try {
      const mod = await import("../lib/seed-image");
      seedImageFn = (s: number) => mod.generateSeedImage({ seed: s });
    } catch {
      seedImageFn = async () => null;
    }
  }
  return seedImageFn(seed);
}

function SessionCard({
  session,
  isActive,
  isExpanded,
  onToggle,
  onLoad,
  onDelete,
  onRename,
  onRemoveScene,
  onSelectScene,
  onToggleFavorite,
  onFork,
  onExport,
}: {
  session: Session;
  isActive: boolean;
  isExpanded: boolean;
  onToggle: () => void;
  onLoad: () => void;
  onDelete: () => void;
  onRename: (title: string) => void;
  onRemoveScene: (sceneId: string) => void;
  onSelectScene: (sceneId: string) => void;
  onToggleFavorite: (sceneId: string) => void;
  onFork: (sceneId: string) => void;
  onExport: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [draftTitle, setDraftTitle] = useState(session.title);
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (renaming) {
      setDraftTitle(session.title);
      requestAnimationFrame(() => inputRef.current?.select());
    }
  }, [renaming, session.title]);

  function commitRename() {
    const next = draftTitle.trim();
    if (next && next !== session.title) onRename(next);
    setRenaming(false);
  }

  return (
    <div
      className={[
        "mb-2 overflow-hidden rounded-xl border",
        isActive ? "border-white/30 bg-white/10" : "border-white/10 bg-white/5",
      ].join(" ")}
    >
      <div className="flex items-start gap-2 p-3">
        {renaming ? (
          <input
            ref={inputRef}
            value={draftTitle}
            onChange={(e) => setDraftTitle(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
              if (e.key === "Escape") setRenaming(false);
            }}
            maxLength={120}
            aria-label="Rename session"
            data-testid="session-rename-input"
            className="min-h-[44px] flex-1 rounded-md border border-white/30 bg-black/60 px-2 py-1 text-sm text-white focus:outline-none"
          />
        ) : (
          <button
            type="button"
            onClick={onLoad}
            className="min-h-[44px] flex-1 text-left"
          >
            <p className="line-clamp-2 text-sm font-medium leading-snug">
              {session.title}
            </p>
            <p className="mt-1 text-[10px] uppercase tracking-wider text-white/50">
              {session.scenes.length} scene{session.scenes.length === 1 ? "" : "s"} · {timeAgo(session.updatedAt)}
            </p>
          </button>
        )}
        <button
          type="button"
          onClick={() => setRenaming((r) => !r)}
          aria-label={renaming ? "Cancel rename" : "Rename session"}
          title="Rename"
          className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-white/10 bg-white/5 text-xs hover:bg-white/10"
        >
          ✎
        </button>
        <button
          type="button"
          onClick={onToggle}
          aria-label={isExpanded ? "Hide scenes" : "Show scenes"}
          className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-white/10 bg-white/5 text-xs hover:bg-white/10"
        >
          {isExpanded ? "−" : "+"}
        </button>
        <button
          type="button"
          onClick={onDelete}
          aria-label="Delete session"
          title="Delete (undoable)"
          data-testid="session-delete-btn"
          className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-white/10 bg-white/5 text-xs text-white/60 hover:bg-white/15 hover:text-white"
        >
          ×
        </button>
        <button
          type="button"
          onClick={onExport}
          aria-label="Export session as JSON"
          title="Download as .json"
          data-testid="session-export-btn"
          className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-white/10 bg-white/5 text-xs text-white/60 hover:bg-white/15 hover:text-white"
        >
          ↓
        </button>
      </div>
      {isActive && (
        <p className="-mt-2 px-3 pb-2 text-[10px] uppercase tracking-widest text-white/70" aria-label="Currently active session">
          ● Active
        </p>
      )}
      {isExpanded && (
        <div className="border-t border-white/10 bg-black/30 p-2">
          {session.scenes.length === 0 ? (
            <p className="px-2 py-3 text-center text-xs text-white/50">No scenes yet.</p>
          ) : (
            [...session.scenes].reverse().map((scene) => (
              <div
                key={scene.id}
                className="flex items-start gap-2 rounded-lg p-2 hover:bg-white/5"
              >
                <button
                  type="button"
                  onClick={() => onSelectScene(scene.id)}
                  className="min-h-[32px] flex-1 text-left"
                >
                  <p className="line-clamp-2 text-xs leading-snug text-white/80">
                    {scene.prompt}
                  </p>
                  <p className="mt-0.5 text-[10px] text-white/40">
                    {new Date(scene.timestamp).toLocaleString()}
                  </p>
                </button>
                {/* QA4: replay button. Re-renders this exact
                    scene (same prompt + same seed) so the user
                    can revisit a favorite world. Distinguished
                    from tapping the prompt (which currently
                    does the same thing — both load the seed)
                    by giving it a clear icon. */}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    dreamBus.emit("dream:loadScene", {
                      prompt: scene.prompt,
                      seed: scene.seed,
                    });
                  }}
                  aria-label={`Replay "${scene.prompt}"`}
                  title="Replay this scene"
                  data-testid="scene-replay"
                  className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-xs text-white/40 hover:bg-white/10 hover:text-white"
                >
                  ↻
                </button>
                {/* QA6/F6: Memory Beacon. Re-paints the scene
                    with a "continuing forward" suffix so the
                    world keeps evolving from where the user
                    left it. Uses a fresh seed derived from
                    the original seed + a counter so the
                    *next* "continue" press is also different
                    from this one. The model's reset() call
                    (inside the loadScene handler) means this
                    produces a *new* world that is *adjacent*
                    to the original, not a literal continue —
                    but the prompt suffix nudges the new
                    scene in the right direction. */}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    const next = (scene.seed + 1) >>> 0;
                    dreamBus.emit("dream:loadScene", {
                      prompt: `${scene.prompt}, continuing forward`,
                      seed: next,
                    });
                  }}
                  aria-label={`Continue "${scene.prompt}" from here`}
                  title="Continue from here"
                  data-testid="scene-continue"
                  className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-xs text-white/40 hover:bg-white/10 hover:text-white"
                >
                  ➡
                </button>
                {/* QA13/F11: Scene Fork. Creates an
                    independent copy of the session up to
                    and including this scene. The original
                    is untouched, so the user can experiment
                    with the fork (delete scenes, try
                    different continuing prompts) without
                    polluting the source timeline. */}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onFork(scene.id);
                  }}
                  aria-label={`Fork "${scene.prompt}" into a new session`}
                  title="Fork from here"
                  data-testid="scene-fork"
                  className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-xs text-white/40 hover:bg-white/10 hover:text-white"
                >
                  ⑂
                </button>
                {/* QA5/F4: download-as-PNG. Fetches the
                    scene's `image_url` (the model's source
                    frame) and saves it to the user's device
                    via a temporary <a download> link. Uses
                    the same CORS-friendly pattern as the
                    share button — fetch as blob, then
                    objectURL it. */}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    void downloadScenePng(scene);
                  }}
                  aria-label={`Download "${scene.prompt}" as PNG`}
                  title="Download as PNG"
                  data-testid="scene-download"
                  className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-xs text-white/40 hover:bg-white/10 hover:text-white"
                >
                  ↓
                </button>
                {/* QA3: heart toggle. Favorited scenes show in
                    a separate section above the regular list
                    and survive across sessions. */}
                <button
                  type="button"
                  onClick={() => onToggleFavorite(scene.id)}
                  aria-label={scene.favorite ? "Unfavorite scene" : "Favorite scene"}
                  aria-pressed={!!scene.favorite}
                  data-testid="scene-favorite"
                  className={`grid h-9 w-9 shrink-0 place-items-center rounded-full text-xs hover:bg-white/10 ${
                    scene.favorite ? "text-white" : "text-white/40"
                  }`}
                >
                  {scene.favorite ? "♥" : "♡"}
                </button>
                <button
                  type="button"
                  onClick={() => onRemoveScene(scene.id)}
                  aria-label="Remove scene"
                  className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-xs text-white/50 hover:bg-white/15 hover:text-white"
                >
                  ×
                </button>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function timeAgo(t: number): string {
  const diff = Date.now() - t;
  const s = Math.floor(diff / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(t).toLocaleDateString();
}

// QA6/F4: Read my last dream. Uses the Web Speech API's
// `speechSynthesis` to read the user's last few saved scenes
// back to them. First tap starts reading; second tap stops.
// iOS Safari needs an explicit user gesture before
// speechSynthesis.speak() can play audio, which a tap on the
// sidebar button satisfies.
//
// We render nothing on browsers without speechSynthesis
// (older Android stock browsers, some WebViews).
function ReadLastDreamButton() {
  const store = useSessions();
  const [reading, setReading] = useState(false);
  const supported = typeof window !== "undefined" && "speechSynthesis" in window;
  if (!supported) return null;
  function start() {
    const synth = window.speechSynthesis;
    synth.cancel(); // clear any in-flight utterance
    const session = store.activeSession;
    if (!session || session.scenes.length === 0) {
      const u = new SpeechSynthesisUtterance("You haven't dreamed anything yet. Tap a chip below to begin.");
      u.rate = 0.95;
      u.pitch = 0.9;
      synth.speak(u);
      setReading(true);
      u.onend = () => setReading(false);
      return;
    }
    // Read the last 5 scenes, oldest first — like a recap.
    const scenes = [...session.scenes].slice(-5);
    let i = 0;
    function next() {
      if (i >= scenes.length) {
        // Closing summary.
        const closing = new SpeechSynthesisUtterance("End of dream.");
        closing.rate = 0.8;
        closing.pitch = 0.8;
        closing.onend = () => setReading(false);
        synth.speak(closing);
        return;
      }
      const scene = scenes[i++];
      const u = new SpeechSynthesisUtterance(`${scene.prompt}.`);
      u.rate = 0.95;
      u.pitch = 1.0;
      u.onend = next;
      u.onerror = () => setReading(false);
      synth.speak(u);
    }
    setReading(true);
    next();
  }
  function stop() {
    window.speechSynthesis.cancel();
    setReading(false);
  }
  return (
    <button
      type="button"
      onClick={reading ? stop : start}
      aria-label={reading ? "Stop narration" : "Read my last dream aloud"}
      aria-pressed={reading}
      data-testid="read-last-dream-btn"
      data-reading={reading ? "true" : "false"}
      className={[
        "grid h-9 w-9 place-items-center rounded-full border text-xs",
        reading
          ? "border-white bg-white/20 text-white"
          : "border-white/10 bg-white/5 text-white/55 hover:bg-white/10",
      ].join(" ")}
      title={reading ? "Stop narration" : "Read my last dream"}
    >
      {reading ? "■" : "🔊"}
    </button>
  );
}
