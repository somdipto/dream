"use client";

import { useEffect, useState } from "react";
import { useLingbot } from "@reactor-models/lingbot";
import { dreamBus } from "../lib/event-bus";

// The status badge surfaces the four-state connection machine:
//   disconnected → connecting → waiting → ready
//
// The badge is now a pure indicator — it does NOT carry Connect/
// Disconnect buttons. The Reset button in the top bar already does
// both jobs (Disconnect goes through the same SDK teardown). Two
// buttons for the same action were confusing users.
//
// QA3: also shows the most recent paint duration. A user can
// see "Last paint: 4.2s" and infer the connection is healthy.
// The timer is reset on every successful paint via the
// `dream:paintDone` event (emitted by VoiceDream / DesktopDream
// when a paint completes).
//
// QA4: when the most recent paint FAILED, the duration is shown
// in red so the user can tell "model is fine but my last prompt
// was bad" (green dot, normal duration) from "model is choking"
// (green dot, stale red duration, possibly still climbing).
const TONE: Record<string, { dot: string; label: string; ring: string }> = {
  disconnected: { dot: "bg-zinc-500", label: "Disconnected", ring: "border-white/10" },
  connecting: { dot: "bg-amber-400 animate-pulse", label: "Connecting…", ring: "border-amber-400/30" },
  waiting: { dot: "bg-amber-400 animate-pulse", label: "Waiting for GPU…", ring: "border-amber-400/30" },
  ready: { dot: "bg-emerald-400", label: "Connected", ring: "border-emerald-400/30" },
};

export function StatusBadge() {
  const { status, lastError } = useLingbot();
  const tone = TONE[status] ?? TONE.disconnected;
  const [lastPaint, setLastPaint] = useState<{ ms: number; ok: boolean } | null>(null);
  useEffect(() => {
    return dreamBus.on("dream:paintDone", (e) => {
      setLastPaint({ ms: e.ms, ok: e.ok });
    });
  }, []);
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="status-badge"
      className={`rounded-full border bg-black/40 px-3 py-1.5 backdrop-blur ${tone.ring}`}
    >
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 rounded-full ${tone.dot}`} />
        <span className="text-xs font-medium text-white/90">{tone.label}</span>
        {lastPaint !== null && status === "ready" && (
          <span
            className={`text-[10px] ${lastPaint.ok ? "text-white/55" : "text-red-300"}`}
            data-testid="last-paint-ms"
            title={
              lastPaint.ok
                ? "Time to render the most recent scene"
                : "Most recent paint failed"
            }
          >
            · {(lastPaint.ms / 1000).toFixed(1)}s
          </span>
        )}
      </div>
      {lastError && (
        <p className="mt-1 max-w-[14rem] truncate text-[10px] text-red-300" title={lastError.message}>
          {lastError.message}
        </p>
      )}
    </div>
  );
}
