"use client";

import { useEffect, useRef } from "react";
import { useLingbot } from "@reactor-models/lingbot";
import { useMotion } from "../hooks/useMotion";

// Headless component. Subscribes to gyroscope tilt and pushes the same
// `setMovement` / `setLookHorizontal` / `setLookVertical` commands
// the existing keyboard handler uses. Mounts inside <LingbotProvider>.
//
// CRITICAL: while the user is speaking, their phone is tilted forward
// 30-60° (talking-to-phone pose). Without suppression, that triggers
// `forward` movement and `look_down`, drifting the world before the
// model ever sees the spoken prompt. We freeze all axes while
// `voiceListening` is true.
//
// Lingbot wants *persistent state* — we hold each axis as "forward" /
// "idle" and only re-send when the state *changes*, not on every frame.
// Pulses can be dropped at chunk boundaries; persistent state cannot.
//
// Commands are throttled to ~12 Hz so the model's chunk boundary never
// sees stale state. The state-change guarantee means we never re-send
// the same value back-to-back.

type Movement = "idle" | "forward" | "back" | "strafe_left" | "strafe_right";
type LookH = "idle" | "left" | "right";
type LookV = "idle" | "up" | "down";

const THROTTLE_MS = 80;

export function GyroController({
  enabled,
  voiceListening,
}: {
  enabled: boolean;
  voiceListening: boolean;
}) {
  const { setMovement, setLookHorizontal, setLookVertical } = useLingbot();
  const motion = useMotion();

  const lastSent = useRef({
    movement: "idle" as Movement,
    lookH: "idle" as LookH,
    lookV: "idle" as LookV,
  });
  const lastTime = useRef(0);

  // Depend on primitives, not the wrapper object — useMotion returns a
  // memoized object but this is the safest pattern.
  const { permission, moving, turning, pitch } = motion;

  useEffect(() => {
    if (!enabled) return;
    if (permission === "denied" || permission === "unsupported") return;
    // While the user is speaking, freeze all axes to prevent the
    // talking-to-phone pose from drifting the world.
    if (voiceListening) {
      if (lastSent.current.movement !== "idle") {
        setMovement({ movement: "idle" });
        lastSent.current.movement = "idle";
      }
      if (lastSent.current.lookH !== "idle") {
        setLookHorizontal({ look_horizontal: "idle" });
        lastSent.current.lookH = "idle";
      }
      if (lastSent.current.lookV !== "idle") {
        setLookVertical({ look_vertical: "idle" });
        lastSent.current.lookV = "idle";
      }
      return;
    }

    const now = performance.now();
    if (now - lastTime.current < THROTTLE_MS) return;
    lastTime.current = now;

    const movement: Movement =
      moving === "forward" ? "forward" : moving === "backward" ? "back" : "idle";

    const lookH: LookH =
      turning === "left" ? "left" : turning === "right" ? "right" : "idle";

    // Gentle pitch (below the walk threshold) → look up/down. Reuses the
    // same axis: tipping top toward user (positive pitch) means "look
    // down at the ground in front of you", like checking your phone.
    let lookV: LookV = "idle";
    if (pitch > 12 && pitch < 30) lookV = "down";
    else if (pitch < -10 && pitch > -25) lookV = "up";

    if (movement !== lastSent.current.movement) {
      setMovement({ movement });
      lastSent.current.movement = movement;
    }
    if (lookH !== lastSent.current.lookH) {
      setLookHorizontal({ look_horizontal: lookH });
      lastSent.current.lookH = lookH;
    }
    if (lookV !== lastSent.current.lookV) {
      setLookVertical({ look_vertical: lookV });
      lastSent.current.lookV = lookV;
    }
  }, [enabled, voiceListening, permission, moving, turning, pitch, setMovement, setLookHorizontal, setLookVertical]);

  return null;
}