"use client";

import { useState } from "react";
import { useSessions } from "./SessionProvider";
import type { Session } from "../lib/session-types";
import { usePlatform } from "../hooks/usePlatform";

// Toggleable sidebar showing the user's saved sessions.
//
// Desktop: 320px fixed left rail. Hidden by default. The toggle button
//   sits in the top bar (passed in by the parent as `open`).
// Mobile: bottom sheet, swipe-up to expand. Toggle button in the top bar.
//
// When the panel is collapsed (desktop default), it has
// `pointer-events: none` so it doesn't intercept mouse-look on the
// canvas. The toggle button has `pointer-events: auto`.
//
// The list shows sessions sorted newest-first. Click a session →
// loadSession(id). Each session expands to show its scenes; each scene
// has a small "remove" button.

export interface SessionSidebarProps {
  open: boolean;
  onClose: () => void;
  onSelectScene?: (sessionId: string, sceneId: string) => void;
}

export function SessionSidebar({ open, onClose, onSelectScene }: SessionSidebarProps) {
  const platform = usePlatform();
  const store = useSessions();
  const [expanded, setExpanded] = useState<string | null>(null);

  const isDesktop = platform.isDesktop;
  const sorted = [...store.sessions].sort((a, b) => b.updatedAt - a.updatedAt);

  return (
    <>
      {/* Backdrop — only when open. Clicks close. */}
      {open && (
        <div
          className="fixed inset-0 z-30 bg-black/30 backdrop-blur-sm md:hidden"
          onClick={onClose}
        />
      )}

      {/* Sidebar panel. */}
      <aside
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
        // Desktop: only the panel itself (not the toggle) is non-blocking
        // when collapsed. The toggle is rendered separately.
        // Mobile: same — toggle is a separate fixed button.
        aria-hidden={!open}
      >
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
          <div>
            <p className="text-[10px] uppercase tracking-widest text-white/50">
              Your dreams
            </p>
            <p className="text-sm font-medium">{store.sessions.length} session{store.sessions.length === 1 ? "" : "s"}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close sessions"
            className="min-h-[36px] min-w-[36px] rounded-full border border-white/10 bg-white/5 px-3 text-xs text-white/80 hover:bg-white/10"
          >
            Close
          </button>
        </div>

        <div className="overflow-y-auto px-2 py-2" style={{ maxHeight: "calc(100vh - 64px)" }}>
          {sorted.length === 0 ? (
            <p className="px-3 py-8 text-center text-sm text-white/50">
              No saved dreams yet. Speak a scene and it will save here automatically.
            </p>
          ) : (
            sorted.map((s) => (
              <SessionCard
                key={s.id}
                session={s}
                isActive={s.id === store.activeSessionId}
                isExpanded={expanded === s.id}
                onToggle={() => setExpanded(expanded === s.id ? null : s.id)}
                onLoad={() => {
                  store.loadSession(s.id);
                  onClose();
                }}
                onDelete={() => store.deleteSession(s.id)}
                onRemoveScene={(sceneId) => store.removeScene(sceneId)}
                onSelectScene={(sceneId) => {
                  onSelectScene?.(s.id, sceneId);
                }}
              />
            ))
          )}
        </div>
      </aside>
    </>
  );
}

function SessionCard({
  session,
  isActive,
  isExpanded,
  onToggle,
  onLoad,
  onDelete,
  onRemoveScene,
  onSelectScene,
}: {
  session: Session;
  isActive: boolean;
  isExpanded: boolean;
  onToggle: () => void;
  onLoad: () => void;
  onDelete: () => void;
  onRemoveScene: (sceneId: string) => void;
  onSelectScene: (sceneId: string) => void;
}) {
  return (
    <div
      className={[
        "mb-2 overflow-hidden rounded-xl border",
        isActive ? "border-white/30 bg-white/10" : "border-white/10 bg-white/5",
      ].join(" ")}
    >
      <div className="flex items-start gap-2 p-3">
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
        <button
          type="button"
          onClick={onToggle}
          aria-label={isExpanded ? "Hide scenes" : "Show scenes"}
          className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-white/10 bg-white/5 text-xs hover:bg-white/10"
        >
          {isExpanded ? "−" : "+"}
        </button>
        <button
          type="button"
          onClick={onDelete}
          aria-label="Delete session"
          className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-white/10 bg-white/5 text-xs text-white/60 hover:bg-red-500/30 hover:text-white"
        >
          ×
        </button>
      </div>
      {isActive && (
        <p className="-mt-2 px-3 pb-2 text-[10px] uppercase tracking-widest text-emerald-300">
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
                <button
                  type="button"
                  onClick={() => onRemoveScene(scene.id)}
                  aria-label="Remove scene"
                  className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs text-white/50 hover:bg-red-500/30 hover:text-white"
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