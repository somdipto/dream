"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import {
  useLingbot,
  useLingbotState,
  useLingbotImageAccepted,
  type LingbotStateMessage,
} from "@reactor-models/lingbot";
import { useVoice } from "../hooks/useVoice";
import { generateSeedImage } from "../lib/seed-image";
import { composeScenePrompt, composeMutationPrompt } from "../lib/scene-composer";

// The single hero surface of the app.
//
// Flow (revised — real-time voice → world):
//
//   1. User taps "Begin". Mic arms. Status pill flips to "Listening".
//   2. User speaks. Interim transcript is rendered live so they can see
//      what the engine heard.
//   3. The moment the engine commits a final, the *whole transcript so
//      far* is composed into a full scene prompt and sent to Lingbot
//      — no manual "Send" tap. The world mutates as they speak.
//   4. On the first phrase: a fresh procedural seed image is generated
//      client-side, uploaded to Reactor, setImage + setPrompt + start.
//      On every subsequent phrase: just setPrompt. Lingbot picks it up
//      on the next chunk boundary, no restart needed.
//   5. Tilt to walk (GyroController). The user can keep speaking — the
//      mic stays armed.
//
// The procedural seed image is a different gradient + noise + accent
// on every reload, and is keyed off the prompt hash. So no two sessions
// (and no two prompts) ever look the same.

const RETRY_BASE_MS = 1200;

