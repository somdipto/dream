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
import { SessionSidebar } from "./components/SessionSidebar";
import { VRView } from "./components/VRView";
import { SessionProvider, useSessions } from "./components/SessionProvider";
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

// Brighter, hyper-realistic default desktop scene. "LiveVocs" and
// "GTLI" goal references in the original ask; we don't have those
// products so we push LingBot toward photo-real with vivid lighting
// cues baked into the prompt.
const DEFAULT_DESKTOP_PROMPT =
  "a sunlit alpine meadow at golden hour, wildflowers in the foreground, distant snow-capped peaks, warm soft sunlight, vivid colors, butterflies and bees, shallow depth of field, hyper-realistic, 8K, cinematic";

export function LingbotApp() {
  return (
    <SessionProvider>
      <LingbotProvider getJwt={fetchToken}>
        <DreamSurface />
      </LingbotProvider>
    </SessionProvider>
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
  const sessions = useSessions();
  const [hasBegun, setHasBegun] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [vrMode, setVrMode] = useState(false);
  const [pruneToast, setPruneToast] = useState<string | null>(null);

  // Show a non-blocking toast when localStorage is full and we prune.
  useEffect(() => {
    if (sessions.pruneNotice > 0) {
      setPruneToast("Storage full — pruned oldest saved sessions.");
      const t = setTimeout(() => setPruneToast(null), 4000);
      return () => clearTimeout(t);
    }
  }, [sessions.pruneNotice]);

  const handleBegin = useCallback(() => {
    if (platform.isMobile) {
      if (motion.permission === "default") {
        void motion.requestPermission();
      }
      if (voice.supported && !voice.listening) {
        try {
          voice.start();
        } catch {
          // fallback handled by VoiceDream
        }
      }
      if (typeof screen !== "undefined" && "orientation" in screen) {
        try {
          (screen.orientation as any).lock?.("portrait");
        } catch {
          // ignore
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
          {sessions.sessions.length > 0 && (
            <p className="mt-2 text-xs text-emerald-300">
              {sessions.sessions.length} saved dream{sessions.sessions.length === 1 ? "" : "s"} on this device.
            </p>
          )}
          <button
            onClick={handleBegin}
            data-testid="begin-btn"
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
      <CursorEmbed />
      {/* Video fills the screen as background. */}
      <div className="fixed inset-0 z-0">
        <Video />
      </div>

      {/* Sidebar — sits above the canvas. Toggle button is always visible. */}
      <SessionSidebar
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        onSelectScene={(sessionId, sceneId) => {
          // Painting a specific past scene = re-running its prompt.
          const s = sessions.sessions.find((x) => x.id === sessionId);
          const sc = s?.scenes.find((x) => x.id === sceneId);
          if (sc) {
            sessions.setActive(sessionId);
            // The Dream component re-runs the last scene on active-session
            // change. We forward the prompt via a custom event the
            // Dream component listens for.
            window.dispatchEvent(
              new CustomEvent("dream:loadScene", { detail: { prompt: sc.prompt, seed: sc.seed } }),
            );
          }
          setSidebarOpen(false);
        }}
      />

      {/* Top bar — connection state + session toggle + new + reset.
          Hidden in VR mode (the immersive view takes over). */}
      {!vrMode && (
        <div className="pointer-events-none fixed inset-x-0 top-0 z-20 flex items-start justify-between gap-3 p-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <div className="pointer-events-auto flex flex-col items-start gap-2">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setSidebarOpen(true)}
              aria-label="Open saved sessions"
              data-testid="sessions-btn"
              className="grid h-10 w-10 place-items-center rounded-full border border-white/10 bg-black/40 text-white/80 backdrop-blur hover:bg-black/60"
            >
              ☰
            </button>
            <StatusBadge />
          </div>
          <CommandError />
          {platform.isMobile && motion.permission === "denied" && (
            <p
              role="status"
              aria-live="polite"
              className="rounded-full border border-white/10 bg-black/70 px-3 py-1 text-[10px] text-white/70 backdrop-blur"
            >
              Motion: off — use the D-pad below
            </p>
          )}
          {platform.isMobile && motion.permission === "unsupported" && (
            <p
              role="status"
              aria-live="polite"
              className="rounded-full border border-white/10 bg-black/70 px-3 py-1 text-[10px] text-white/70 backdrop-blur"
            >
              Motion not supported on this device
            </p>
          )}
        </div>
        <div className="pointer-events-auto flex items-center gap-2">
          <button
            onClick={() => {
              // "New session" — keep the current world running, just
              // start a fresh journal entry. The next paint goes into
              // the new session.
              sessions.createSession();
            }}
            aria-label="Start a new session"
            data-testid="new-session-btn"
            className="rounded-full border border-emerald-400/40 bg-emerald-500/20 px-3 py-1.5 text-xs text-emerald-100 backdrop-blur hover:bg-emerald-500/30"
          >
            + New session
          </button>
          <button
            onClick={handleReset}
            aria-label="Start over"
            className="min-h-[40px] rounded-full border border-white/10 bg-black/40 px-3 py-1.5 text-xs text-white/80 backdrop-blur hover:bg-black/60"
          >
            Reset
          </button>
          {platform.isMobile && (
            <button
              onClick={() => setVrMode(true)}
              aria-label="Enter VR mode"
              data-testid="vr-btn"
              className="grid h-10 w-10 place-items-center rounded-full border border-violet-400/40 bg-violet-500/20 text-base text-violet-100 backdrop-blur hover:bg-violet-500/30"
            >
              ◐
            </button>
          )}
        </div>
      </div>
      )}

      {/* Bottom — voice UI on mobile, text + paint on desktop.
          Hidden in VR mode. */}
      {!vrMode && (
      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-20 flex justify-center p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <div className="w-full max-w-md">
          {platform.isMobile ? <VoiceDream /> : <DesktopDream />}
        </div>
      </div>
      )}

      {/* Headless controllers — run while connected. */}
      {platform.isMobile ? (
        <GyroController enabled={status === "ready"} voiceListening={voice.listening} />
      ) : (
        <>
          <DesktopController enabled={status === "ready"} />
          <DesktopDefaultScene
            enabled={status === "ready"}
            prompt={DEFAULT_DESKTOP_PROMPT}
            hasUserScenes={(sessions.activeSession?.scenes.length ?? 0) > 0}
          />
        </>
      )}

      {/* Prune toast */}
      {pruneToast && (
        <div className="pointer-events-none fixed left-1/2 top-20 z-50 -translate-x-1/2 rounded-full border border-amber-400/40 bg-amber-500/20 px-4 py-1.5 text-xs text-amber-100 shadow-lg backdrop-blur">
          {pruneToast}
        </div>
      )}

      {/* VR mode — fullscreen overlay. Renders two side-by-side
          lenses for stereoscopic viewing. Mobile-only (the toggle
          button is hidden on desktop). */}
      {vrMode && platform.isMobile && (
        <VRView open={vrMode} onClose={() => setVrMode(false)} />
      )}
    </main>
  );
}

// On desktop, paint the default scene once the world is ready, UNLESS
// the active session already has scenes (in which case the user has
// saved work to restore). Tuned for hyper-realism with a brighter,
// more vivid prompt.
function DesktopDefaultScene({
  enabled,
  prompt,
  hasUserScenes,
}: {
  enabled: boolean;
  prompt: string;
  hasUserScenes: boolean;
}) {
  const { setImage, setPrompt, start, uploadFile } = useLingbot();
  const sessions = useSessions();
  const ran = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    if (hasUserScenes) return; // user has a saved session — don't overwrite
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
        // Save the default as the first scene of the active session.
        sessions.addScene({ prompt, seed });
      } catch (e: any) {
        // non-fatal — if the backend is failing, still record the
        // user's intent so the session isn't empty.
        try {
          sessions.addScene({
            prompt,
            seed: Math.floor(Math.random() * 0xffffffff),
          });
        } catch {
          // ignore
        }
      }
    })();
  }, [enabled, prompt, hasUserScenes, setImage, setPrompt, start, uploadFile, sessions]);

  return null;
}

// Hide the system cursor on the canvas once the world is generating.
// The user wants a "Valorant / CSGO" embedded-cursor feel: when the
// generation is live, the OS cursor is invisible so the user sees only
// the painted world; when idle (no generation running, e.g. on a
// pre-Begin landing page) the cursor is restored.
//
// We use the "none" cursor value on the document body so the cursor
// also disappears over the video element itself, not just over the
// top-level UI.
function CursorEmbed() {
  const { status } = useLingbot();
  const [hide, setHide] = useState(false);
  useEffect(() => {
    setHide(status === "ready");
  }, [status]);
  useEffect(() => {
    if (typeof document === "undefined") return;
    if (hide) {
      document.documentElement.classList.add("cursor-hidden");
    } else {
      document.documentElement.classList.remove("cursor-hidden");
    }
    return () => {
      document.documentElement.classList.remove("cursor-hidden");
    };
  }, [hide]);
  return null;
}