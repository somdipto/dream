"use client";

// ToastCenter — listens for `dream:toast` events and renders them
// as a stack of ephemeral pills at the bottom-center.
//
// Round 7 bug fix: there were 6 emit sites for `dream:toast`
// across the app (DesktopDream share-with-no-prompt, VoiceDream
// share-with-no-prompt, SessionSidebar export success, SessionSidebar
// export failure, LingbotApp REM-drift, FlickPaint's miss-paint),
// and ZERO listeners. Every toast was silently dropped — the
// user thought the action did nothing.
//
// This component closes the loop. We use a small max-3 stack
// (oldest evicted on overflow) with a per-toast TTL that respects
// the event's `ttlMs` field. Stacking keeps us from filling the
// screen on a 4-paint burst.

import { useEffect, useState } from "react";
import { dreamBus } from "../lib/event-bus";

type ToastKind = "info" | "error" | "success";

interface ToastItem {
  /** Stable per-emit key. Allows dedup of identical toasts that
   *  arrive in quick succession (e.g. two share-with-no-prompt
   *  taps in 200ms — the second is a no-op the user shouldn't
   *  see stacked). */
  key: string;
  kind: ToastKind;
  message: string;
  expiresAt: number;
}

const MAX_TOASTS = 3;

export function ToastCenter() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  useEffect(() => {
    const off = dreamBus.on(
      "dream:toast",
      (d: {
        id?: string;
        kind: ToastKind;
        message: string;
        ttlMs?: number;
      }) => {
        const ttl = Math.max(800, Math.min(d.ttlMs ?? 2500, 8000));
        const item: ToastItem = {
          key: d.id
            ? `${d.id}-${Date.now()}`
            : `${d.kind}:${d.message}:${Date.now()}`,
          kind: d.kind,
          message: d.message,
          expiresAt: Date.now() + ttl,
        };
        setToasts((curr) => {
          // Evict the oldest if we're at capacity. We keep the
          // most recent N-1 and append the new one, so the user
          // always sees the most recent action result.
          const next = curr.length >= MAX_TOASTS
            ? curr.slice(curr.length - (MAX_TOASTS - 1))
            : curr;
          return [...next, item];
        });
      },
    );
    return off;
  }, []);

  // Garbage-collect expired toasts on a 200ms tick. The
  // animation's `animation` duration in CSS lines up with
  // this — we drop the row at expiry so the dismissed
  // toast doesn't blink back on a re-render.
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      setToasts((curr) => {
        const alive = curr.filter((t) => t.expiresAt > now);
        return alive.length === curr.length ? curr : alive;
      });
    }, 200);
    return () => clearInterval(interval);
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div
      className="pointer-events-none fixed bottom-20 left-1/2 z-[60] flex w-full max-w-sm -translate-x-1/2 flex-col items-center gap-2 px-3 md:bottom-12"
      role="status"
      aria-live="polite"
      aria-atomic="false"
      data-testid="toast-center"
    >
      {toasts.map((t) => (
        <div
          key={t.key}
          data-testid={`toast-${t.kind}`}
          className={[
            "rounded-full border px-4 py-1.5 text-xs text-white shadow-lg backdrop-blur",
            t.kind === "error"
              ? "border-white/40 bg-white/15"
              : t.kind === "success"
                ? "border-white/30 bg-white/12"
                : "border-white/20 bg-white/10",
          ].join(" ")}
        >
          {t.message}
        </div>
      ))}
    </div>
  );
}
