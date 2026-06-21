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
    // QA16: set to true on the rising edge of voiceListening
    // flipping false, so the next effect run can detect a
    // resume-from-voice and reset the throttle clock.
    justResumed: false,
  });
  // QA16: track the previous voiceListening value so we can
  // detect the false-edge and arm the resume flag.
  const wasListeningRef = useRef(voiceListening);
  const lastTime = useRef(0);

  // Depend on primitives, not the wrapper object — useMotion returns a
  // memoized object but this is the safest pattern.
  const { permission, moving, turning, pitch } = motion;

  useEffect(() => {
    if (!enabled) return;
    if (permission === "denied" || permission === "unsupported") return;
    // QA16: detect the falling edge of voiceListening so the next
    // tick isn't throttled into oblivion (see the throttle check
    // below). Without this arming, the user's first gyro sample
    // after a voice burst could be silently dropped, leaving the
    // world stuck in "idle" until 80ms later.
    if (wasListeningRef.current && !voiceListening) {
      lastSent.current.justResumed = true;
    }
    wasListeningRef.current = voiceListening;
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
    // QA16: the prior run was suppressing while voiceListening was
    // true — lastTime.current is stale from before that suppression
    // started, so the *first* post-voice sample can be silently
    // dropped by the throttle. We track which tick we last sent on
    // so we can detect a resume-from-voice and reset the clock.
    const resumingFromVoice = lastSent.current.justResumed;
    if (resumingFromVoice) {
      lastSent.current.justResumed = false;
      lastTime.current = 0;
    }
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