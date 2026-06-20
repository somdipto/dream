"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  useLingbot,
  useLingbotState,
  useLingbotImageAccepted,
  useLingbotGenerationReset,
  type LingbotStateMessage,
} from "@reactor-models/lingbot";
import { useVoice } from "../hooks/useVoice";
import { generateSeedImage } from "../lib/seed-image";
import { composeScenePrompt } from "../lib/scene-composer";
import { useSessions } from "./SessionProvider";

// Desktop equivalent of VoiceDream. Same paint pipeline (reset →
// fresh seed image → setImage → setPrompt → start) but driven by a
// text input instead of voice. On success, the painted scene is
// appended to the active session via `useSessions().addScene`.
//
// The component also listens for a `dream:loadScene` window event
// (fired from the SessionSidebar when the user clicks a past scene) and
// re-runs the paint for that prompt.

export function DesktopDream() {
  const { uploadFile, setImage, setPrompt, start, reset } = useLingbot();
  const sessions = useSessions();
  const voice = useVoice();
  const [snapshot, setSnapshot] = useState<LingbotStateMessage | null>(null);
  const [lastPrompt, setLastPrompt] = useState<string | null>(null);
  const [lastSeed, setLastSeed] = useState<number | null>(null);
  const [text, setText] = useState("");
  const [phase, setPhase] = useState<"idle" | "loading" | "live">("idle");
  const [error, setError] = useState<string | null>(null);

  const inFlightRef = useRef(false);
  const queuedRef = useRef<string | null>(null);
  const sessionNonceRef = useRef<number>(Math.floor(Math.random() * 0xffffffff));
  const imageReadyRef = useRef<(() => void) | null>(null);
  const resetReadyRef = useRef<(() => void) | null>(null);
  const conditionsReadyRef = useRef<(() => void) | null>(null);

  useLingbotState((msg) => setSnapshot(msg));

  useLingbotImageAccepted(() => {
    if (imageReadyRef.current) {
      imageReadyRef.current();
      imageReadyRef.current = null;
    }
  });

  useLingbotGenerationReset(() => {
    if (resetReadyRef.current) {
      resetReadyRef.current();
      resetReadyRef.current = null;
    }
  });

  useEffect(() => {
    if (!snapshot) return;
    if (snapshot.has_image && snapshot.has_prompt && conditionsReadyRef.current) {
      conditionsReadyRef.current();
      conditionsReadyRef.current = null;
    }
  }, [snapshot?.has_image, snapshot?.has_prompt]);

  const generating = snapshot?.started === true;
  useEffect(() => {
    if (generating) setPhase("live");
  }, [generating]);

  const paintDream = useCallback(
    async (transcript: string, opts?: { seed?: number }) => {
      const text = transcript.trim();
      if (!text) return;
      if (inFlightRef.current) {
        queuedRef.current = text;
        return;
      }
      inFlightRef.current = true;
      setError(null);
      setLastPrompt(text);
      setPhase("loading");

      // If the caller provided a seed (e.g. from a stored scene), use
      // it verbatim. Otherwise generate a fresh one so the same prompt
      // twice produces two different worlds.
      const seed = (opts?.seed ?? hashSeed(text + ":" + sessionNonceRef.current.toString(16))) >>> 0;
      setLastSeed(seed);

      // Race the paint pipeline against an 8s wall clock. We do NOT want
      // to leave the user staring at a "painting your dream…" pill
      // for 30s on a single prompt — the model either starts producing
      // frames within a few seconds or the backend is overloaded and
      // we should fall back. The scene is already saved optimistically
      // by the submit handler, so the worst case is the live preview
      // doesn't update this time.
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      const timeoutPromise = new Promise<"timeout">((resolve) => {
        timeoutId = setTimeout(() => resolve("timeout"), 8000);
      });
      const pipeline = (async (): Promise<"ok" | "err"> => {
        try {
          if (generating || snapshot?.has_image) {
            const resetDone = new Promise<void>((resolve) => {
              resetReadyRef.current = resolve;
            });
            await reset();
            await resetDone;
          }
          const blob = await generateSeedImage({ seed });
          // Race the upload against 3s. If Reactor's upload slot is
          // stuck (the most common failure mode in practice), skip
          // the image and let the model start from a prompt-only
          // state. The world is still generated; the seed image is
          // just a visual anchor.
          const uploadPromise = uploadFile(blob, { name: `seed-${seed}.png` });
          const uploadTimeout = new Promise<null>((resolve) =>
            setTimeout(() => resolve(null), 3000),
          );
          const ref = (await Promise.race([uploadPromise, uploadTimeout])) as Awaited<typeof uploadPromise> | null;
          if (ref) {
            // Also race the image_accepted callback against 3s. If
            // the model never sends image_accepted, skip and start
            // with prompt only.
            const imageReady = new Promise<void>((resolve) => {
              imageReadyRef.current = resolve;
            });
            const imageReadyTimeout = new Promise<void>((resolve) =>
              setTimeout(() => resolve(), 3000),
            );
            await setImage({ image: ref });
            await Promise.race([imageReady, imageReadyTimeout]);
          } else {
            // eslint-disable-next-line no-console
            console.warn("[dream] seed upload timed out — painting without anchor image");
          }
          const prompt = composeScenePrompt({ text, isFirst: !snapshot?.has_prompt });
          // Race the conditions-ready callback against 3s.
          const conditionsReady = new Promise<void>((resolve) => {
            conditionsReadyRef.current = resolve;
          });
          const conditionsTimeout = new Promise<void>((resolve) =>
            setTimeout(() => resolve(), 3000),
          );
          await setPrompt({ prompt });
          await Promise.race([conditionsReady, conditionsTimeout]);
          await start();
          return "ok";
        } catch {
          return "err";
        }
      })();

      const result = await Promise.race([pipeline, timeoutPromise]);
      if (timeoutId) clearTimeout(timeoutId);
      if (result === "ok") {
        setPhase("live");
        setError(null);
      } else if (result === "err") {
        setError("Generation failed — your prompt is saved, try again in a moment");
        if (!generating) setPhase("idle");
      } else {
        // timeout — but the pipeline is still running in the
        // background. Surface a gentle message; the user's prompt
        // is already saved.
        setError("Reactor is slow — your prompt is saved. The world may still be painting in the background.");
        if (!generating) setPhase("idle");
      }
      inFlightRef.current = false;
      const next = queuedRef.current;
      queuedRef.current = null;
      if (next) {
        setTimeout(() => void paintDream(next), 0);
      }
    },
    [
      generating,
      snapshot?.has_image,
      snapshot?.has_prompt,
      uploadFile,
      setImage,
      setPrompt,
      start,
      reset,
    ],
  );

  // Listen for scene-load events from the sidebar.
  useEffect(() => {
    function onLoad(e: Event) {
      const detail = (e as CustomEvent).detail as
        | { prompt: string; seed: number }
        | undefined;
      if (!detail?.prompt) return;
      setText(detail.prompt);
      void paintDream(detail.prompt, { seed: detail.seed });
    }
    window.addEventListener("dream:loadScene", onLoad as EventListener);
    return () => window.removeEventListener("dream:loadScene", onLoad as EventListener);
  }, [paintDream]);

  // Desktop voice: push-to-talk via spacebar OR the mic button. Same
  // engine as mobile (Web Speech API → onFinal → paint). The mic
  // starts when the user holds space, stops when they release. The
  // committed transcript on release flows into paintDream exactly
  // like a typed prompt.
  const pushToTalkRef = useRef(false);
  useEffect(() => {
    if (!voice.supported) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.code !== "Space") return;
      const tag = (e.target as HTMLElement | null)?.tagName ?? "";
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (pushToTalkRef.current) return;
      pushToTalkRef.current = true;
      e.preventDefault();
      try {
        voice.start();
      } catch {
        // voice may already be listening
      }
    }
    function onKeyUp(e: KeyboardEvent) {
      if (e.code !== "Space") return;
      if (!pushToTalkRef.current) return;
      pushToTalkRef.current = false;
      try {
        voice.commit();
        voice.stop();
      } catch {
        // ignore
      }
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [voice]);

  // Auto-paint when voice commits a phrase.
  useEffect(() => {
    if (!voice.supported) return;
    return voice.onFinal((text) => {
      const t = text.trim();
      if (!t) return;
      setText(t);
      const seed = hashSeed(t + ":" + sessionNonceRef.current.toString(16)) >>> 0;
      sessions.addScene({ prompt: t, seed });
      void paintDream(t, { seed });
    });
  }, [voice, sessions, paintDream]);

  // On first ready + no active session, also re-paint the last scene
  // of the active session if it has one. (The default-scene
  // auto-paint handles the "first launch" case; this handles the
  // "open app, your last session is still active" case.)
  const restoredRef = useRef(false);
  useEffect(() => {
    if (!sessions.hydrated) return;
    if (restoredRef.current) return;
    const last = sessions.activeSession?.scenes[sessions.activeSession.scenes.length - 1];
    if (last && snapshot?.has_image === false) {
      restoredRef.current = true;
      // Defer to next tick so the SDK is fully wired up.
      setTimeout(() => {
        setText(last.prompt);
        void paintDream(last.prompt, { seed: last.seed });
      }, 500);
    } else {
      restoredRef.current = true;
    }
  }, [sessions.hydrated, sessions.activeSession, snapshot?.has_image, paintDream]);

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    setText("");
    // Optimistically save the user's intent immediately. The
    // "memory" requirement says whatever the user does in a session
    // is persisted locally — even if Reactor's backend is failing
    // to produce a preview, the prompt must not be lost. The
    // paintDream call below will still try to render the scene, but
    // it's best-effort.
    const seed = hashSeed(t + ":" + sessionNonceRef.current.toString(16)) >>> 0;
    sessions.addScene({ prompt: t, seed });
    void paintDream(t, { seed });
  }

  return (
    <div className="pointer-events-auto flex flex-col gap-3" data-testid="desktop-dream">
      <div className="rounded-2xl border border-white/10 bg-black/40 px-4 py-3 text-white shadow-lg backdrop-blur">
        <div className="flex items-center justify-between">
          <p className="text-[10px] uppercase tracking-widest text-white/50">
            {phase === "live"
              ? "Type to mutate the world"
              : phase === "loading"
                ? "Painting your dream…"
                : "Describe your dream"}
          </p>
          <PhaseDot phase={phase} />
        </div>
        <p className="mt-1 min-h-[1.25rem] text-sm leading-snug text-white/80">
          {lastPrompt ||
            (phase === "live"
              ? "Walk with W A S D · look with the mouse"
              : "a sunlit alpine meadow at golden hour, wildflowers, distant snow-capped peaks")}
        </p>
        {error && <p className="mt-1 text-xs text-red-300">{error}</p>}
      </div>
      <form onSubmit={onSubmit} className="flex gap-2" data-testid="desktop-dream-form">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Describe a new dream…"
          data-testid="desktop-dream-input"
          className="flex-1 rounded-full border border-white/10 bg-black/60 px-4 py-3 text-sm text-white placeholder:text-white/40 focus:border-white/30 focus:outline-none"
        />
        {voice.supported && (
          <button
            type="button"
            onMouseDown={() => {
              pushToTalkRef.current = true;
              try {
                voice.start();
              } catch {
                // ignore
              }
            }}
            onMouseUp={() => {
              pushToTalkRef.current = false;
              try {
                voice.commit();
                voice.stop();
              } catch {
                // ignore
              }
            }}
            onMouseLeave={() => {
              if (!pushToTalkRef.current) return;
              pushToTalkRef.current = false;
              try {
                voice.commit();
                voice.stop();
              } catch {
                // ignore
              }
            }}
            onTouchStart={(e) => {
              e.preventDefault();
              pushToTalkRef.current = true;
              try {
                voice.start();
              } catch {
                // ignore
              }
            }}
            onTouchEnd={() => {
              pushToTalkRef.current = false;
              try {
                voice.commit();
                voice.stop();
              } catch {
                // ignore
              }
            }}
            aria-label="Hold to talk"
            title="Hold to talk (or hold Space)"
            data-testid="desktop-mic-btn"
            className={[
              "grid h-12 w-12 shrink-0 place-items-center rounded-full border text-base transition-colors",
              voice.listening
                ? "border-red-400/60 bg-red-500/30 text-white"
                : "border-white/10 bg-white/10 text-white/80 hover:bg-white/20",
            ].join(" ")}
          >
            {voice.listening ? "●" : "🎙"}
          </button>
        )}
        <button
          type="submit"
          data-testid="desktop-dream-paint"
          className="rounded-full bg-white px-5 py-3 text-sm font-medium text-black hover:bg-white/90"
        >
          Paint
        </button>
      </form>
    </div>
  );
}

const DEFAULT_HINT = "a sunlit alpine meadow at golden hour, wildflowers, distant snow-capped peaks";

function PhaseDot({ phase }: { phase: "idle" | "loading" | "live" }) {
  const color =
    phase === "live" ? "bg-emerald-400" : phase === "loading" ? "bg-amber-400" : "bg-white/30";
  return <span className={`inline-block h-1.5 w-1.5 rounded-full ${color}`} />;
}

function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}