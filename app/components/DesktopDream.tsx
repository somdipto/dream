"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { dreamBus } from "../lib/event-bus";
import { parseVoiceStyle } from "../lib/voice-style-parser";
import { captureCurrentFrame } from "../lib/pose-lock";
import { pickSurprisePrompt } from "../lib/surprise-prompts";
import { setDirectorState } from "../lib/director-state";

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
  const [styleId, setStyleId] = useState<string | null>(null);
  const [variantId, setVariantId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Pose Lock — when true, the next paintDream uses the captured
  // current frame as the seed image instead of a fresh noise gradient.
  const [poseLocked, setPoseLocked] = useState(false);
  const [poseLockedAt, setPoseLockedAt] = useState<number>(0);

  const inFlightRef = useRef(false);
  const queuedRef = useRef<string | null>(null);
  const sessionNonceRef = useRef<number>(Math.floor(Math.random() * 0xffffffff));
  const imageReadyRef = useRef<(() => void) | null>(null);
  const resetReadyRef = useRef<(() => void) | null>(null);
  const conditionsReadyRef = useRef<(() => void) | null>(null);
  // Set to true when the user picks a different session from the
  // sidebar (or the curated gallery). Each Promise.race winner in
  // `paintDream` checks this flag and short-circuits if it's true,
  // so an in-flight paint doesn't commit its scene to the wrong
  // journal after the active session has already changed.
  const abortedRef = useRef(false);
  // QA5: paintEpoch bumps on every new paint. Captured at
  // paint start, checked in the post-paint success path so
  // stale paints don't write to the journal.
  const paintEpochRef = useRef(0);
  // ID of the deferred re-paint `setTimeout` so we can cancel it on
  // unmount (prevents a torn-down provider from receiving paint
  // commands) and on a new paint starting before the previous one
  // has been scheduled.
  const repaintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Mirror of `snapshot` for use inside async closures. Without this,
  // paintDream reads a stale snapshot at pipeline start and the
  // post-timeout `setPhase("idle")` branch can fire even when the
  // world is actively generating. (Audit bug #5.)
  const snapshotRef = useRef<LingbotStateMessage | null>(null);
  // QA5: also mirror `generating` so paintDream has a stable
  // identity. Reading from a ref inside the closure (instead
  // of taking `generating` as a dep) means the callback
  // doesn't re-bind on every snapshot chunk.
  const generatingRef = useRef(false);

  // Wrap the state callback in `useCallback` with stable deps so the
  // SDK doesn't unsubscribe/resubscribe on every render.
  const onState = useCallback((msg: LingbotStateMessage) => {
    setSnapshot(msg);
    snapshotRef.current = msg;
    generatingRef.current = msg.started === true;
  }, []);
  useLingbotState(onState);

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

  const generating = snapshot?.started === true;

  // Compose the user text + style suffix + time/weather variant into
  // the full prompt the model sees. We keep the raw text in `text`
  // (so the user can edit it) and apply the suffixes only at submit.
  // Uses composePrompt() from style-presets so conflict detection
  // (Noir + Sunset, etc.) automatically downgrades the contradictory
  // token rather than firing both at the model.
  function buildPrompt(raw: string): string {
    return composePrompt(raw, styleId, variantId);
  }

  // Compute the dimmed-chip lists so the UI can warn the user before
  // they select a contradicting pair. (Audit bug #36.)
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

  // Clear all three ready-refs at the end of every paint, so a
  // callback from a previous paint can't resolve a new paint's
  // promise. (Audit bug #1.)
  function clearReadyRefs() {
    imageReadyRef.current = null;
    resetReadyRef.current = null;
    conditionsReadyRef.current = null;
  }

  const paintDream = useCallback(
    async (transcript: string, opts?: { seed?: number; promptOverride?: string }) => {
      const t = transcript.trim();
      if (!t) return;
      if (inFlightRef.current) {
        queuedRef.current = t;
        return;
      }
      inFlightRef.current = true;
      // QA5: bump the epoch so stale post-paint effects
      // don't write to the journal after an abort.
      const myEpoch = ++paintEpochRef.current;
      setError(null);
      setLastPrompt(t);
      setPhase("loading");

      const paintStart = Date.now();
      const seed = (opts?.seed ?? hashSeed(t + ":" + sessionNonceRef.current.toString(16))) >>> 0;
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
          if (generatingRef.current || snapshotRef.current?.has_image) {
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
          const blob = poseLocked
            ? await captureCurrentFrame().then((b) => {
                // QA6: explain the silent fallback to the
                // user. Cross-origin video taints the
                // canvas, so captureCurrentFrame returns
                // null and we fall back to a seed image.
                // Without this toast, the user clicks the
                // lock button and gets a different world
                // — looks broken.
                if (!b) {
                  dreamBus.emit("dream:toast", {
                    kind: "info",
                    message: "Couldn't lock the current frame — using a fresh seed instead.",
                    ttlMs: 3000,
                  });
                }
                return b ?? generateSeedImage({ seed });
              })
            : await generateSeedImage({ seed });
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
            console.warn("[dream] seed upload timed out — aborting paint (no anchor image)");
          }
          if (!imageAccepted) {
            return "err";
          }
          const composed = opts?.promptOverride ?? buildPrompt(t);
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
      // QA4: emit dream:paintDone on all outcomes.
      const paintMs = Date.now() - paintStart;
      if (result === "ok") {
        setPhase("live");
        setError(null);
        dreamBus.emit("dream:paintDone", { ms: paintMs, ok: true });
      } else if (result === "err") {
        setError("Generation failed — your prompt is saved, try again in a moment");
        if (!generatingRef.current) setPhase("idle");
        dreamBus.emit("dream:paintDone", { ms: paintMs, ok: false });
      } else {
        setError("Reactor is slow — your prompt is saved. The world may still be painting in the background.");
        if (!generatingRef.current) setPhase("idle");
        dreamBus.emit("dream:paintDone", { ms: paintMs, ok: false });
      }
      inFlightRef.current = false;
      // Consume the pose lock — only affects the next paint.
      if (poseLocked) setPoseLocked(false);
      // QA5: epoch check. The abort handler bumps the
      // epoch when a sidebar pick happens. The old paint's
      // post-paint effect must not run if the epoch has
      // moved.
      if (myEpoch !== paintEpochRef.current) {
        return;
      }
      // If the active session changed mid-paint (sidebar pick), the
      // scene we just painted would be saved to the wrong journal.
      // The `abortedRef` flag is set by the `dream:abortPaint` event
      // handler. Skip the success commit in that case — the next
      // paint (triggered by the loadScene event) is the one we want
      // in the journal.
      if (abortedRef.current) {
        // Don't drain the queue — the caller is about to fire a new
        // loadScene that supersedes everything we were doing.
        return;
      }
      const next = queuedRef.current;
      queuedRef.current = null;
      if (next) {
        // Track this re-paint so we can cancel it on unmount and on
        // a sidebar-driven abort.
        if (repaintTimerRef.current !== null) clearTimeout(repaintTimerRef.current);
        // QA5: queueMicrotask drains the queue before the
        // event loop yields. The old setTimeout(0) left a
        // window where a parallel paint call could set
        // inFlightRef=true and the drain would then re-queue
        // onto the new paint. Also re-check inFlightRef
        // inside the drain.
        queueMicrotask(() => {
          if (inFlightRef.current) {
            queuedRef.current = next;
            return;
          }
          void paintDream(next);
        });
      }
    },
    // paintDream no longer depends on `snapshot` — it reads the live
    // value from `snapshotRef`. The fewer deps, the more stable the
    // function identity, the less the `dream:loadScene` listener
    // re-binds. (Audit bug #4.)
    [uploadFile, setImage, setPrompt, start, reset, poseLocked],
  );

  // Listen for scene-load events from the sidebar OR from the share-URL
  // consumption. Subscribed to our typed event bus (only our own
  // modules can emit — no global window event for browser extensions
  // to hijack).
  const paintDreamRef = useRef(paintDream);
  paintDreamRef.current = paintDream;
  useEffect(() => {
    return dreamBus.on("dream:loadScene", (detail) => {
      if (!detail?.prompt) return;
      // The abort event was already emitted by the sidebar before
      // this event arrived. Clear the flag so the *new* paint is
      // allowed to commit its scene.
      abortedRef.current = false;
      setText(detail.prompt);
      sessions.addScene({ prompt: detail.prompt, seed: detail.seed });
      void paintDreamRef.current(detail.prompt, { seed: detail.seed });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cooperative-abort: any caller about to switch the active session
  // (sidebar pick, curated gallery tap) fires this first so the
  // in-flight `paintDream` short-circuits before it would call
  // `addScene` on the wrong session.
  useEffect(() => {
    return dreamBus.on("dream:abortPaint", () => {
      abortedRef.current = true;
      // QA5: bump the epoch so the in-flight paint's post-paint
      // success commit (which can fire AFTER this abort) is
      // short-circuited. Without this, the old paint commits
      // its scene to the new active session and the user sees
      // their old phrase displayed in the new world.
      paintEpochRef.current += 1;
      // Cancel any pending deferred re-paint as well — there's a new
      // paint on the way and the queued one would land in the
      // wrong journal.
      if (repaintTimerRef.current !== null) {
        clearTimeout(repaintTimerRef.current);
        repaintTimerRef.current = null;
      }
      // QA5: clear the queue AND the in-flight flag so the
      // next paint starts with a clean slate and the old
      // paint's post-paint drain doesn't fire a stale phrase.
      queuedRef.current = null;
      inFlightRef.current = false;
    });
  }, []);

  // On mount, if the URL contains a shared dream (`?d=...`), auto-paint
  // it. This is the entry point for shareable URLs.
  useEffect(() => {
    const shared = readDreamFromUrl();
    if (!shared) return;
    setText(shared.prompt);
    // Defer one tick so the SDK is fully wired up.
    const t = setTimeout(() => {
      void paintDreamRef.current(shared.prompt, { seed: shared.seed });
    }, 250);
    clearDreamFromUrl();
    return () => clearTimeout(t);
  }, []);

  // On unmount, cancel any deferred re-paint so a torn-down SDK
  // provider doesn't receive paint commands from a queued tail.
  useEffect(() => {
    return () => {
      if (repaintTimerRef.current !== null) {
        clearTimeout(repaintTimerRef.current);
        repaintTimerRef.current = null;
      }
    };
  }, []);

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

// Auto-paint when voice commits a phrase. Guarded against the
  // double-addScene bug: voice.onFinal AND form submit both fire on
  // the same text if the user types and then talks — the dedupe
  // (audit bug #7) lives in `useSessions.addScene` which now keys on
  // prompt+seed so re-rolls don't dedupe.
  // Also routes the transcript through `parseVoiceStyle` so spoken
  // phrases like "in noir style" or "at sunset" toggle the chip
  // system and produce a cleaner prompt for the model.
  // QA5: styleId/variantId live in refs so onFinalCb has a
  // stable identity. Previously, every chip click re-bound
  // the voice listener and any `isFinal` event that landed
  // between the unsub and resub was dropped.
  const styleIdRef = useRef(styleId);
  const variantIdRef = useRef(variantId);
  useEffect(() => { styleIdRef.current = styleId; }, [styleId]);
  useEffect(() => { variantIdRef.current = variantId; }, [variantId]);
  const onFinalCb = useCallback((text: string) => {
    const t = text.trim();
    if (!t) return;
    const parsed = parseVoiceStyle(t);
    const sid = styleIdRef.current;
    const vid = variantIdRef.current;
    if (parsed.styleId && parsed.styleId !== sid) setStyleId(parsed.styleId);
    if (parsed.variantId && parsed.variantId !== vid) setVariantId(parsed.variantId);
    const cleaned = parsed.cleanedPrompt || t;
    setText(cleaned);
    const seed = hashSeed(cleaned + ":" + sessionNonceRef.current.toString(16)) >>> 0;
    sessions.addScene({ prompt: cleaned, seed });
    void paintDream(cleaned, { seed });
  }, [paintDream, sessions]);
  useEffect(() => {
    if (!voice.supported) return;
    return voice.onFinal(onFinalCb);
  }, [voice.supported, voice, onFinalCb]);

  // On first ready + no active session, also re-paint the last scene
  // of the active session if it has one.
  const restoredRef = useRef(false);
  useEffect(() => {
    if (!sessions.hydrated) return;
    if (restoredRef.current) return;
    const last = sessions.activeSession?.scenes[sessions.activeSession.scenes.length - 1];
    if (last && snapshot?.has_image === false) {
      restoredRef.current = true;
      setTimeout(() => {
        setText(last.prompt);
        void paintDream(last.prompt, { seed: last.seed });
      }, 500);
    } else {
      restoredRef.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions.hydrated, sessions.activeSession, snapshot?.has_image]);

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    setText("");
    const seed = hashSeed(t + ":" + sessionNonceRef.current.toString(16)) >>> 0;
    sessions.addScene({ prompt: t, seed });
    void paintDream(t, { seed });
  }

  function onReRoll() {
    // Re-roll: keep the same prompt, generate a fresh seed.
    const base = (text.trim() || lastPrompt || "").trim();
    if (!base) return;
    // Bump the sessionNonce so hashSeed(text + nonce) yields a new
    // value. We don't mutate the existing nonce — we fold a counter
    // into the hash input.
    const rollNonce = Math.floor(Math.random() * 0xffffffff);
    const seed = hashSeed(base + ":" + rollNonce.toString(16)) >>> 0;
    sessions.addScene({ prompt: base, seed });
    setLastPrompt(base);
    setLastSeed(seed);
    setText("");
    void paintDream(base, { seed });
  }

  // QA6/F5: Surprise me. Picks a fresh prompt from the
  // surprise list and auto-paints it. Solves the
  // empty-state problem for first-time users who don't
  // know what to type — and gives returning users a
  // way to break out of a creative rut.
  function onSurprise() {
    const p = pickSurprisePrompt();
    setText(p);
    setLastPrompt(p);
    const seed = hashSeed(p + ":" + sessionNonceRef.current.toString(16)) >>> 0;
    setLastSeed(seed);
    sessions.addScene({ prompt: p, seed });
    void paintDream(p, { seed });
  }

  async function onShare() {
    if (!lastPrompt) return;
    const seed = lastSeed ?? hashSeed(lastPrompt + ":" + sessionNonceRef.current.toString(16)) >>> 0;
    const url = buildShareUrl(lastPrompt, seed);
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Fallback: open a prompt the user can copy from.
      window.prompt("Copy this dream link:", url);
    }
  }

  const showHint = !lastPrompt && phase === "idle";

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
        {error && <p className="mt-1 text-xs text-red-300" role="status" aria-live="polite">{error}</p>}
      </div>

      <div className="flex flex-col gap-2">
        <ChipStrip
          chips={STYLE_PRESETS.map((p) => ({ id: p.id, label: p.label, emoji: p.emoji }))}
          activeId={styleId}
          onSelect={(id) => {
            setStyleId(id);
            // QA6/F2: mirror to the Director overlay so the
            // CSS cinema filter kicks in immediately.
            setDirectorState({ styleId: id });
          }}
          size="sm"
          dimmedIds={variantId && variantId !== "none" ? conflictingPresets : null}
          dimmedReason="Conflicts with the selected time/weather"
        />
        <ChipStrip
          chips={TIME_VARIANTS.map((v) => ({ id: v.id, label: v.label, emoji: v.emoji }))}
          activeId={variantId}
          onSelect={(id) => {
            setVariantId(id);
            setDirectorState({ variantId: id });
          }}
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

      <form onSubmit={onSubmit} className="flex gap-2" data-testid="desktop-dream-form">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Describe a new dream…"
          data-testid="desktop-dream-input"
          className="flex-1 rounded-full border border-white/10 bg-black/60 px-4 py-3 text-sm text-white placeholder:text-white/40 focus:border-white/30 focus:outline-none"
        />
        <button
          type="button"
          onClick={onReRoll}
          disabled={!lastPrompt && !text.trim()}
          aria-label="Re-roll the same prompt with a new seed"
          title="Re-roll"
          data-testid="desktop-reroll-btn"
          className="grid h-12 w-12 shrink-0 place-items-center rounded-full border border-white/10 bg-white/10 text-base text-white/85 transition hover:bg-white/20 disabled:opacity-40"
        >
          🎲
        </button>
        {/* QA6/F5: Surprise me. Sits next to the reroll
            button so it's discoverable. No disabled state —
            even a brand-new user with no lastPrompt can
            roll the dice. */}
        <button
          type="button"
          onClick={onSurprise}
          aria-label="Surprise me with a random dream"
          title="Surprise me"
          data-testid="desktop-surprise-btn"
          className="grid h-12 w-12 shrink-0 place-items-center rounded-full border border-amber-300/30 bg-amber-400/15 text-base text-amber-100 transition hover:bg-amber-400/30"
        >
          ✨
        </button>
        <button
          type="button"
          onClick={() => {
            setPoseLocked(true);
            setPoseLockedAt(Date.now());
          }}
          disabled={!lastPrompt && !text.trim()}
          aria-label="Lock the current frame as the next paint's anchor"
          title={poseLocked ? "Pose lock armed — next paint uses the current frame" : "Lock pose — evolve from the current frame"}
          data-testid="desktop-pose-lock-btn"
          className={[
            "grid h-12 w-12 shrink-0 place-items-center rounded-full border text-base transition",
            poseLocked
              ? "border-amber-400/60 bg-amber-500/30 text-white"
              : "border-white/10 bg-white/10 text-white/85 hover:bg-white/20 disabled:opacity-40",
          ].join(" ")}
        >
          📌
        </button>
        <button
          type="button"
          onClick={onShare}
          disabled={!lastPrompt}
          aria-label={copied ? "Link copied" : "Copy a shareable link to this dream"}
          title={copied ? "Copied!" : "Share"}
          data-testid="desktop-share-btn"
          className="grid h-12 w-12 shrink-0 place-items-center rounded-full border border-white/10 bg-white/10 text-base text-white/85 transition hover:bg-white/20 disabled:opacity-40"
        >
          {copied ? "✓" : "🔗"}
        </button>
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

function PhaseDot({ phase }: { phase: "idle" | "loading" | "live" }) {
  const color =
    phase === "live" ? "bg-emerald-400" : phase === "loading" ? "bg-amber-400" : "bg-white/30";
  return <span className={`inline-block h-1.5 w-1.5 rounded-full ${color}`} />;
}
