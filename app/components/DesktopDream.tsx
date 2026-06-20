"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  useLingbot,
  useLingbotState,
  useLingbotImageAccepted,
  useLingbotGenerationReset,
  type LingbotStateMessage,
} from "@reactor-models/lingbot";
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

      // Race the paint pipeline against a 30s wall clock. If Reactor's
      // backend is hanging (e.g. upload slot exhaustion), we don't
      // want to leave inFlightRef = true forever and block subsequent
      // paints. The scene is already saved optimistically by the
      // submit handler, so the worst case is the live preview doesn't
      // update.
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      const timeoutPromise = new Promise<"timeout">((resolve) => {
        timeoutId = setTimeout(() => resolve("timeout"), 30000);
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
          const ref = await uploadFile(blob, { name: `seed-${seed}.png` });
          const imageReady = new Promise<void>((resolve) => {
            imageReadyRef.current = resolve;
          });
          await setImage({ image: ref });
          await imageReady;
          const prompt = composeScenePrompt({ text, isFirst: !snapshot?.has_prompt });
          const conditionsReady = new Promise<void>((resolve) => {
            conditionsReadyRef.current = resolve;
          });
          await setPrompt({ prompt });
          await conditionsReady;
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
      } else if (result === "err") {
        setError("Generation failed");
        if (!generating) setPhase("idle");
      } else {
        // timeout
        setError("Generation is taking longer than expected — saved locally, will retry on next paint");
        setPhase("idle");
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