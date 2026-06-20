"use client";

import { useEffect, useRef, useState, useCallback } from "react";
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
  const [error, setError] = useState<string | null>(null);
  const [pulse, setPulse] = useState(0); // increments on every send → animates "live" indicator
  const inFlightRef = useRef(false);
  const queuedRef = useRef<string | null>(null);
  // A session-scoped nonce. Mixed into every seed-image hash so that two
  // identical prompts in the same session produce two different images,
  // and the same prompt in two different sessions likewise differs. This
  // is what kills the "template" feel: the same words never paint the
  // same world twice.
  const sessionNonceRef = useRef<number>(Math.floor(Math.random() * 0xffffffff));

  useLingbotState((msg) => setSnapshot(msg));

  // Per-step awaitable handles. We resolve each one when the matching
  // SDK event fires, instead of guessing timing with timeouts.
  const imageReadyRef = useRef<(() => void) | null>(null);
  const resetReadyRef = useRef<(() => void) | null>(null);
  const conditionsReadyRef = useRef<(() => void) | null>(null);

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

  useLingbotGenerationReset(() => {
    if (resetReadyRef.current) {
      resetReadyRef.current();
      resetReadyRef.current = null;
    }
  });

  // We don't have a dedicated "conditions_ready" event hook in this
  // SDK version, so we infer it from the next "state" message where
  // both has_image and has_prompt are true.
  useEffect(() => {
    if (!snapshot) return;
    if (snapshot.has_image && snapshot.has_prompt && conditionsReadyRef.current) {
      conditionsReadyRef.current();
      conditionsReadyRef.current = null;
    }
  }, [snapshot?.has_image, snapshot?.has_prompt]);

  const ready = status === "ready";
  const generating = snapshot?.started === true;

  useEffect(() => {
    if (generating) setPhase("live");
  }, [generating]);

  /**
   * The core "voice → world" pipeline. Called on every recognized phrase
   * (and on text input). Uses an in-flight guard + queued tail so a fast
   * speaker who finishes two phrases in 200ms still gets BOTH sent
   * (the second waits for the first to drain, with the latest text).
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
      setPhase("loading");

      // Hoist seed for the finally block — the session must save the
      // prompt even if the backend fails.
      const seed = hashSeed(text + ":" + sessionNonceRef.current.toString(16));

      try {
        // 1. Always reset first. Lingbot's contract says image/prompt
        //    can only be set on a clean (non-running) session. Reset
        //    cancels the running generation and clears has_image /
        //    has_prompt / started.
        if (generating || snapshot?.has_image) {
          const resetDone = new Promise<void>((resolve) => {
            resetReadyRef.current = resolve;
          });
          await reset();
          await resetDone;
        }

        // 2. Fresh procedural seed image. The hash mixes the prompt
        //    text with the session nonce, so:
        //    - same prompt, same session, called twice → two different images
        //    - same prompt, two different sessions → two different images
        //    - different prompts, same session → two different images
        const blob = await generateSeedImage({ seed });
        // Try the upload twice with a 2s gap. Reactor's upload
        // slot is occasionally sticky; a single retry almost always
        // succeeds where the first call hung.
        let ref: Awaited<ReturnType<typeof uploadFile>> | null = null;
        for (let attempt = 0; attempt < 2 && !ref; attempt++) {
          const uploadPromise = uploadFile(blob, { name: `seed-${seed}.png` });
          const uploadTimeout = new Promise<null>((resolve) =>
            setTimeout(() => resolve(null), 4000),
          );
          ref = (await Promise.race([uploadPromise, uploadTimeout])) as Awaited<ReturnType<typeof uploadFile>> | null;
          if (!ref && attempt === 0) {
            await new Promise<void>((resolve) => setTimeout(resolve, 2000));
          }
        }

        // 3. setImage, then wait for image_accepted. Track whether
        //    the model actually acknowledged the image; if not, we
        //    cannot safely call setPrompt/start (Reactor rejects
        //    with "No image set. Call set_image first.").
        let imageAccepted = false;
        if (ref) {
          let imageReadyResolve!: () => void;
          const imageReady = new Promise<void>((resolve) => {
            imageReadyResolve = resolve;
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
        } else {
          // eslint-disable-next-line no-console
          console.warn("[dream] seed upload timed out — aborting paint");
        }
        if (!imageAccepted) {
          return;
        }

        // 4. Compose the prompt from the user's words + a stable camera
        //    grammar (the model needs the camera scaffolding or the
        //    tilt-to-walk interaction gets confused).
        const prompt = composeScenePrompt({ text, isFirst: !snapshot?.has_prompt });

        // 5. setPrompt, then wait for conditions_ready (has_image &&
        //    has_prompt both true in the next state message). Race
        //    against 3s; if conditions never flip, start anyway.
        const conditionsReady = new Promise<void>((resolve) => {
          conditionsReadyRef.current = resolve;
        });
        const conditionsTimeout = new Promise<void>((resolve) =>
          setTimeout(() => resolve(), 3000),
        );
        await setPrompt({ prompt });
        await Promise.race([conditionsReady, conditionsTimeout]);

        // 6. Start the generation. New scene, fresh world.
        await start();
        setPhase("live");
      } catch (e: any) {
        setError(e?.message ?? String(e));
        if (!generating) setPhase("idle");
      } finally {
        inFlightRef.current = false;
        // The session scene is saved by the caller (form submit /
        // voice.onFinal) BEFORE paintDream runs, so the user's
        // intent is preserved even if the backend hangs.
        // Drain the queue: if the user spoke again while we were busy,
        // fire the latest queued text now.
        const next = queuedRef.current;
        queuedRef.current = null;
        if (next) {
          // Use a microtask break so React has a chance to render the
          // "loading" pill between sends.
          setTimeout(() => void paintDream(next), 0);
        }
      }
    },
    [ready, generating, snapshot?.has_image, snapshot?.has_prompt, uploadFile, setImage, setPrompt, start, reset]
  );

  // The user's explicit mic intent. M3.5: clicking the mic while
  // listening now MUTES — it doesn't just commit. The user is in
  // charge of whether the mic is on. `muted` is the only thing that
  // controls whether auto-arm ever starts the recogniser.
  const [muted, setMuted] = useState(false);

  // Auto-send on every committed phrase from the speech engine. The
  // useVoice hook fires this for both `isFinal` events and the
  // silence-flush, so the world mutates the moment the user pauses.
  useEffect(() => {
    if (!ready) return;
    return voice.onFinal((text) => {
      // Save the spoken phrase to the active session immediately —
      // this is the "LiveVocs" hookup. Even if Reactor's backend is
      // failing to render, the user's voice work is preserved.
      const seed = hashSeed(text + ":" + sessionNonceRef.current.toString(16));
      sessions.addScene({ prompt: text, seed });
      void paintDream(text);
    });
  }, [ready, voice, paintDream, sessions]);

  // If the user mutes while listening, stop the recogniser. If the
  // browser ends the session (silence cap) while muted, do NOT
  // auto-restart. `muted` is the single source of truth for "should
  // the mic be hot right now".
  useEffect(() => {
    if (muted && voice.listening) {
      voice.stop();
    }
  }, [muted, voice.listening, voice.stop]);

  // Auto-arm the mic only when (a) we're ready, (b) the user hasn't
  // muted, (c) the browser supports it, (d) the user isn't already
  // listening. If the user mutes, this effect will not bring the mic
  // back next time `ready` flips.
  useEffect(() => {
    if (ready && !muted && !voice.listening && voice.supported && !voice.error) {
      voice.start();
    }
  }, [ready, muted, voice]);

  function onMicClick() {
    if (!voice.supported) {
      setError("Voice not supported in this browser. Use the text input below.");
      return;
    }
    if (muted) {
      // Un-mute → re-arm.
      setMuted(false);
      voice.start();
    } else if (voice.listening) {
      // Mute. The user wants the mic OFF. Stop the recogniser and
      // mark the user as muted so the auto-arm effect doesn't bring
      // it back on the next render.
      voice.commit();
      voice.stop();
      setMuted(true);
    } else {
      // Not listening, not muted: explicit start.
      voice.start();
    }
  }

  function onTextSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const text = (data.get("text") as string | null)?.trim();
    if (!text) return;
    e.currentTarget.reset();
    // Save the user's intent immediately (the "LiveVocs" /
    // "memory" requirement: every spoken phrase — or in this case,
    // typed phrase on mobile — is added to the current session).
    const seed = hashSeed(text + ":" + sessionNonceRef.current.toString(16));
    sessions.addScene({ prompt: text, seed });
    void paintDream(text);
  }

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

      {/* Mic button — three states:
            1. listening  → red, pulsing. Click to MUTE.
            2. muted      → dim grey with a slash. Click to UN-MUTE.
            3. off/idle   → white outline. Click to start. */}
      <div className="flex flex-col items-center gap-1">
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
        <p className="text-[10px] uppercase tracking-widest text-white/40">
          {muted
            ? "Muted — click to listen"
            : voice.listening
              ? "Tap to mute"
              : "Tap to speak"}
        </p>
      </div>

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

function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}