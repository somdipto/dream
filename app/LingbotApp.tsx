"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { LingbotProvider, useLingbot } from "@reactor-models/lingbot";
import { Video } from "./components/Video";
import { StatusBadge } from "./components/StatusBadge";
import { CommandError } from "./components/CommandError";
import { VoiceDream } from "./components/VoiceDream";
import { GyroController } from "./components/GyroController";
import { DesktopController } from "./components/DesktopController";
import { DesktopDream } from "./components/DesktopDream";
import { useMotion } from "./hooks/useMotion";
import { useVoice } from "./hooks/useVoice";
import { usePlatform } from "./hooks/usePlatform";
import { generateSeedImage } from "./lib/seed-image";
import { composeScenePrompt } from "./lib/scene-composer";

async function fetchToken(): Promise<string> {
  const r = await fetch("/api/reactor/token");
  if (!r.ok) {
    const body = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Token fetch failed: ${r.status}`);
  }
  const { jwt } = (await r.json()) as { jwt: string };
  return jwt;
}

const DEFAULT_DESKTOP_PROMPT =
  "a misty pine forest at dawn, soft golden light, low fog between the trees, a quiet path leading forward";

export function LingbotApp() {
  return (
    <LingbotProvider getJwt={fetchToken}>
      <DreamSurface />
    </LingbotProvider>
  );
}

// A surface that picks its controls by platform:
//   - desktop  → keyboard + mouse + text input. Default scene paints
//                itself on connect so the screen is never black.
//   - mobile   → gyroscope + voice. Mic auto-arms, scene starts on
//                the first spoken phrase.
function DreamSurface() {
  const { status, connect, disconnect, lastError } = useLingbot();
  const platform = usePlatform();
  const motion = useMotion();
  const voice = useVoice();
  const [hasBegun, setHasBegun] = useState(false);

  // iOS permission gate MUST be called inside the user-gesture click
  // handler — not after any `await` or `setState`. Safari silently
  // denies if the call happens outside the gesture window.
  const handleBegin = useCallback(() => {
    if (platform.isMobile) {
      if (motion.permission === "default") {
        void motion.requestPermission();
      }
      if (voice.supported && !voice.listening) {
        try {
          voice.start();
        } catch {
          // ponytail: iOS may reject the gesture-scoped start. VoiceDream
          // has a fallback effect that starts the recogniser once `ready`.
        }
      }
      if (typeof screen !== "undefined" && "orientation" in screen) {
        try {
          (screen.orientation as any).lock?.("portrait");
        } catch {
          // ponytail: orientation lock can reject on iOS without PWA install.
        }
      }
    }
    setHasBegun(true);
    if (status === "disconnected") {
      void connect();
    }
  }, [platform.isMobile, motion, voice, status, connect]);

  const handleReset = useCallback(() => {
    if (platform.isMobile) {
      voice.stop();
    }
    void disconnect();
    setHasBegun(false);
    if (platform.isMobile) {
      voice.reset();
    }
  }, [disconnect, voice, platform.isMobile]);

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
            Speak your dream into the world.
          </h1>
          <p className="mt-2 text-sm text-white/60">
            {platform.isDesktop
              ? "A first scene paints itself. Then describe a new dream, or walk with W A S D and look with the mouse."
              : "Say a scene out loud. Tilt to walk through it. Every phrase you speak mutates the world in place."}
          </p>
          <button
            onClick={handleBegin}
            className="mt-8 inline-flex items-center gap-2 rounded-full bg-white px-6 py-3 text-sm font-medium text-black hover:bg-white/90"
          >
            Begin
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
          {platform.isMobile && motion.permission === "denied" && (
            <p
              role="status"
              aria-live="polite"
              className="mt-2 rounded-full border border-white/10 bg-black/70 px-3 py-1 text-[10px] text-white/70 backdrop-blur"
            >
              Motion: off — use the D-pad below
            </p>
          )}
          {platform.isMobile && motion.permission === "unsupported" && (
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

      {/* Bottom — voice UI on mobile, text + paint on desktop. */}
      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-20 flex justify-center p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <div className="w-full max-w-md">
          {platform.isMobile ? <VoiceDream /> : <DesktopDream />}
        </div>
      </div>

      {/* Headless controllers — run while connected. */}
      {platform.isMobile ? (
        <GyroController enabled={status === "ready"} voiceListening={voice.listening} />
      ) : (
        <>
          <DesktopController enabled={status === "ready"} />
          <DesktopDefaultScene enabled={status === "ready"} prompt={DEFAULT_DESKTOP_PROMPT} />
        </>
      )}
    </main>
  );
}

// On desktop, paint the default scene once the world is ready. This
// kills the "complete darkness" problem: the user clicks Begin, the
// world connects, and within ~5 s a misty forest fills the screen.
function DesktopDefaultScene({ enabled, prompt }: { enabled: boolean; prompt: string }) {
  const { setImage, setPrompt, start, uploadFile } = useLingbot();
  const ran = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    if (ran.current) return;
    ran.current = true;
    void (async () => {
      try {
        const seed = Math.floor(Math.random() * 0xffffffff);
        const blob = await generateSeedImage({ seed });
        const ref = await uploadFile(blob, { name: `seed-${seed}.png` });
        await setImage({ image: ref });
        await setPrompt({ prompt: composeScenePrompt({ text: prompt, isFirst: true }) });
        await start();
      } catch {
        // ponytail: a default-scene failure is non-fatal — the user
        // can still type a prompt to paint.
      }
    })();
  }, [enabled, prompt, setImage, setPrompt, start, uploadFile]);

  return null;
}