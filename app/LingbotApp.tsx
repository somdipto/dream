"use client";

import { useCallback, useEffect, useState } from "react";
import { LingbotProvider, useLingbot } from "@reactor-models/lingbot";
import { Video } from "./components/Video";
import { StatusBadge } from "./components/StatusBadge";
import { CommandError } from "./components/CommandError";
import { VoiceDream } from "./components/VoiceDream";
import { GyroController } from "./components/GyroController";
import { useMotion } from "./hooks/useMotion";
import { useVoice } from "./hooks/useVoice";

async function fetchToken(): Promise<string> {
  const r = await fetch("/api/reactor/token");
  if (!r.ok) {
    const body = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Token fetch failed: ${r.status}`);
  }
  const { jwt } = (await r.json()) as { jwt: string };
  return jwt;
}

export function LingbotApp() {
  return (
    <LingbotProvider getJwt={fetchToken}>
      <DreamSurface />
    </LingbotProvider>
  );
}

function DreamSurface() {
  const { status, connect, disconnect, lastError } = useLingbot();
  const motion = useMotion();
  const voice = useVoice();
  const [hasBegun, setHasBegun] = useState(false);

  // iOS permission gate MUST be called inside the user-gesture click
  // handler — not after any `await` or `setState`. Safari silently
  // denies if the call happens outside the gesture window. We keep
  // `handleBegin` synchronous up to and including the call into
  // `requestPermission()`; the result is fire-and-forget.
  const handleBegin = useCallback(() => {
    // Synchronous first-line: invoke the iOS gate inside the gesture.
    if (motion.permission === "default") {
      void motion.requestPermission();
    }
    setHasBegun(true);
    if (status === "disconnected") {
      void connect();
    }
    // Lock to portrait so gyroscope axes don't flip on rotation.
    if (typeof screen !== "undefined" && "orientation" in screen) {
      try {
        (screen.orientation as any).lock?.("portrait");
      } catch {
        // ponytail: orientation lock can reject on iOS without PWA install.
      }
    }
  }, [motion, status, connect]);

  const handleReset = useCallback(() => {
    void disconnect();
    setHasBegun(false);
    voice.reset();
  }, [disconnect, voice]);

  // Auto-retry once on transient disconnect (hackathon wifi is flaky).
  useEffect(() => {
    if (status !== "disconnected" || !hasBegun || !lastError) return;
    const t = setTimeout(() => {
      void connect();
    }, 1500);
    return () => clearTimeout(t);
  }, [status, hasBegun, lastError, connect]);

  // Before Begin: friendly landing overlay.
  if (!hasBegun) {
    return (
      <main className="relative grid min-h-screen place-items-center bg-black p-6 text-white">
        <div className="max-w-sm text-center">
          <h1 className="text-2xl font-semibold tracking-tight">
            See your dreams in real
          </h1>
          <p className="mt-2 text-sm text-white/60">
            Speak a scene. Walk through it by tilting your phone.
          </p>
          <button
            onClick={handleBegin}
            className="mt-8 inline-flex items-center gap-2 rounded-full bg-white px-6 py-3 text-sm font-medium text-black hover:bg-white/90"
          >
            <MicIcon size={20} /> Begin
          </button>
          <p className="mt-6 text-[10px] uppercase tracking-wider text-white/40">
            Powered by Reactor · LingBot
          </p>
        </div>
      </main>
    );
  }

  // Connecting: brief overlay between Begin and Connected.
  if (status === "disconnected" || status === "connecting" || status === "waiting") {
    return (
      <main className="relative grid min-h-screen place-items-center bg-black p-6 text-white">
        <div className="max-w-sm text-center">
          <div className="mx-auto h-2 w-2 animate-pulse rounded-full bg-amber-400" />
          <p className="mt-4 text-sm text-white/80">
            {status === "disconnected"
              ? lastError
                ? `Couldn't connect: ${lastError.message}`
                : "Reconnecting…"
              : status === "connecting"
                ? "Connecting to Reactor…"
                : "Waiting for a GPU…"}
          </p>
          {lastError && (
            <button
              onClick={() => void connect()}
              className="mt-6 rounded-full bg-white/15 px-5 py-2 text-sm font-medium text-white hover:bg-white/25"
            >
              Try again
            </button>
          )}
          <button
            onClick={handleReset}
            className="mt-3 block w-full text-[10px] uppercase tracking-wider text-white/40 hover:text-white/60"
          >
            Back
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="relative min-h-screen bg-black text-white">
      {/* Video fills the screen as background. */}
      <div className="fixed inset-0 z-0">
        <Video />
      </div>

      {/* Top bar — connection state + reset. */}
      <div className="pointer-events-none fixed inset-x-0 top-0 z-20 flex items-start justify-between gap-3 p-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <div className="pointer-events-auto max-w-[70%]">
          <StatusBadge />
          <div className="mt-2">
            <CommandError />
          </div>
          {motion.permission === "denied" && (
            <p
              role="status"
              aria-live="polite"
              className="mt-2 rounded-full border border-white/10 bg-black/70 px-3 py-1 text-[10px] text-white/70 backdrop-blur"
            >
              Motion: off — use the D-pad below
            </p>
          )}
          {motion.permission === "unsupported" && (
            <p
              role="status"
              aria-live="polite"
              className="mt-2 rounded-full border border-white/10 bg-black/70 px-3 py-1 text-[10px] text-white/70 backdrop-blur"
            >
              Motion not supported on this device
            </p>
          )}
        </div>
        <button
          onClick={handleReset}
          aria-label="Start over"
          className="pointer-events-auto min-h-[44px] min-w-[44px] rounded-full border border-white/10 bg-black/40 px-3 py-1.5 text-xs text-white/80 backdrop-blur hover:bg-black/60"
        >
          Reset
        </button>
      </div>

      {/* Bottom — voice UI. */}
      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-20 flex justify-center p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <div className="w-full max-w-md">
          <VoiceDream />
        </div>
      </div>

      {/* Headless controllers — run while connected. */}
      <GyroController enabled={status === "ready"} voiceListening={voice.listening} />
    </main>
  );
}

function MicIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="3" width="6" height="12" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <line x1="12" y1="18" x2="12" y2="22" />
    </svg>
  );
}