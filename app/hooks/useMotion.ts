"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// Browser-side device orientation. Wraps `DeviceOrientationEvent` with
// the iOS 13+ permission gate, EMA smoothing, a per-axis deadzone to
// suppress wrist tremor, and a `recalibrate()` reset.
//
// Conventions for the returned angles (degrees):
//   pitch: -180..180,  +ve = phone's top tipping toward user (looking down)
//   roll:  -90..90,     +ve = phone's right side tipping up (rolling right)
//   yaw:   -180..180,   relative to the last recalibrate() — 0 = facing forward
//
// These are device-frame Euler angles. AR overlay use would need a
// quaternion to avoid gimbal lock at extreme pitches — out of scope.

export interface MotionTilt {
  pitch: number;
  roll: number;
  yaw: number;
  /** True once we've received at least one orientation event. */
  available: boolean;
  permission: "default" | "granted" | "denied" | "unsupported";
}

export interface MotionControls extends MotionTilt {
  /** iOS only — MUST be called from inside a user-gesture handler. */
  requestPermission: () => Promise<"granted" | "denied" | "unsupported">;
  /** Re-zero yaw to "wherever the phone is facing right now." */
  recalibrate: () => void;
  /** Classification of current tilt (post-deadzone). */
  moving: "idle" | "forward" | "backward";
  turning: "idle" | "left" | "right";
}

// ponytail: thresholds tuned for phone-as-controller.
// - 38° forward: a user holding the phone at rest naturally reads
//   30-40° pitch, so anything below 38° should be "at rest", not
//   "walking". The user must deliberately tip the phone further
//   forward to walk — exactly what they want per feedback.
// - 12° lookV: gentle enough that wrist tremor doesn't fire constant look-down.
// - 3° pitch / 2° yaw deadzone: suppresses wrist micro-tremor.
const FORWARD_THRESHOLD_DEG = 38;
const BACKWARD_THRESHOLD_DEG = -35;
const LOOK_H_THRESHOLD_DEG = 15;
const LOOK_V_PITCH_LOW = 12;
const LOOK_V_PITCH_HIGH = -10;
const PITCH_DEADZONE_DEG = 3;
const YAW_DEADZONE_DEG = 2;
const EMA_ALPHA = 0.2;

export function useMotion(
  options: {
    forwardThreshold?: number;
    backwardThreshold?: number;
    lookHThreshold?: number;
    emaAlpha?: number;
  } = {},
): MotionControls {
  const fwdT = options.forwardThreshold ?? FORWARD_THRESHOLD_DEG;
  const backT = options.backwardThreshold ?? BACKWARD_THRESHOLD_DEG;
  const lookT = options.lookHThreshold ?? LOOK_H_THRESHOLD_DEG;
  const alpha = options.emaAlpha ?? EMA_ALPHA;

  const [permission, setPermission] = useState<MotionTilt["permission"]>("default");
  const [tilt, setTilt] = useState<{ pitch: number; roll: number; yaw: number; available: boolean }>({
    pitch: 0,
    roll: 0,
    yaw: 0,
    available: false,
  });

  const smoothed = useRef({ pitch: 0, roll: 0, yaw: 0 });
  const yawBaseline = useRef<number | null>(null);

  const requestPermission = useCallback(async (): Promise<"granted" | "denied" | "unsupported"> => {
    const DOE = (window as any).DeviceOrientationEvent;
    if (typeof DOE === "undefined") return "unsupported";
    if (typeof DOE.requestPermission !== "function") {
      // Android Chrome — no gate; permission is granted by browser policy.
      setPermission("granted");
      return "granted";
    }
    try {
      const r = await DOE.requestPermission();
      setPermission(r === "granted" ? "granted" : "denied");
      return r === "granted" ? "granted" : "denied";
    } catch {
      setPermission("denied");
      return "denied";
    }
  }, []);

  const recalibrate = useCallback(() => {
    yawBaseline.current = null;
    smoothed.current.pitch = 0;
    smoothed.current.roll = 0;
    smoothed.current.yaw = 0;
    setTilt((t) => ({ ...t, pitch: 0, roll: 0, yaw: 0 }));
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const DOE = (window as any).DeviceOrientationEvent;
    if (typeof DOE === "undefined") {
      setPermission("unsupported");
      return;
    }
    if (typeof DOE.requestPermission === "function" && permission !== "granted") {
      return;
    }

    const onOrientation = (e: DeviceOrientationEvent) => {
      const rawPitch = e.beta ?? 0;
      const rawRoll = e.gamma ?? 0;
      const rawYaw = e.alpha ?? 0;

      smoothed.current.pitch = smoothed.current.pitch * (1 - alpha) + rawPitch * alpha;
      smoothed.current.roll = smoothed.current.roll * (1 - alpha) + rawRoll * alpha;

      // Recalibrate yaw baseline on the first reading.
      if (yawBaseline.current === null) yawBaseline.current = rawYaw;
      const yawRel = rawYaw - yawBaseline.current;
      const yawNorm = ((yawRel + 540) % 360) - 180;
      smoothed.current.yaw = smoothed.current.yaw * (1 - alpha) + yawNorm * alpha;

      // Per-axis deadzone: snap to 0 inside the deadzone. Removes wrist
      // micro-tremor without waiting for the EMA to settle.
      const pitch =
        Math.abs(smoothed.current.pitch) < PITCH_DEADZONE_DEG ? 0 : smoothed.current.pitch;
      const yaw =
        Math.abs(smoothed.current.yaw) < YAW_DEADZONE_DEG ? 0 : smoothed.current.yaw;
      const roll = smoothed.current.roll;

      setTilt({ pitch, roll, yaw, available: true });
    };

    window.addEventListener("deviceorientation", onOrientation);
    return () => {
      window.removeEventListener("deviceorientation", onOrientation);
    };
  }, [permission, alpha]);

  // Classify movement + turning from current tilt.
  const moving: "idle" | "forward" | "backward" =
    tilt.pitch > fwdT ? "forward" : tilt.pitch < backT ? "backward" : "idle";
  const turning: "idle" | "left" | "right" =
    tilt.yaw < -lookT ? "left" : tilt.yaw > lookT ? "right" : "idle";

  // ponytail: destructure primitives so consumers can depend on stable
  // values, not the wrapper object reference.
  return useMemo(
    () => ({
      pitch: tilt.pitch,
      roll: tilt.roll,
      yaw: tilt.yaw,
      available: tilt.available,
      permission,
      requestPermission,
      recalibrate,
      moving,
      turning,
    }),
    [tilt, permission, requestPermission, recalibrate, moving, turning],
  );
}