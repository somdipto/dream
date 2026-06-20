"use client";

import { useLingbot } from "@reactor-models/lingbot";

// The status badge surfaces the four-state connection machine:
//   disconnected → connecting → waiting → ready
//
// Every state is shown explicitly so the user sees the transitions
// rather than staring at an unexplained spinner.
const TONE: Record<string, { dot: string; label: string }> = {
  disconnected: { dot: "bg-zinc-500", label: "Disconnected" },
  connecting: { dot: "bg-amber-400 animate-pulse", label: "Connecting…" },
  waiting: { dot: "bg-amber-400 animate-pulse", label: "Waiting for GPU…" },
  ready: { dot: "bg-active", label: "Connected" },
};

export function StatusBadge() {
  const { status, lastError, connect, disconnect } = useLingbot();
  const tone = TONE[status] ?? TONE.disconnected;
  const idle = status === "disconnected";

  return (
    <div className="rounded-full border border-white/10 bg-black/40 px-3 py-1.5 backdrop-blur">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className={`h-2 w-2 rounded-full ${tone.dot}`} />
          <span className="text-xs font-medium text-white/90">{tone.label}</span>
        </div>
        {idle ? (
          <button
            onClick={() => connect()}
            className="rounded-full bg-white/15 px-2.5 py-0.5 text-[10px] font-medium text-white hover:bg-white/25"
          >
            Connect
          </button>
        ) : (
          <button
            onClick={() => disconnect()}
            className="rounded-full border border-white/10 px-2.5 py-0.5 text-[10px] text-white/70 hover:bg-white/10"
          >
            Disconnect
          </button>
        )}
      </div>

      {lastError && (
        <p className="mt-1 text-[10px] text-red-300">{lastError.message}</p>
      )}
    </div>
  );
}