export function VoiceDream() {
  const { status, uploadFile, setImage, setPrompt, start } = useLingbot();
  const [snapshot, setSnapshot] = useState<LingbotStateMessage | null>(null);
  const voice = useVoice();
  const [phase, setPhase] = useState<"idle" | "loading" | "live">("idle");
  const [lastPrompt, setLastPrompt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pulse, setPulse] = useState(0); // increments on every send → animates "live" indicator
  const imageReadyRef = useRef<(() => void) | null>(null);
  const inFlightRef = useRef(false);
  const queuedRef = useRef<string | null>(null);

  useLingbotState((msg) => setSnapshot(msg));

  useEffect(() => {
    if (status !== "ready") {
      setSnapshot(null);
      setPhase("idle");
    }
  }, [status]);

  useLingbotImageAccepted(() => {
    if (imageReadyRef.current) {
      imageReadyRef.current();
      imageReadyRef.current = null;
    }
  });

  const ready = status === "ready";
  const generating = snapshot?.started === true;

  useEffect(() => {
    if (generating) setPhase("live");
  }, [generating]);

  /**
   * The core "voice → world" pipeline. Called on every recognized phrase
   * (and on text input). Uses an in-flight guard + queued tail so a fast
   * speaker who finishes two phrases in 200ms still gets BOTH sent
   * (the second waits for the first to drain).
   */
  const paintDream = useCallback(
    async (transcript: string) => {
      const text = transcript.trim();
      if (!text || !ready) return;
      if (inFlightRef.current) {
        // Coalesce: keep only the latest pending text. The world will
        // catch up to the user's *current* intent, not their second-oldest.
        queuedRef.current = text;
        return;
      }
      inFlightRef.current = true;
      setError(null);
      setLastPrompt(text);
      setPulse((p) => p + 1);

      try {
        if (!generating) {
          setPhase("loading");
          // Fresh procedural seed image. The image is keyed off the
          // prompt hash so the SAME prompt on a different session gives
          // a different image, and a DIFFERENT prompt on the same session
          // gives an image keyed to that prompt.
          const prompt = composeScenePrompt({ text, isFirst: true });
          const seed = hashSeed(text);
          const blob = await generateSeedImage({ seed });
          const ref = await uploadFile(blob, { name: `seed-${seed}.png` });
          const imageReady = new Promise<void>((resolve) => {
            imageReadyRef.current = resolve;
          });
          await setImage({ image: ref });
          await imageReady;
          await setPrompt({ prompt });
          await start();
          setPhase("live");
        } else {
          // Hot-swap. No new image — the model is already anchored, and
          // changing the image mid-generation would require reset+start
          // (Lingbot API contract). Instead, we hand the model a mutation
          // prompt that preserves the camera grammar but updates the world.
          const prev = (document.querySelector(
            "[data-last-prompt]"
          ) as HTMLElement | null)?.dataset.lastPrompt ?? null;
          const prompt = composeMutationPrompt(prev, text);
          await setPrompt({ prompt });
        }
      } catch (e: any) {
        setError(e?.message ?? String(e));
        if (!generating) setPhase("idle");
      } finally {
        inFlightRef.current = false;
        // Drain the queue: if the user spoke again while we were busy,
        // fire the latest queued text now.
        const next = queuedRef.current;
        queuedRef.current = null;
        if (next) {
          // Use a microtask break so React has a chance to render the
          // "live" pill between sends.
          setTimeout(() => void paintDream(next), 0);
        }
      }
    },
    [ready, generating, uploadFile, setImage, setPrompt, start]
  );

  // Auto-send on every committed phrase from the speech engine. The
  // useVoice hook fires this for both `isFinal` events and the
  // silence-flush, so the world mutates the moment the user pauses.
  useEffect(() => {
    if (!ready) return;
    return voice.onFinal((text) => {
      void paintDream(text);
    });
  }, [ready, voice, paintDream]);

  function onMicClick() {
    if (!voice.supported) {
      setError("Voice not supported in this browser. Use the text input below.");
      return;
    }
    if (voice.listening) {
      // Manual commit. Useful if the user is mid-thought and wants to
      // trigger the world right now without waiting for the silence flush.
      const committed = voice.commit();
      if (committed) void paintDream(committed);
    } else {
      voice.start();
    }
  }

  function onTextSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const text = (data.get("text") as string | null)?.trim();
    if (!text) return;
    e.currentTarget.reset();
    void paintDream(text);
  }

  // Mic auto-arms as soon as we are ready — no separate button needed.
  // The mic button is kept as a manual-commit / re-arm affordance.
  useEffect(() => {
    if (ready && !voice.listening && voice.supported && !voice.error) {
      voice.start();
    }
  }, [ready, voice]);

  return (
    <div
      className="pointer-events-auto flex flex-col gap-3"
      data-last-prompt={lastPrompt ?? ""}
    >
      {/* Transcript card — live interim + last sent. */}
      <div className="rounded-2xl border border-white/10 bg-black/40 px-4 py-3 text-white shadow-lg backdrop-blur">
        <div className="flex items-center justify-between">
          <p className="text-[10px] uppercase tracking-widest text-white/50">
            {phase === "live"
              ? "Speaking mutates the world"
              : phase === "loading"
                ? "Painting your dream…"
                : "Describe your dream"}
          </p>
          <PulseDot pulse={pulse} phase={phase} />
        </div>
        <p className="mt-1 min-h-[1.25rem] text-sm leading-snug">
          {voice.interim || lastPrompt || (phase === "live" ? "(speak to mutate the world)" : 'Say: "a misty pine forest at dawn, soft light, fog between the trees."')}
        </p>
        {error && <p className="mt-1 text-xs text-red-300">{error}</p>}
      </div>

      {/* Mic button — primary action. Manual commit / re-arm. */}
      <button
        type="button"
        onClick={onMicClick}
        disabled={!voice.supported || !ready}
        className={[
          "mx-auto grid h-16 w-16 place-items-center rounded-full border transition active:scale-95",
          voice.listening
            ? "animate-pulse border-red-400/60 bg-red-500/80 text-white"
            : "border-white/20 bg-white/10 text-white hover:bg-white/20",
          (!voice.supported || !ready) && "opacity-40",
        ].filter(Boolean).join(" ")}
        aria-label={voice.listening ? "Send transcript now" : "Start listening"}
      >
        <MicIcon active={voice.listening} />
      </button>

      {/* Text fallback (always visible — small, below the mic). */}
      <form onSubmit={onTextSubmit} className="flex gap-2">
        <input
          name="text"
          placeholder="…or type a prompt"
          disabled={!ready}
          className="flex-1 rounded-full border border-white/10 bg-black/40 px-4 py-2 text-sm text-white placeholder:text-white/40 focus:border-white/30 focus:outline-none disabled:opacity-40"
        />
        <button
          type="submit"
          disabled={!ready}
          className="rounded-full bg-white/15 px-4 py-2 text-sm font-medium text-white hover:bg-white/25 disabled:opacity-40"
        >
          Send
        </button>
      </form>
    </div>
  );
}

function PulseDot({ pulse, phase }: { pulse: number; phase: "idle" | "loading" | "live" }) {
  const [key, setKey] = useState(0);
  useEffect(() => {
    setKey((k) => k + 1);
  }, [pulse]);
  const color =
    phase === "live" ? "bg-emerald-400" : phase === "loading" ? "bg-amber-400" : "bg-white/30";
  return (
    <span
      key={key}
      className={`inline-block h-1.5 w-1.5 rounded-full ${color}`}
      style={{ animation: "pulseDot 600ms ease-out" }}
    />
  );
}

function MicIcon({ active }: { active: boolean }) {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="3" width="6" height="12" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <line x1="12" y1="18" x2="12" y2="22" />
      {active && <circle cx="12" cy="12" r="2" fill="currentColor" />}
    </svg>
  );
}

function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}