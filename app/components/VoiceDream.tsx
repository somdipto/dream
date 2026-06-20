"use client";

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import {
  useLingbot,
  useLingbotState,
  useLingbotImageAccepted,
  useLingbotGenerationReset,
  useLingbotConditionsReady,
  type LingbotStateMessage,
} from "@reactor-models/lingbot";
import { useVoice } from "../hooks/useVoice";
import { generateSeedImage } from "../lib/seed-image";
import { composeScenePrompt } from "../lib/scene-composer";
import { useSessions } from "./SessionProvider";
import { ChipStrip } from "./ChipStrip";
import {
  STYLE_PRESETS,
  TIME_VARIANTS,
  composePrompt,
  findPreset,
  findVariant,
  hasConflict,
} from "../lib/style-presets";
import { buildShareUrl, hashSeed, readDreamFromUrl, clearDreamFromUrl } from "../lib/dream-utils";

// The single hero surface of the app.
//
// Flow (M3 — "blank canvas every prompt"):
//
//   1. User taps "Begin". Mic arms. Status pill flips to "Listening".
//   2. User speaks. Interim transcript is rendered live so they can see
//      what the engine heard.
//   3. The moment the engine commits a final, the *whole transcript so
//      far* is composed into a full scene prompt and sent to Lingbot
//      — no manual "Send" tap.
//   4. On EVERY phrase (first and every subsequent):
//        reset() → generate fresh procedural seed image
//                 → upload → setImage (wait for image_accepted)
//                 → setPrompt (wait for conditions_ready)
//                 → start()
//      The world is *reborn* from a clean anchor every time. No template
//      image persists between phrases. Same prompt twice → different
//      image (session nonce + prompt hash).
//   5. The cost is a visible 1–2 s blank frame between reset and the new
//      first chunk. That's the user's "blank canvas" requirement.
//   6. Tilt to walk (GyroController). The user can keep speaking — the
//      mic stays armed.

