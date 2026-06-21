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
import { dreamBus } from "../lib/event-bus";
import { _takePendingDailyScene } from "../LingbotApp";
import { recordBlackScreen } from "../lib/black-screen-log";
import { parseVoiceStyle } from "../lib/voice-style-parser";
import { captureCurrentFrame } from "../lib/pose-lock";
import { pickSurprisePrompt } from "../lib/surprise-prompts";
import { setDirectorState } from "../lib/director-state";

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
  // QA16/A11Y-1: live-region text for screen readers. Updated
  // on the dreamBus paint events so a blind user gets "Painting
  // started for 'a sunlit beach'…" / "…finished in 2.3 seconds"
  // / "…failed, your prompt is saved" without the announcements
  // clobbering the visible mic status line.
  const [paintingAnnouncement, setPaintingAnnouncement] = useState("");
  const [pulse, setPulse] = useState(0); // increments on every send → animates "live" indicator
  const [muted, setMuted] = useState(false);
  const [styleId, setStyleId] = useState<string | null>(null);
  const [variantId, setVariantId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [text, setText] = useState("");
  // Pose Lock — when true, the next paint uses the captured current
  // frame as the seed image instead of a fresh noise gradient.
  const [poseLocked, setPoseLocked] = useState(false);

  const inFlightRef = useRef(false);
  const queuedRef = useRef<string | null>(null);
  const sessionNonceRef = useRef<number>(Math.floor(Math.random() * 0xffffffff));
  // Live mirror of `snapshot` for use inside async closures. (Audit
  // bug #5: paintDream was reading stale snapshot state.)
  const snapshotRef = useRef<LingbotStateMessage | null>(null);
  // Track the last in-flight paint's text so a re-roll can re-paint
  // it without the user re-typing.
  const lastPaintedRef = useRef<string | null>(null);
  // Set to true when the user picks a different session from the
  // sidebar (or the curated gallery). Each Promise.race winner in
  // `paintDream` checks this flag and short-circuits if it's true,
  // so an in-flight paint doesn't commit its scene to the wrong
  // journal after the active session has already changed.
  const abortedRef = useRef(false);
  // QA5: paintEpoch increments on every new paint. Each paint
  // captures the epoch it was scheduled at; before committing
  // a scene to the journal, the paint checks the current
  // epoch — if it has advanced, the paint is stale and must
  // not commit. This is the only reliable way to drop
  // success-path writes from a paint that was aborted
  // mid-flight, since `abortedRef` can race the success
  // commit (the SDK's onresult can fire after the abort).
  const paintEpochRef = useRef(0);
  // ID of the deferred re-paint `setTimeout` so we can cancel it on
  // unmount (prevents a torn-down provider from receiving paint
  // commands) and on a new paint starting before the previous one
  // has been scheduled.
  const repaintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Wrap the state callback in useCallback with stable deps so the
  // SDK doesn't unsubscribe/resubscribe on every render.
  const onState = useCallback((msg: LingbotStateMessage) => {
    setSnapshot(msg);
    snapshotRef.current = msg;
  }, []);
  useLingbotState(onState);

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
      // QA5: bump the epoch. Any success commit that completes
      // AFTER the epoch has advanced is stale and must not
      // write to the journal. This is the only thing that
      // actually catches a paint that races an abort.
      const myEpoch = ++paintEpochRef.current;
      setError(null);
      setLastPrompt(text);
      lastPaintedRef.current = text;
      setPulse((p) => p + 1);
      setPhase("loading");

      const paintStart = Date.now();
      const seed = (opts?.seed ?? hashSeed(text + ":" + sessionNonceRef.current.toString(16))) >>> 0;
      setLastSeed(seed);

      // QA15 fix: raised from 8s → 30s. The Begin overlay tells
      // the user "this usually takes 5-15 seconds" but the first
      // paint of a fresh connection takes 8-20s on a slow link
      // (uploadFile round-trip + image upload + first chunk). At
      // 8s the timeout fired reliably for the very first paint
      // and showed the red "Reactor is slow" banner even though
      // the world was about to stream. 30s gives the pipeline a
      // real chance while still surfacing an error on a genuine
      // hang.
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      const timeoutPromise = new Promise<"timeout">((resolve) => {
        timeoutId = setTimeout(() => resolve("timeout"), 30000);
      });
      const pipeline = (async (): Promise<"ok" | "err"> => {
        try {
          // First-paint path: there is no prior generation, so
          // `useLingbotGenerationReset` will never fire a callback.
          // Race the reset promise against 1.5s and treat timeout as
          // "no reset was needed, proceed". (Audit bug #2.)
          if (snapshotRef.current?.started || snapshotRef.current?.has_image) {
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
                // QA6: tell the user when the locked frame
                // couldn't be captured (most often: cross-
                // origin video tainted the canvas). Falling
                // back to a seed image is correct, but the
                // user clicked the lock button expecting the
                // *current* frame — silent fallback feels
                // broken. Emitted as a one-shot toast.
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
            console.warn("[dream] seed upload timed out — aborting paint");
            recordBlackScreen({
              source: "seed-upload-timeout",
              prompt: text,
              seed,
              sessionId: null,
              luma: null,
              note: "setImage never confirmed within 6s",
            });
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
      // QA4: emit dream:paintDone on ALL outcomes (success,
      // failure, timeout) so the StatusBadge can show "failed"
      // in red. Previously only success emitted; failure left
      // the badge stuck on the last successful duration.
      const paintMs = Date.now() - paintStart;
      if (result === "ok") {
        setPhase("live");
        setError(null);
        dreamBus.emit("dream:paintDone", { ms: paintMs, ok: true });
      } else if (result === "err") {
        setError("Generation failed — your prompt is saved, try again in a moment");
        if (!snapshotRef.current?.started) setPhase("idle");
        dreamBus.emit("dream:paintDone", { ms: paintMs, ok: false });
      } else {
        setError("Reactor is slow — your prompt is saved. The world may still be painting in the background.");
        recordBlackScreen({
          source: "render-timeout",
          prompt: text,
          seed,
          sessionId: null,
          luma: null,
          note: "pipeline Promise.race hit 8s timeout",
        });
        if (!snapshotRef.current?.started) setPhase("idle");
        dreamBus.emit("dream:paintDone", { ms: paintMs, ok: false });
      }
      inFlightRef.current = false;
      // Consume the pose lock — only affects the next paint.
      if (poseLocked) setPoseLocked(false);
      // QA5: epoch check. If the paint we just finished is
      // older than the current epoch, another paint has
      // already started (the abortPaint handler bumped the
      // epoch when the user picked a sidebar scene). Drop
      // every post-paint effect — phase, prompt, queue drain.
      // Without this, the old paint's queued tail runs and
      // overwrites the sidebar-pick's prompt in the visible
      // state.
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
        // onto the new paint instead of running on its own.
        // Also re-check inFlightRef inside the drain so we
        // skip if another paint started in the gap.
        queueMicrotask(() => {
          if (inFlightRef.current) {
            // Re-queue and bail. The next paint's tail
            // drain will pick this up.
            queuedRef.current = next;
            return;
          }
          void paintDream(next);
        });
      }
    },
    [ready, uploadFile, setImage, setPrompt, start, reset, poseLocked],
  );

  // Stable ref for use inside effects that shouldn't re-bind on every
  // paint identity change. (Audit bug #4 / #18.)
  const paintDreamRef = useRef(paintDream);
  paintDreamRef.current = paintDream;

  // Auto-send on every committed phrase from the speech engine. The
  // useVoice hook fires this for both `isFinal` events and the
  // silence-flush, so the world mutates the moment the user pauses.
  // Wrap the handler in useCallback so the listener identity is
  // stable; the previous effect re-bound every render because
  // `voice` and `sessions` are non-memoized objects.
  // Also routes the transcript through `parseVoiceStyle` so spoken
  // phrases like "in noir style" or "at sunset" toggle the chip
  // system and produce a cleaner prompt for the model.
  //
  // QA5: styleId and variantId live in refs so onFinalCb has
  // a stable identity. Previously, every chip click re-bound
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
    const seed = hashSeed(cleaned + ":" + sessionNonceRef.current.toString(16)) >>> 0;
    sessions.addScene({ prompt: cleaned, seed });
    void paintDreamRef.current(cleaned, { seed });
  }, [sessions]);
  useEffect(() => {
    if (!ready) return;
    return voice.onFinal(onFinalCb);
    // QA16: depend on the stable `voice.onFinal` callback,
    // not the `voice` object (which is a fresh literal on
    // every render of useVoice). Otherwise every re-render
    // detaches and re-attaches the listener, and any final
    // event between is dropped on the floor.
  }, [ready, voice.onFinal, onFinalCb]);

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
  }, [ready, muted, voice.listening, voice.supported, voice.error, voice.start]);

  // Listen for scene-load events from the sidebar (curated picks,
  // past scene replay). Saves to the journal so the pick shows up in
  // the sidebar — the desktop path already does this; mobile was
  // missing the listener entirely so curated taps silently no-op'd.
  // Now subscribes to the typed event bus instead of window so a
  // browser extension cannot inject prompts.
  //
  // QA16/F-product: also listen for `flick:prompt` from
  // MobileFlickPaint. Each physical gesture (spin / dive / lift /
  // roll) emits a paint prompt that flows through the same
  // pipeline as a chip tap, so the world reacts to a sharp
  // phone-tilt exactly the way it reacts to a spoken sentence.
  useEffect(() => {
    const offLoad = dreamBus.on("dream:loadScene", (detail) => {
      if (!detail?.prompt) return;
      // The abort event was already emitted by the sidebar before
      // this event arrived. Clear the flag so the *new* paint is
      // allowed to commit its scene.
      abortedRef.current = false;
      setLastPrompt(detail.prompt);
      setLastSeed(detail.seed);
      setText(detail.prompt);
      sessions.addScene({ prompt: detail.prompt, seed: detail.seed });
      void paintDreamRef.current(detail.prompt, { seed: detail.seed });
    });
    const offFlick = dreamBus.on("flick:prompt", (detail) => {
      if (!detail?.prompt) return;
      // Flick = "physical prompt". Same shape as a chip tap.
      abortedRef.current = false;
      setLastPrompt(detail.prompt);
      // Flick doesn't carry a seed — use Date.now() so the model
      // gets a unique world-state and the new scene shows up
      // fresh in the sidebar.
      const seed = Date.now();
      setLastSeed(seed);
      setText(detail.prompt);
      sessions.addScene({ prompt: detail.prompt, seed });
      void paintDreamRef.current(detail.prompt, { seed });
    });
    return () => {
      offLoad();
      offFlick();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // QA16: drain the Begin-tap Daily Dream slot. Replaces the
  // 200ms setTimeout in LingbotApp.handleBegin — even if the
  // Begin-tap emit fired before this listener was attached,
  // the slot keeps the scene around for the Dream surface to
  // pick up. We re-emit through the same bus so the regular
  // listener path runs the paint, including the abort /
  // epoch / scene-add logic.
  useEffect(() => {
    const slot = _takePendingDailyScene();
    if (slot) {
      // Defer one tick so the abort listener above has
      // subscribed; the loadScene listener is at line 464, so
      // by next macrotask it's bound. Even on a slow phone
      // this is enough.
      const t = setTimeout(() => {
        dreamBus.emit("dream:loadScene", slot);
      }, 0);
      return () => clearTimeout(t);
    }
  }, []);

  // Cooperative-abort: any caller about to switch the active session
  // (sidebar pick, curated gallery tap) fires this first so the
  // in-flight `paintDream` short-circuits before it would call
  // `addScene` on the wrong session.
  useEffect(() => {
    return dreamBus.on("dream:abortPaint", () => {
      abortedRef.current = true;
      // QA5: bump the epoch so the in-flight paint's success
      // commit (which can fire AFTER this abort) is short-
      // circuited. Without this, the old paint commits its
      // scene to the new active session and the user sees
      // their old phrase displayed in the new world.
      paintEpochRef.current += 1;
      // Cancel any pending deferred re-paint as well — there's a new
      // paint on the way and the queued one would land in the
      // wrong journal.
      if (repaintTimerRef.current !== null) {
        clearTimeout(repaintTimerRef.current);
        repaintTimerRef.current = null;
      }
      // QA5: clear the queue AND the in-flight flag. The
      // old paint's post-paint drain would otherwise pick
      // up the queued text and paint it under the new
      // active session. The new paint (triggered by the
      // loadScene that follows) starts with a clean slate.
      queuedRef.current = null;
      inFlightRef.current = false;
    });
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

  // QA16/A11Y-1: screen-reader live-region bridge. Listen to
  // the paint lifecycle events and translate them into short
  // announcements. We key off `pulse` (which ticks on every
  // send) for "Painting started" and dream:paintDone for the
  // outcome. The strings are short on purpose — screen
  // readers interrupt each other, so a 4-word update reads
  // better than a 14-word one. Clear the message after 4s
  // so identical re-paints don't spam the live region with
  // stale text.
  useEffect(() => {
    if (pulse === 0) return;
    setPaintingAnnouncement("Painting started.");
    const t = setTimeout(() => setPaintingAnnouncement(""), 4000);
    return () => clearTimeout(t);
  }, [pulse]);
  useEffect(() => {
    // QA16/R3: previous version scheduled a 4s setTimeout inside
    // the dreamBus.on callback and returned a cleanup from
    // there — but the bus's listener type is `(detail) => void`,
    // so the returned function was discarded. After 5 fast
    // paints, 5 timers were racing to clear the announcement,
    // the first of which could fire mid-announcement and blank
    // the live region prematurely (and after unmount, the
    // stale timer would setState on an unmounted fiber).
    // We now own the timer in a ref, clear it on every new
    // event, and clear it on unmount via the effect's own
    // return.
    let clearTimer: ReturnType<typeof setTimeout> | null = null;
    const off = dreamBus.on("dream:paintDone", (detail: { ms: number; ok: boolean }) => {
      if (clearTimer) clearTimeout(clearTimer);
      if (detail.ok) {
        const seconds = (detail.ms / 1000).toFixed(1);
        setPaintingAnnouncement(`Paint finished in ${seconds} seconds.`);
      } else {
        setPaintingAnnouncement("Paint failed. Your prompt is saved — try again.");
      }
      clearTimer = setTimeout(() => setPaintingAnnouncement(""), 4000);
    });
    return () => {
      off();
      if (clearTimer) clearTimeout(clearTimer);
    };
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

  // QA6/F5: Surprise me. Same as DesktopDream's variant —
  // picks a fresh prompt from the curated surprise list and
  // auto-paints it. Even users with no prior prompt can
  // tap it.
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
          onSelect={(id) => {
            setStyleId(id);
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
        {/* QA6/F5: Surprise me. */}
        <button
          type="button"
          onClick={onSurprise}
          aria-label="Surprise me with a random dream"
          title="Surprise me"
          data-testid="mobile-surprise-btn"
          className="grid h-10 w-10 place-items-center rounded-full border border-amber-300/30 bg-amber-400/15 text-amber-100 transition hover:bg-amber-400/30"
        >
          ✨
        </button>
        <button
          type="button"
          onClick={() => setPoseLocked((p) => !p)}
          disabled={!lastPrompt}
          aria-label="Lock the current frame as the next paint's anchor"
          title={poseLocked ? "Pose lock armed" : "Lock pose"}
          data-testid="mobile-pose-lock-btn"
          className={[
            "grid h-10 w-10 place-items-center rounded-full border text-white/85 transition disabled:opacity-40",
            poseLocked
              ? "border-amber-400/60 bg-amber-500/30"
              : "border-white/10 bg-white/10 hover:bg-white/20",
          ].join(" ")}
        >
          📌
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
        <div className="flex flex-col items-center gap-1">
          <button
            type="button"
            onClick={onMicClick}
            disabled={!voice.supported}
            // QA6: allow tapping the mic to retry even
            // while the SDK is reconnecting. Previously the
            // `disabled={... || !ready}` cut off "Tap to
            // retry" the moment a `ready` blip occurred —
            // user had to wait for the SDK to finish
            // reconnecting before they could try again,
            // and voice.error stayed visible the entire
            // time. The retry path itself is best-effort
            // (start() returns early if `shouldListenRef`
            // is false) so a tap during reconnect is safe.
            data-testid="mobile-mic-btn"
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
          {/* QA4: live audio-level meter. Renders a small
              bar under the mic that grows with the user's
              volume. Gives an at-a-glance "is my voice being
              captured?" signal — without it, a user muting
              themselves or speaking too quietly can't tell. */}
          {voice.listening && !muted && (
            <div
              role="meter"
              aria-label="Microphone level"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(voice.level * 100)}
              data-testid="mic-level"
              className="h-1 w-16 overflow-hidden rounded-full bg-white/10"
            >
              <div
                className="h-full rounded-full bg-emerald-400/80 transition-[width] duration-75"
                style={{ width: `${Math.round(voice.level * 100)}%` }}
              />
            </div>
          )}
          <p
            className="rounded-full bg-black/70 px-3 py-1 text-[11px] uppercase tracking-wider text-white/85 backdrop-blur"
            aria-live="polite"
            // QA11/A11Y-5: bumped to text-white/85 (7:1
            // contrast on dark) and wrapped in a dark
            // backdrop pill so the caption reads against
            // any underlying surface (the cream fallback
            // during the connecting state used to make
            // the white caption invisible).
          >
            {muted
              ? "Muted"
              : voice.listening
                ? "Listening"
                : !voice.supported
                  ? "Mic unavailable — use the text input below"
                  : voice.error
                    ? "Tap to retry"
                    : "Tap to speak"}
          </p>
        </div>

      {/* QA16/A11Y-1: hidden live region for screen readers so
          paint starts/finishes/errors get announced without
          stealing focus or clobbering the visible mic
          status line above. Visually hidden, semantically
          present. Announces on state transition only —
          the message is keyed by a tiny useEffect that
          touches `paintingAnnouncement` on each transition. */}
      <p
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {paintingAnnouncement}
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
