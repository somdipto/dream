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

// Desktop equivalent of VoiceDream. Same paint pipeline (reset →
// fresh seed image → setImage → setPrompt → start) but driven by a
// text input instead of voice. No mic auto-arm. Lives in a separate
// component so the Voice code path stays small and focused on speech.
//
// Why the same per-prompt-reset flow? Consistency with the mobile
// build — every prompt is a fresh blank canvas. Same prompt twice =
// different image (session nonce).

export function DesktopDream() {
  const { uploadFile, setImage, setPrompt, start, reset } = useLingbot();
  const [snapshot, setSnapshot] = useState<LingbotStateMessage | null>(null);
  const [lastPrompt, setLastPrompt] = useState<string | null>(null);
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
    async (transcript: string) => {
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

      try {
        if (generating || snapshot?.has_image) {
          const resetDone = new Promise<void>((resolve) => {
            resetReadyRef.current = resolve;
          });
          await reset();
          await resetDone;
        }
        const seed = hashSeed(text + ":" + sessionNonceRef.current.toString(16));
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
        setPhase("live");
      } catch (e: any) {
        setError(e?.message ?? String(e));
        if (!generating) setPhase("idle");
      } finally {
        inFlightRef.current = false;
        const next = queuedRef.current;
        queuedRef.current = null;
        if (next) {
          setTimeout(() => void paintDream(next), 0);
        }
      }
    },
    [generating, snapshot?.has_image, snapshot?.has_prompt, uploadFile, setImage, setPrompt, start, reset]
  );

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    setText("");
    void paintDream(t);
  }

  return (
    <div className="pointer-events-auto flex flex-col gap-3">
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
          {lastPrompt || (phase === "live" ? "Walk with W A S D · look with the mouse" : DEFAULT_HINT)}
        </p>
        {error && <p className="mt-1 text-xs text-red-300">{error}</p>}
      </div>
      <form onSubmit={onSubmit} className="flex gap-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Describe a new dream…"
          className="flex-1 rounded-full border border-white/10 bg-black/60 px-4 py-3 text-sm text-white placeholder:text-white/40 focus:border-white/30 focus:outline-none"
        />
        <button
          type="submit"
          className="rounded-full bg-white px-5 py-3 text-sm font-medium text-black hover:bg-white/90"
        >
          Paint
        </button>
      </form>
    </div>
  );
}

const DEFAULT_HINT = "a misty pine forest at dawn, fog between the trees";

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