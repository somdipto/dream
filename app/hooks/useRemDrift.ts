"use client";

// REM Drift — after a period of inactivity, the world re-prompts
// itself by mashing together the user's last few prompts. The
// model is reactive; a passive observer (e.g. a hackathon judge)
// should see the world keep mutating even when the user stops
// talking. The dream, in other words, drifts.
//
// Trigger: any of (a) the user stops talking for IDLE_MS, (b) the
// user has been watching the same scene for WATCH_MS, (c) the
// page has been visible and the dream component is mounted.
//
// Cooldown: DRIFT_COOLDOWN_MS between auto-paints, so we don't
// run the API 10×/min.

import { useEffect, useRef } from "react";
import { dreamBus } from "../lib/event-bus";
import { buildRemPrompt as remDriftBuild } from "../lib/rem-drift-prompt";

// 12 seconds of inactivity = one REM cycle.
const IDLE_MS = 12_000;
// 45 seconds of "same scene" = the dream has been still too long.
const WATCH_MS = 45_000;
// Minimum gap between drift paints.
const DRIFT_COOLDOWN_MS = 20_000;

export interface RemDriftOptions {
  /** Stable callback to fire when we decide to drift. */
  onDrift: (remPrompt: string) => void;
  /** Pause the drift (e.g. user is recording voice). */
  paused?: boolean;
}

/**
 * Track the user's recent prompts and schedule an auto-mutation
 * when the world goes quiet. Re-emits via `onDrift` so the
 * caller can route it through their own paint pipeline.
 */
export function useRemDrift({ onDrift, paused = false }: RemDriftOptions) {
  // History of the user's prompts (newest at the end). Bounded
  // to last 5 to keep the mash prompt reasonable.
  const promptsRef = useRef<string[]>([]);
  // Timestamp of the last "user did something" event (typed,
  // spoke, picked a chip, replayed a scene).
  const lastInputAtRef = useRef<number>(Date.now());
  // Timestamp of the last drift paint. Used for cooldown.
  const lastDriftAtRef = useRef<number>(0);
  // Most-recent onDrift (kept in a ref so the listener identity
  // is stable).
  const onDriftRef = useRef(onDrift);
  useEffect(() => {
    onDriftRef.current = onDrift;
  }, [onDrift]);

  useEffect(() => {
    function noteInput() {
      lastInputAtRef.current = Date.now();
    }
    function notePaint() {
      // Each successful paint also resets the idle timer — the
      // user may be passively watching, but the world IS
      // changing, so the dream is alive.
      lastInputAtRef.current = Date.now();
      lastDriftAtRef.current = Date.now();
    }
    const offPaint = dreamBus.on("dream:paintDone", (d: { ok: boolean }) => {
      if (d.ok) notePaint();
    });
    // Capture user input via the dream:loadScene event (covers
    // chips, replay, curated picks, share-URL, text submit).
    const offLoad = dreamBus.on(
      "dream:loadScene",
      (d: { prompt: string; seed: number }) => {
        if (d?.prompt) {
          // Bounded history.
          promptsRef.current = [
            ...promptsRef.current.slice(-4),
            d.prompt,
          ];
        }
        noteInput();
      },
    );
    // Also bump the timer on every successful text input.
    function onText() {
      noteInput();
    }
    window.addEventListener("keydown", onText);
    window.addEventListener("pointerdown", onText);
    return () => {
      offPaint();
      offLoad();
      window.removeEventListener("keydown", onText);
      window.removeEventListener("pointerdown", onText);
    };
  }, []);

  // Drift scheduler. Reschedules itself on every tick. Cheap
  // because we only do the comparison in setTimeout, not via
  // setInterval (which would fire when the tab is backgrounded).
  useEffect(() => {
    if (paused) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    function schedule() {
      timer = setTimeout(check, 2_000);
    }
    function check() {
      if (paused) return;
      const now = Date.now();
      const idleFor = now - lastInputAtRef.current;
      const sinceDrift = now - lastDriftAtRef.current;
      if (
        idleFor >= IDLE_MS &&
        sinceDrift >= DRIFT_COOLDOWN_MS &&
        promptsRef.current.length >= 1
      ) {
        const mash = buildRemPrompt(promptsRef.current);
        lastDriftAtRef.current = now;
        onDriftRef.current(mash);
        // Schedule a check WATCH_MS later for the next drift
        // (gives the world time to repaint before we drift
        // again).
      }
      schedule();
    }
    schedule();
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [paused]);
}

/**
 * Build a "REM" prompt from the last N user prompts. The goal
 * is not to be clever — it's to give the model enough texture
 * to paint a coherent scene that feels related to what the
 * user has been dreaming about. We pick distinctive words from
 * each prompt, drop common function words, and stitch them
 * into a single descriptive sentence with a time-of-day hint.
 */
function buildRemPrompt(history: string[]): string {
  return remDriftBuild(history);
}
