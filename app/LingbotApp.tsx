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
import { VirtualJoystick } from "./components/VirtualJoystick";
import { SessionProvider, useSessions } from "./components/SessionProvider";
import { useMotion } from "./hooks/useMotion";
import { useVoice } from "./hooks/useVoice";
import { usePlatform } from "./hooks/usePlatform";
import { generateSeedImage } from "./lib/seed-image";
import { composeScenePrompt } from "./lib/scene-composer";
import { dailyDream, dailyDreamTitle } from "./lib/curated-scenes";
import { dreamBus } from "./lib/event-bus";
import { classifyReactorError } from "./lib/reactor-errors";
import { bustNextToken, consumeBust } from "./lib/token-bust";

async function fetchToken(): Promise<string> {
  // M9.8: respect the one-shot bust flag so the Lingbot SDK doesn't
  // reuse a 6-hour JWT cached for an exhausted key. The flag is set
  // by the 402-recovery flow in ReactorErrorScreen before connect()
  // is called again.
  const bust = consumeBust();
  const url = bust ? "/api/reactor/token?nocache=1" : "/api/reactor/token";
  const r = await fetch(url, bust ? { cache: "no-store" } : undefined);
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
  // Deduped: ignore further increments while a toast is already
  // showing, so a permanently-over-quota user doesn't get a fresh
  // toast every save. (Audit bug #22.)
  useEffect(() => {
    if (sessions.pruneNotice > 0 && !pruneToast) {
      setPruneToast("Storage full — pruned oldest saved sessions.");
      const t = setTimeout(() => setPruneToast(null), 4000);
      return () => clearTimeout(t);
    }
  }, [sessions.pruneNotice, pruneToast]);

  const handleBegin = useCallback(() => {
    if (platform.isMobile) {
      if (motion.permission === "default") {
        void motion.requestPermission();
      }
      if (voice.supported && !voice.listening) {
        try {
          voice.start();
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn("[dream] voice.start() during Begin:", e);
        }
      }
      if (typeof screen !== "undefined" && "orientation" in screen) {
        try {
          (screen.orientation as any).lock?.("portrait");
        } catch {
          // iOS Safari throws on user-preference locks; harmless.
        }
      }
    }
    setHasBegun(true);
    if (status === "disconnected") {
      void connect();
    }
    // Daily Dream auto-pick: on a fresh device (no saved sessions),
    // surface today's curated scene so the user sees something
    // interesting the moment they tap Begin. Skip if there's a share
    // URL in flight (readDreamFromUrl takes precedence) or if the
    // user has saved sessions they'd prefer to revisit.
    if (sessions.hydrated && sessions.sessions.length === 0) {
      if (typeof window !== "undefined" && !window.location.search.includes("d=")) {
        const dream = dailyDream();
        // Defer one tick so the Dream component has time to mount
        // its event-bus listener.
        setTimeout(() => {
          // Create a daily-dream session so the user's journal
          // starts with something to revisit.
          const id = sessions.createSession({
            title: dailyDreamTitle(),
            seed: { prompt: dream.prompt, seed: dream.seed },
          });
          void id;
          dreamBus.emit("dream:loadScene", { prompt: dream.prompt, seed: dream.seed });
        }, 200);
      }
    }
    // Depend on stable primitives only. `motion` and `voice` are objects
    // whose identity changes per render; pinning them caused
    // handleBegin to be a new function every render, which forced the
    // Begin button to re-render and re-bind listeners unnecessarily.
  }, [
    platform.isMobile,
    motion.permission,
    motion.requestPermission,
    voice.supported,
    voice.listening,
    voice.start,
    status,
    connect,
    sessions.hydrated,
    sessions.sessions.length,
    sessions.createSession,
  ]);

  const handleReset = useCallback(() => {
    // Order matters: await the voice teardown BEFORE disconnect so
    // the SDK teardown doesn't race the recogniser's audio handle.
    // Without the await, a slow Android Chrome can hand a still-
    // active mic to the next voice.start() and produce a
    // `NotAllowedError` (audit bug #17).
    const teardown = async () => {
      if (platform.isMobile) {
        try {
          await voice.stop();
        } catch {
          // best-effort
        }
        voice.reset();
      }
      try {
        await disconnect();
      } catch {
        // best-effort
      }
      setHasBegun(false);
    };
    void teardown();
  }, [disconnect, voice.stop, voice.reset, platform.isMobile]);

  // Auto-retry once on transient disconnect (hackathon wifi is flaky).
  // The previous version reset `reconnectingRef.current = false` in
  // the cleanup path, which fired on every dep change. If `status`
  // flipped `disconnected → connecting` mid-timeout, the cleanup
  // cleared the ref and a subsequent disconnect would refire the
  // reconnect — breaking the "one reconnect per disconnect" guarantee.
  // We now only clear the ref on success (status → ready) or on
  // explicit hasBegun change.
  const reconnectingRef = useRef(false);
  useEffect(() => {
    if (status === "ready") {
      // Successful transition — allow a future disconnect to retry.
      reconnectingRef.current = false;
      return;
    }
    if (status !== "disconnected" || !hasBegun || !lastError) return;
    if (reconnectingRef.current) return;
    reconnectingRef.current = true;
    const t = setTimeout(() => {
      void connect();
    }, 1500);
    return () => clearTimeout(t);
  }, [status, hasBegun, lastError, connect]);

  // M9.11: "stuck" detection — if the SDK is taking longer than 8s
  // to either connect or surface an error, give the user an escape
  // hatch to manually rotate to a fresh key. This is the proactive
  // counterpart to the 402 error screen's "Try a different key"
  // button — for the case where the API isn't returning a
  // classified error at all, just hanging.
  const connectingSinceRef = useRef<number | null>(null);
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    const isConnectingLike =
      status === "connecting" || status === "waiting" || status === "disconnected";
    if (isConnectingLike && hasBegun) {
      if (connectingSinceRef.current === null) {
        connectingSinceRef.current = Date.now();
      }
      const t = setTimeout(() => setStuck(true), 8000);
      return () => clearTimeout(t);
    }
    // Successful connection or user backed out — clear stuck flag.
    connectingSinceRef.current = null;
    setStuck(false);
    return;
  }, [status, hasBegun]);

  const onTryDifferentKey = useCallback(() => {
    // M9.8 bust flag + reconnect. The cached 6-hour JWT (if any) is
    // skipped, so the SDK mints a fresh token from the next healthy
    // key in the M9.7 server pool.
    bustNextToken();
    void connect();
  }, [connect]);

  // Before Begin: friendly landing overlay. Pure black per the
  // M9.6 design pass — the user prefers a clean, quiet landing
  // surface. The aurora gradient still lives on the *connecting*
  // interstitial (see below) so the "hard black screen" bug
  // reported in M8.4 stays fixed: the user never sees a black
  // surface while the SDK is actively trying to connect.
  if (!hasBegun) {
    return (
      <main className="relative grid min-h-screen place-items-center overflow-hidden bg-black p-6 text-white">
        {/* Recovery banner — surfaces if the previous storage blob was
            unreadable. Gives the user a chance to restore before we
            silently lose the journal. (Audit bug #30.)
            The × button now requires a confirm tap before discarding
            so the user doesn't accidentally nuke their recoverable
            data with a single misclick. */}
        {sessions.recoveryNotice && (
          <div
            role="alert"
            aria-live="assertive"
            className="fixed inset-x-3 top-3 z-50 flex justify-center"
          >
            <div className="flex max-w-md items-center gap-3 rounded-2xl border border-amber-400/40 bg-amber-500/15 px-4 py-3 text-xs text-amber-100 shadow-2xl backdrop-blur">
              <span className="flex-1">
                We couldn't read your saved journal. The last snapshot was
                preserved — tap Restore to bring it back.
              </span>
              <button
                type="button"
                onClick={() => {
                  if (
                    window.confirm(
                      "Discard the recoverable snapshot? This can't be undone.",
                    )
                  ) {
                    sessions.dismissRecovery();
                  }
                }}
                className="rounded-full border border-amber-400/30 px-3 py-1 text-amber-100 hover:bg-amber-500/20"
                data-testid="recovery-discard-btn"
              >
                Discard
              </button>
              <RestoreButton sessions={sessions} />
            </div>
          </div>
        )}
        <div className="max-w-sm text-center">
          <h1 className="text-2xl font-semibold tracking-tight">
            Speak your dream into the world.
          </h1>
          <p className="mt-2 text-sm text-white/60">
            {platform.isDesktop
              ? "A first scene paints itself. Then describe a new dream, or walk with W A S D and look with the mouse."
              : "Say a scene out loud. Tilt to walk through it. Every phrase you speak mutates the world in place."}
          </p>
          {/* Daily Dream — a deterministic curated pick from today's
              date. Surfaces as a "today's pick" chip below the
              description so the user knows what they'll see first. */}
          {sessions.sessions.length === 0 && (
            <div className="mt-5 inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-3 py-1.5 text-[11px] text-white/80">
              <span aria-hidden="true">☀</span>
              <span>
                Today's dream · {dailyDream().emoji} {dailyDream().id.replace(/-/g, " ")}
              </span>
            </div>
          )}
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

  // Top bar + sidebar are hoisted here so they remain reachable on
  // every post-Begin state — including the connecting-error overlay.
  // Before this fix, when Reactor returned 402 (credits_depleted) the
  // early-return for status==="disconnected" hid the entire topbar,
  // so the user had no way to open the journal, start a new session,
  // or load a previously-painted scene while offline. The sidebar
  // works offline because sessions live in localStorage.
  const topbar = !vrMode ? (
    <>
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
        <div className="pointer-events-auto flex flex-wrap items-center justify-end gap-2">
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
            {platform.isMobile ? "+ New" : "+ New session"}
          </button>
          <button
            onClick={handleReset}
            aria-label="Start over"
            data-testid="reset-btn"
            className="min-h-[40px] rounded-full border border-white/10 bg-black/40 px-3 py-1.5 text-xs text-white/80 backdrop-blur hover:bg-black/60"
          >
            {platform.isMobile ? "↻" : "Reset"}
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
    </>
  ) : null;

  const sidebar = (
    <SessionSidebar
      open={sidebarOpen}
      onClose={() => setSidebarOpen(false)}
      onSelectScene={(sessionId, sceneId) => {
        // Painting a specific past scene = re-running its prompt.
        const s = sessions.sessions.find((x) => x.id === sessionId);
        const sc = s?.scenes.find((x) => x.id === sceneId);
        if (sc) {
          // First, ask any in-flight paint to short-circuit so the
          // in-progress scene doesn't end up in the wrong journal
          // entry after `setActive` flips the active session.
          dreamBus.emit("dream:abortPaint", {});
          sessions.setActive(sessionId);
          // The Dream component re-runs the last scene on active-session
          // change. We forward the prompt via a typed event bus that
          // only our own modules can emit on — no global window event
          // for browser extensions to hijack.
          dreamBus.emit("dream:loadScene", { prompt: sc.prompt, seed: sc.seed });
        }
        setSidebarOpen(false);
      }}
      onPickCurated={(s) => {
        // Curated gallery: also dispatch the same load event so the
        // current Dream component re-paints with the curated seed.
        dreamBus.emit("dream:abortPaint", {});
        dreamBus.emit("dream:loadScene", { prompt: s.prompt, seed: s.seed });
      }}
    />
  );

  // Connecting: brief overlay between Begin and Connected. We track
  // a "has begun connecting" flag so the initial 100ms post-Begin
  // render doesn't flash a "disconnected" overlay.
//
// Bug fix: this used to be a hard `bg-black` page. That read as
// "broken app" the moment a real user hit Begin, because the SDK
// takes 5-15 seconds to actually connect. We now mirror the
// Video.tsx aurora background so the user sees a beautiful animated
// gradient while waiting, not a black void.
  if (status === "disconnected" || status === "connecting" || status === "waiting") {
    // If we have a classified error (a real Reactor-side failure,
    // not just a transient blip), render the dedicated error screen.
    // The classifier turns raw JSON like
    //   "Failed to create session: 402 {\"error\":\"credits_depleted\"..."
    // into a typed reason + short message + CTA.
    const classified =
      status === "disconnected" && lastError
        ? classifyReactorError(lastError.message)
        : null;
    const isKnownError = classified && classified.reason !== "unknown";
    // Aurora is shown ONLY while the SDK is actively trying to
    // connect (no classified error). On a terminal error, fall back
    // to a quiet black surface so the user can focus on the
    // message and CTA — the design pass in M9.6 prefers that over
    // a busy gradient behind the error text.
    const showAurora = !isKnownError;
    return (
      <>
        {topbar}
        {sidebar}
        <main className="relative grid min-h-screen place-items-center overflow-hidden bg-black p-6 text-white">
          {/* Aurora background — same gradient as Video.tsx so the
              transition from connecting → playing is seamless, with
              no hard black cut. (M8.4 bug fix; only rendered while
              we're actively connecting — see showAurora above.) */}
          {showAurora && (
            <div
              className="pointer-events-none absolute inset-0 animate-[aurora-shift_18s_ease-in-out_infinite] bg-[radial-gradient(ellipse_at_top_left,rgba(99,102,241,0.55),transparent_55%),radial-gradient(ellipse_at_bottom_right,rgba(236,72,153,0.45),transparent_55%),radial-gradient(ellipse_at_top_right,rgba(34,211,238,0.40),transparent_55%),radial-gradient(ellipse_at_bottom_left,rgba(168,85,247,0.40),transparent_55%)] bg-[length:200%_200%]"
              aria-hidden="true"
              data-testid="connect-aurora"
            />
          )}
          {isKnownError && classified ? (
            <ReactorErrorScreen
              classified={classified}
              onRetry={() => void connect()}
              onBack={handleReset}
            />
          ) : (
            <div className="relative max-w-sm text-center">
              <div className="mx-auto h-2 w-2 animate-pulse rounded-full bg-amber-400" />
              <p className="mt-4 text-sm text-white/85">
                {status === "disconnected"
                  ? lastError
                    ? "Couldn't connect — try again in a moment."
                    : "Reconnecting…"
                  : status === "connecting"
                    ? "Connecting to Reactor…"
                    : "Waiting for a GPU…"}
              </p>
              <p className="mt-1 text-xs text-white/55">
                This usually takes 5–15 seconds.
              </p>
              {lastError && (
                <button
                  onClick={() => void connect()}
                  className="mt-6 rounded-full bg-white/15 px-5 py-2 text-sm font-medium text-white hover:bg-white/25"
                >
                  Try again
                </button>
              )}
              {!lastError && stuck && (
                <button
                  type="button"
                  onClick={onTryDifferentKey}
                  data-testid="connect-stuck-rotate-key"
                  className="mt-6 inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/5 px-5 py-2 text-xs font-medium text-white/85 hover:bg-white/15"
                >
                  Try a different key
                </button>
              )}
              <button
                onClick={handleReset}
                className="mt-3 block w-full text-[10px] uppercase tracking-wider text-white/45 hover:text-white/70"
              >
                Back
              </button>
            </div>
          )}
        </main>
      </>
    );
  }

  return (
    <main className="relative min-h-screen bg-black text-white">
      {topbar}
      {sidebar}
      <CursorEmbed />
      {/* Video fills the screen as background. */}
      <div className="fixed inset-0 z-0">
        <Video />
      </div>

      {/* Virtual joystick fallback — rendered ABOVE the video and
          BELOW the top/bottom bars. Only shown on mobile when motion
          permission was denied (or is unsupported). The user can
          drag the screen to look and drag down to walk forward. */}
      {platform.isMobile &&
        !vrMode &&
        (motion.permission === "denied" || motion.permission === "unsupported") && (
          <VirtualJoystick enabled={status === "ready"} />
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
      {platform.isMobile && !vrMode ? (
        <GyroController enabled={status === "ready"} voiceListening={voice.listening} />
      ) : !platform.isMobile ? (
        <>
          <DesktopController enabled={status === "ready"} />
          <DesktopDefaultScene
            enabled={status === "ready"}
            prompt={DEFAULT_DESKTOP_PROMPT}
            hasUserScenes={(sessions.activeSession?.scenes.length ?? 0) > 0}
          />
        </>
      ) : null}

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
        // Try the upload twice with a 2s gap. Reactor's upload
        // slot is occasionally sticky; a retry almost always
        // succeeds where the first call hung. We can't safely
        // paint without an anchor image (Reactor rejects start()
        // with "No image set") so we abort the auto-paint if both
        // attempts fail.
        let ref: Awaited<ReturnType<typeof uploadFile>> | null = null;
        for (let attempt = 0; attempt < 2 && !ref; attempt++) {
          const uploadPromise = blob ? uploadFile(blob, { name: `seed-${seed}.png` }) : Promise.resolve(null);
          const uploadTimeout = new Promise<null>((resolve) =>
            setTimeout(() => resolve(null), 4000),
          );
          ref = (await Promise.race([uploadPromise, uploadTimeout])) as Awaited<ReturnType<typeof uploadFile>> | null;
          if (!ref && attempt === 0) {
            await new Promise<void>((resolve) => setTimeout(resolve, 2000));
          }
        }
        if (!ref) {
          // eslint-disable-next-line no-console
          console.warn("[dream] default scene seed upload failed twice — aborting auto-paint, waiting for user input");
          return;
        }
        await setImage({ image: ref });
        // Wait for image_accepted up to 6s. If it never arrives,
        // skip the start to avoid Reactor's "No image set" error.
        // Wait for the imageReady callback the store wires up.
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
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
// Inline component for the recovery-banner Restore button. Shows a
// spinner while parsing the corrupt blob (synchronous parse, can
// take >100 ms on devices with many large scenes) and disables the
// button so a frustrated user can't double-tap.
function RestoreButton({
  sessions,
}: {
  sessions: ReturnType<typeof useSessions>;
}) {
  const [restoring, setRestoring] = useState(false);
  return (
    <button
      type="button"
      disabled={restoring}
      onClick={() => {
        if (restoring) return;
        setRestoring(true);
        // Restore synchronously today, but defer one microtask so
        // React has a chance to commit the disabled state before the
        // parse blocks the main thread.
        queueMicrotask(() => {
          try {
            sessions.restoreBackup();
          } finally {
            setRestoring(false);
          }
        });
      }}
      className="flex items-center justify-center gap-2 rounded-full bg-amber-300 px-3 py-1 font-medium text-amber-950 hover:bg-amber-200 disabled:cursor-not-allowed disabled:opacity-60"
      data-testid="recovery-restore-btn"
    >
      {restoring && (
        <span
          aria-hidden="true"
          className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-amber-950/30 border-t-amber-950"
        />
      )}
      {restoring ? "Restoring…" : "Restore"}
    </button>
  );
}

// Full-screen error overlay rendered when Reactor returns a typed
// failure (e.g. 402 credits_depleted, 401 bad API key, 503 down).
// The raw error message used to be dumped here as
//   "Couldn't connect: Failed to create session: 402 {json}"
// — unreadable to a real user. We now classify the message and
// show a clear headline + body + the right CTA.
//
// The Back button returns the user to the Begin overlay, which
// keeps the journal sidebar reachable offline (sessions live in
// localStorage, not in Reactor).
function ReactorErrorScreen({
  classified,
  onRetry,
  onBack,
}: {
  classified: import("./lib/reactor-errors").ClassifiedReactorError;
  onRetry: () => void;
  onBack: () => void;
}) {
  // The credits_depleted CTA points at the dashboard and should
  // open in a new tab (we don't want to navigate away from the
  // app entirely — the user may want to come back and replay
  // their journal).
  const ctaIsExternal = !!classified.ctaHref;
  const ctaOnClick = classified.ctaHref
    ? () => window.open(classified.ctaHref!, "_blank", "noopener,noreferrer")
    : () => {
        // M9.8: a non-credits-depleted retry may be reusing a stale
        // cached JWT, especially if the key was just rotated. Bust
        // the cache so the next token mint hits Reactor fresh.
        bustNextToken();
        onRetry();
      };

  // For credits_depleted, offer a secondary "try a different key"
  // path that doesn't require the user to wait for the dashboard
  // round-trip. The server's key pool (M9.7) handles the rotation
  // transparently — we just need to bust the cached JWT.
  const showFallbackKeyRetry =
    classified.reason === "credits_depleted";
  const onFallbackKey = () => {
    bustNextToken();
    onRetry();
  };
  return (
    <div
      role="alert"
      aria-live="assertive"
      className="relative max-w-md text-center"
      data-testid={`reactor-error-${classified.reason}`}
    >
      <div className="mx-auto grid h-12 w-12 place-items-center rounded-full border border-white/15 bg-white/5">
        <span aria-hidden="true" className="text-2xl">
          {classified.reason === "credits_depleted" ? "✕" : "!"}
        </span>
      </div>
      <h1 className="mt-5 text-2xl font-semibold tracking-tight">
        {classified.title}
      </h1>
      <p className="mt-3 text-sm leading-relaxed text-white/70">
        {classified.body}
      </p>
      {classified.ctaLabel && (
        <button
          type="button"
          onClick={ctaOnClick}
          className="mt-7 inline-flex items-center gap-2 rounded-full bg-white px-6 py-2.5 text-sm font-medium text-black hover:bg-white/90"
        >
          {classified.ctaLabel}
          {ctaIsExternal && (
            <span aria-hidden="true" className="text-xs">↗</span>
          )}
        </button>
      )}
      {showFallbackKeyRetry && (
        <button
          type="button"
          onClick={onFallbackKey}
          className="mt-3 inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-5 py-2 text-xs font-medium text-white/85 hover:bg-white/10"
          data-testid="reactor-error-try-fallback"
        >
          Try a different key
        </button>
      )}
      <button
        type="button"
        onClick={onBack}
        className="mt-4 block w-full text-[10px] uppercase tracking-wider text-white/45 hover:text-white/70"
      >
        Back to start
      </button>
    </div>
  );
}

// We use the "none" cursor value on the document body so the cursor
// also disappears over the video element itself, not just over the
// top-level UI.
function CursorEmbed() {
  const { status } = useLingbot();
  const [hide, setHide] = useState(false);
  // Ref-guarded: only remove the class on cleanup if *we* added it.
  // Without this, if the component remounts with hide=false while a
  // previous mount had hide=true, the previous cleanup removes the
  // class — but the new mount's effect hasn't run yet, so there's a
  // visible flash where the cursor is hidden but nothing in the
  // active component wants it hidden.
  const appliedRef = useRef(false);
  useEffect(() => {
    setHide(status === "ready");
  }, [status]);
  useEffect(() => {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    if (hide) {
      root.classList.add("cursor-hidden");
      appliedRef.current = true;
    } else {
      root.classList.remove("cursor-hidden");
      appliedRef.current = false;
    }
    return () => {
      if (appliedRef.current) {
        root.classList.remove("cursor-hidden");
        appliedRef.current = false;
      }
    };
  }, [hide]);
  return null;
}