"use client";

// useMotionFlicks — detect "flicks" (sharp angular gestures) from
// the device's orientation sensor and emit a paint prompt derived
// from the direction of the flick.
//
// Product intent: the user explicitly wanted a build that fuses
// gyroscope motion with voice input. Voice already drives text
// prompts. Flick-to-paint closes the loop — when the user *physically*
// moves the phone in a deliberate way, the world reacts. Examples:
//   - 180° snap around (yaw) → "the world spins / a portal opens"
//   - tilt forward past 70° → "the camera dives"
//   - tilt back past -50° → "we lift off, skyward"
//   - snap roll left/right → "the horizon tilts, then rights itself"
//
// Thresholds tuned for the same "deliberate gesture, not wrist
// tremor" feel as GyroController's deadzones.

import { useEffect, useRef } from "react";

export type FlickKind =
  | "spin" // rapid yaw rotation
  | "dive" // sharp forward tilt
  | "lift" // sharp back tilt
  | "roll"; // sharp roll

export interface FlickEvent {
  kind: FlickKind;
  /** Signed magnitude (degrees / second for spin, degrees for dive/lift/roll). */
  magnitude: number;
  /** ISO timestamp at detection time. */
  at: number;
}

export interface MotionFlicksOptions {
  /** Disable detection. */
  paused?: boolean;
  /** Called once per detected flick (deduped by a 600ms cool-down). */
  onFlick: (e: FlickEvent) => void;
}

// Threshold values — keep aligned with the same UX vocabulary as
// GyroController. A "deliberate flick" is one full step beyond
// what GyroController treats as a normal tilt.
const YAW_FLICK_DEG_PER_SEC = 280; // a quick look-around
const PITCH_FLICK_FORWARD_DEG = 65; // well beyond FORWARD_THRESHOLD_DEG (38)
const PITCH_FLICK_BACK_DEG = -45; // well beyond BACKWARD_THRESHOLD_DEG (-35)
const ROLL_FLICK_DEG = 50; // phone sideways past neutral
const FLICK_COOLDOWN_MS = 600;

/**
 * Listen to deviceorientation + devicemotion (when available) and
 * emit a FlickEvent when the user makes a sharp, deliberate gesture.
 * Reuses a single onFlick ref so the subscription effect's identity
 * stays stable across renders — callers can pass a fresh closure
 * without re-binding the sensor listeners.
 */
export function useMotionFlicks({ paused, onFlick }: MotionFlicksOptions) {
  const onFlickRef = useRef(onFlick);
  useEffect(() => {
    onFlickRef.current = onFlick;
  }, [onFlick]);
  const pausedRef = useRef(!!paused);
  useEffect(() => {
    pausedRef.current = !!paused;
  }, [paused]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (paused) return;
    let lastYaw: number | null = null;
    let lastT = 0;
    let coolUntil = 0;

    function onOrient(e: DeviceOrientationEvent) {
      if (pausedRef.current) return;
      const yaw = e.alpha;
      const pitch = e.beta;
      const roll = e.gamma;
      const now = performance.now();
      if (
        typeof yaw !== "number" ||
        typeof pitch !== "number" ||
        typeof roll !== "number"
      ) {
        return;
      }
      if (lastYaw === null) {
        lastYaw = yaw;
        lastT = now;
        return;
      }
      const dt = Math.max(1, now - lastT);
      // Yaw wraps at 360 — choose the signed shortest path.
      let dyaw = yaw - lastYaw;
      if (dyaw > 180) dyaw -= 360;
      if (dyaw < -180) dyaw += 360;
      const yawRate = (dyaw / dt) * 1000; // deg / sec
      const nowMs = Date.now();
      const cool = nowMs < coolUntil;
      if (!cool) {
        if (Math.abs(yawRate) >= YAW_FLICK_DEG_PER_SEC) {
          onFlickRef.current({
            kind: "spin",
            magnitude: yawRate,
            at: nowMs,
          });
          coolUntil = nowMs + FLICK_COOLDOWN_MS;
        } else if (pitch >= PITCH_FLICK_FORWARD_DEG) {
          onFlickRef.current({
            kind: "dive",
            magnitude: pitch,
            at: nowMs,
          });
          coolUntil = nowMs + FLICK_COOLDOWN_MS;
        } else if (pitch <= PITCH_FLICK_BACK_DEG) {
          onFlickRef.current({
            kind: "lift",
            magnitude: pitch,
            at: nowMs,
          });
          coolUntil = nowMs + FLICK_COOLDOWN_MS;
        } else if (Math.abs(roll) >= ROLL_FLICK_DEG) {
          onFlickRef.current({
            kind: "roll",
            magnitude: roll,
            at: nowMs,
          });
          coolUntil = nowMs + FLICK_COOLDOWN_MS;
        }
      }
      lastYaw = yaw;
      lastT = now;
    }

    window.addEventListener("deviceorientation", onOrient);
    return () => {
      window.removeEventListener("deviceorientation", onOrient);
    };
  }, [paused]);
}

/**
 * Default flick → prompt mapping. Kept here so the prompt wording
 * stays consistent across mobile/desktop and so the strings are
 * easily localizable in one place later.
 */
export function flickToPrompt(kind: FlickKind): string {
  switch (kind) {
    case "spin":
      return "the world spins, a portal opens at the center";
    case "dive":
      return "the camera dives down through the scene";
    case "lift":
      return "we lift off, soaring skyward";
    case "roll":
      return "the horizon tilts dramatically then rights itself";
  }
}