export function VoiceDream() {
  const { status, uploadFile, setImage, setPrompt, start, reset } = useLingbot();
  const [snapshot, setSnapshot] = useState<LingbotStateMessage | null>(null);
  const voice = useVoice();
  const sessions = useSessions();
  const [phase, setPhase] = useState<"idle" | "loading" | "live">("idle");
  const [lastPrompt, setLastPrompt] = useState<string | null>(null);
  const [lastSeed, setLastSeed] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pulse, setPulse] = useState(0); // increments on every send → animates "live" indicator
  const [muted, setMuted] = useState(false);
  const [styleId, setStyleId] = useState<string | null>(null);
  const [variantId, setVariantId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [text, setText] = useState("");

  const inFlightRef = useRef(false);
  const queuedRef = useRef<string | null>(null);
  const sessionNonceRef = useRef<number>(Math.floor(Math.random() * 0xffffffff));
  // Live mirror of `snapshot` for use inside async closures. (Audit
  // bug #5: paintDream was reading stale snapshot state.)
  const snapshotRef = useRef<LingbotStateMessage | null>(null);
  // Track the last in-flight paint's text so a re-roll can re-paint
  // it without the user re-typing.
  const lastPaintedRef = useRef<string | null>(null);

  useLingbotState((msg) => {
    setSnapshot(msg);
    snapshotRef.current = msg;
  });

  const imageReadyRef = useRef<(() => void) | null>(null);
  const resetReadyRef = useRef<(() => void) | null>(null);
  const conditionsReadyRef = useRef<(() => void) | null>(null);

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

  // The SDK exposes a dedicated `conditions_ready` event. This
  // replaces the previous snapshot-inference (which raced against
  // the state message stream and could resolve after the next
  // setPrompt's conditionsReady ref was overwritten).
  useLingbotConditionsReady(() => {
    if (conditionsReadyRef.current) {
      conditionsReadyRef.current();
      conditionsReadyRef.current = null;
    }
  });

  const ready = status === "ready";
  const generating = snapshot?.started === true;

  // We do NOT auto-flip phase from `generating`. The model's `started`
  // flag flips the moment Reactor accepts `start`, but the first frame
  // can take several more seconds. The user looking at a "live" badge
  // over a still black canvas thinks the app is broken. paintDream
  // owns the phase transition.

  function clearReadyRefs() {
    imageReadyRef.current = null;
    resetReadyRef.current = null;
    conditionsReadyRef.current = null;
  }

  function buildPrompt(raw: string): string {
    // Uses composePrompt() so conflict detection (Noir + Sunset, etc.)
    // automatically drops the contradictory time-of-day cue instead of
    // sending both to the model. (Audit bug #36.)
    return composePrompt(raw, styleId, variantId);
  }

  const conflictingVariants = useMemo(
    () => (styleId ? findPreset(styleId)?.conflictsWith ?? [] : []),
    [styleId],
  );
  const conflictingPresets = useMemo(
    () =>
      variantId && variantId !== "none"
        ? findVariant(variantId)?.conflictsWith ?? []
        : [],
    [variantId],
  );
  const conflictActive = hasConflict(styleId, variantId);

  /**
   * The core "voice → world" pipeline. Called on every recognized phrase
   * (and on text input). Uses an in-flight guard + queued tail so a fast
   * speaker who finishes two phrases in 200ms still gets BOTH sent
   * (the second waits for the first to drain, with the latest text).
   */
  const paintDream = useCallback(
    async (transcript: string, opts?: { seed?: number; promptOverride?: string }) => {
      const text = transcript.trim();
      if (!text || !ready) return;
      if (inFlightRef.current) {
        // Coalesce: keep only the latest pending text.
        queuedRef.current = text;
        return;
      }
      inFlightRef.current = true;
      setError(null);
      setLastPrompt(text);
      lastPaintedRef.current = text;
      setPulse((p) => p + 1);
      setPhase("loading");

      const seed = (opts?.seed ?? hashSeed(text + ":" + sessionNonceRef.current.toString(16))) >>> 0;
      setLastSeed(seed);

      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      const timeoutPromise = new Promise<"timeout">((resolve) => {
        timeoutId = setTimeout(() => resolve("timeout"), 8000);
      });
      const pipeline = (async (): Promise<"ok" | "err"> => {
        try {
          // First-paint path: there is no prior generation, so
          // `useLingbotGenerationReset` will never fire a callback.
          // Race the reset promise against 1.5s and treat timeout as
          // "no reset was needed, proceed". (Audit bug #2.)
          if (generating || snapshotRef.current?.has_image) {
            const resetDone = new Promise<void>((resolve) => {
              resetReadyRef.current = resolve;
            });
            const resetTimeout = new Promise<void>((resolve) =>
              setTimeout(() => resolve(), 1500),
            );
            await reset();
            await Promise.race([resetDone, resetTimeout]);
            resetReadyRef.current = null;
          }
          const blob = await generateSeedImage({ seed });
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
          let imageAccepted = false;
          if (ref) {
            const imageReady = new Promise<void>((resolve) => {
              imageReadyRef.current = resolve;
            });
            const imageReadyTimeout = new Promise<void>((resolve) =>
              setTimeout(() => resolve(), 6000),
            );
            await setImage({ image: ref });
            await Promise.race([
              imageReady.then(() => {
                imageAccepted = true;
              }),
              imageReadyTimeout,
            ]);
            imageReadyRef.current = null;
          } else {
            // eslint-disable-next-line no-console
            console.warn("[dream] seed upload timed out — aborting paint");
          }
          if (!imageAccepted) {
            return "err";
          }
          const composed = opts?.promptOverride ?? buildPrompt(text);
          const prompt = composeScenePrompt({ text: composed, isFirst: !snapshotRef.current?.has_prompt });
          const conditionsReady = new Promise<void>((resolve) => {
            conditionsReadyRef.current = resolve;
          });
          const conditionsTimeout = new Promise<void>((resolve) =>
            setTimeout(() => resolve(), 3000),
          );
          await setPrompt({ prompt });
          await Promise.race([conditionsReady, conditionsTimeout]);
          conditionsReadyRef.current = null;
          await start();
          return "ok";
        } catch {
          return "err";
        } finally {
          clearReadyRefs();
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
    [ready, generating, uploadFile, setImage, setPrompt, start, reset],
  );

  // Stable ref for use inside effects that shouldn't re-bind on every
  // paint identity change. (Audit bug #4 / #18.)
  const paintDreamRef = useRef(paintDream);
  paintDreamRef.current = paintDream;

  // Auto-send on every committed phrase from the speech engine. The
  // useVoice hook fires this for both `isFinal` events and the
  // silence-flush, so the world mutates the moment the user pauses.
  useEffect(() => {
    if (!ready) return;
    return voice.onFinal((text) => {
      const seed = hashSeed(text + ":" + sessionNonceRef.current.toString(16)) >>> 0;
      sessions.addScene({ prompt: text, seed });
      void paintDreamRef.current(text, { seed });
    });
  }, [ready, voice, sessions]);

  // If the user mutes while listening, stop the recogniser.
  useEffect(() => {
    if (muted && voice.listening) {
      voice.stop();
    }
  }, [muted, voice.listening, voice.stop]);

  // Auto-arm the mic only when (a) we're ready, (b) the user hasn't
  // muted, (c) the browser supports it, (d) the user isn't already
  // listening. Bug #17: voice.error is cleared on `start()` so a
  // previous error doesn't permanently block re-arming.
  useEffect(() => {
    if (ready && !muted && !voice.listening && voice.supported && !voice.error) {
      voice.start();
    }
  }, [ready, muted, voice]);

  // Listen for scene-load events from the sidebar (curated picks,
  // past scene replay). Saves to the journal so the pick shows up in
  // the sidebar — the desktop path already does this; mobile was
  // missing the listener entirely so curated taps silently no-op'd.
  useEffect(() => {
    function onLoad(e: Event) {
      const detail = (e as CustomEvent).detail as
        | { prompt: string; seed: number }
        | undefined;
      if (!detail?.prompt) return;
      setLastPrompt(detail.prompt);
      setLastSeed(detail.seed);
      setText(detail.prompt);
      sessions.addScene({ prompt: detail.prompt, seed: detail.seed });
      void paintDreamRef.current(detail.prompt, { seed: detail.seed });
    }
    window.addEventListener("dream:loadScene", onLoad as EventListener);
    return () => window.removeEventListener("dream:loadScene", onLoad as EventListener);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // On mount, if the URL contains a shared dream (`?d=...`), auto-paint
  // it. This is the entry point for shareable URLs.
  useEffect(() => {
    const shared = readDreamFromUrl();
    if (!shared) return;
    setLastPrompt(shared.prompt);
    setLastSeed(shared.seed);
    setText(shared.prompt);
    sessions.addScene({ prompt: shared.prompt, seed: shared.seed });
    const t = setTimeout(() => {
      void paintDreamRef.current(shared.prompt, { seed: shared.seed });
    }, 250);
    clearDreamFromUrl();
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-render the most recent prompt with a fresh seed. Same text,
  // new world. Uses lastPaintedRef (not React state) so a re-roll
  // while a paint is in flight still works.
  function onReRoll() {
    const base = (text.trim() || lastPaintedRef.current || lastPrompt || "").trim();
    if (!base) return;
    const rollNonce = Math.floor(Math.random() * 0xffffffff);
    const seed = hashSeed(base + ":" + rollNonce.toString(16)) >>> 0;
    sessions.addScene({ prompt: base, seed });
    setLastPrompt(base);
    setLastSeed(seed);
    setText("");
    void paintDream(base, { seed });
  }

  async function onShare() {
    const prompt = lastPrompt;
    if (!prompt) return;
    const seed = lastSeed ?? hashSeed(prompt + ":" + sessionNonceRef.current.toString(16)) >>> 0;
    const url = buildShareUrl(prompt, seed);
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      window.prompt("Copy this dream link:", url);
    }
  }

  function onMicClick() {
    if (!voice.supported) {
      setError("Voice not supported in this browser. Use the text input below.");
      return;
    }
    if (muted) {
      setMuted(false);
      voice.start();
    } else if (voice.listening) {
      voice.commit();
      voice.stop();
      setMuted(true);
    } else {
      voice.start();
    }
  }

  function onTextSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    setText("");
    const seed = hashSeed(t + ":" + sessionNonceRef.current.toString(16)) >>> 0;
    sessions.addScene({ prompt: t, seed });
    void paintDream(t, { seed });
  }

  return (
    <div
      className="pointer-events-auto flex flex-col gap-3"
      data-last-prompt={lastPrompt ?? ""}
    >
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
        {error && <p className="mt-1 text-xs text-red-300" role="status" aria-live="polite">{error}</p>}
      </div>

      <div className="flex flex-col gap-2">
        <ChipStrip
          chips={STYLE_PRESETS.map((p) => ({ id: p.id, label: p.label, emoji: p.emoji }))}
          activeId={styleId}
          onSelect={setStyleId}
          size="sm"
          dimmedIds={variantId && variantId !== "none" ? conflictingPresets : null}
          dimmedReason="Conflicts with the selected time/weather"
        />
        <ChipStrip
          chips={TIME_VARIANTS.map((v) => ({ id: v.id, label: v.label, emoji: v.emoji }))}
          activeId={variantId}
          onSelect={setVariantId}
          size="sm"
          dimmedIds={styleId ? conflictingVariants : null}
          dimmedReason="Conflicts with the selected style"
        />
        {conflictActive && (
          <p className="text-[10px] text-amber-300/80">
            Heads-up — this style + time combo gives the model conflicting
            cues. The time-of-day will be ignored.
          </p>
        )}
      </div>

      <div className="flex items-center justify-center gap-2">
        <button
          type="button"
          onClick={onReRoll}
          disabled={!lastPrompt}
          aria-label="Re-roll same prompt"
          title="Re-roll"
          data-testid="mobile-reroll-btn"
          className="grid h-10 w-10 place-items-center rounded-full border border-white/10 bg-white/10 text-white/85 transition hover:bg-white/20 disabled:opacity-40"
        >
          🎲
        </button>
        <button
          type="button"
          onClick={onShare}
          disabled={!lastPrompt}
          aria-label={copied ? "Link copied" : "Copy a shareable link"}
          title={copied ? "Copied!" : "Share"}
          data-testid="mobile-share-btn"
          className="grid h-10 w-10 place-items-center rounded-full border border-white/10 bg-white/10 text-white/85 transition hover:bg-white/20 disabled:opacity-40"
        >
          {copied ? "✓" : "🔗"}
        </button>
        <button
          type="button"
          onClick={onMicClick}
          disabled={!voice.supported || !ready}
          className={[
            "mx-auto grid h-16 w-16 place-items-center rounded-full border transition active:scale-95",
            muted
              ? "border-white/10 bg-white/5 text-white/40 hover:bg-white/10 hover:text-white/70"
              : voice.listening
                ? "animate-pulse border-red-400/60 bg-red-500/80 text-white"
                : "border-white/30 bg-white/10 text-white hover:bg-white/20",
            (!voice.supported || !ready) && "opacity-40",
          ].filter(Boolean).join(" ")}
          aria-label={
            muted
              ? "Mic muted — click to unmute"
              : voice.listening
                ? "Mic on — click to mute"
                : "Start listening"
          }
        >
          <MicIcon active={voice.listening} muted={muted} />
        </button>
        <p className="sr-only">
          {muted
            ? "Muted — click to listen"
            : voice.listening
              ? "Tap to mute"
              : "Tap to speak"}
        </p>
      </div>

      <form onSubmit={onTextSubmit} className="flex gap-2">
        <input
          name="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
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

function MicIcon({ active, muted }: { active: boolean; muted: boolean }) {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="3" width="6" height="12" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <line x1="12" y1="18" x2="12" y2="22" />
      {active && !muted && <circle cx="12" cy="12" r="2" fill="currentColor" />}
      {muted && <line x1="4" y1="20" x2="20" y2="4" />}
    </svg>
  );
}
