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
  // QA16: remember the LAST value we exposed via state so we
  // can skip setTilt when the deviceorientation event didn't
  // move the quantized value. 0.5° bins are imperceptible to
  // the player but cut the React render storm from 60Hz to
  // typically <5Hz when the phone is held still. With a
  // fresh value every event the `useMemo` below also re-ran
  // 60x/s, which cascaded a re-render into every consumer of
  // the returned wrapper object — DirectorOverlay,
  // VRView's lookV/lookH, GyroController, etc.
  const lastExposedRef = useRef({ pitch: 0, roll: 0, yaw: 0 });
  // QA17: mirror of `tilt.available` for use inside the
  // onOrientation callback. The callback captures `tilt` from
  // the closure (and the effect deps are [permission, alpha],
  // both stable), so `tilt.available` is forever false inside
  // the callback even after the very first event flips it
  // true. That re-entered the `if (!tilt.available)` branch
  // on every subsequent event and called setTilt({available:true})
  // again — a no-op for React but a guaranteed re-render of
  // every motion consumer on every frame. Read/write the
  // ref instead and let the real `tilt` state stay for
  // the public hook surface.
  const availableRef = useRef(false);
  const TILT_QUANTUM_DEG = 0.5;

  const requestPermission = useCallback(async (): Promise<"granted" | "denied" | "unsupported"> => {
    const DOE = (window as any).DeviceOrientationEvent;
    // QA4: set the permission state synchronously so the
    // UI reflects reality even when the caller doesn't read
    // the return value. Previously the unsupported branch
    // returned without ever updating state, so the
    // dependent effects in this hook ran on stale
    // permission === "default".
    if (typeof DOE === "undefined") {
      setPermission("unsupported");
      return "unsupported";
    }
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

      // QA16: skip the React update if no axis moved by even
      // one quantum. Most deviceorientation events at rest
      // jitter by less than 0.5° per axis after EMA + deadzone;
      // bailing here drops the render rate from 60Hz to ~3-5Hz
      // when the phone is held still — without this, every
      // consumer of the motion hook re-renders on every frame,
      // which both spams React and forces re-creation of the
      // useMemo wrapper (line 169 below).
      const q = TILT_QUANTUM_DEG;
      const last = lastExposedRef.current;
      if (
        Math.abs(pitch - last.pitch) < q &&
        Math.abs(roll - last.roll) < q &&
        Math.abs(yaw - last.yaw) < q
      ) {
        // First event after permission grant — we MUST flip
        // `available` true so consumers know motion is live.
        // QA17: read the ref, not the closure — see
        // availableRef declaration for the stale-closure bug
        // this fixes.
        if (!availableRef.current) {
          availableRef.current = true;
          last.pitch = pitch;
          last.roll = roll;
          last.yaw = yaw;
          setTilt({ pitch, roll, yaw, available: true });
        }
        return;
      }
      last.pitch = pitch;
      last.roll = roll;
      last.yaw = yaw;
      // QA17: keep the ref in sync so the first-event branch
      // (above) doesn't fire again on the next frame.
      availableRef.current = true;
      setTilt({ pitch, roll, yaw, available: true });
    };

    window.addEventListener("deviceorientation", onOrientation);
    return () => {
      window.removeEventListener("deviceorientation", onOrientation);
    };
  }, [permission, alpha]);

  // Classify movement + turning from current tilt. The strings
  // are recomputed every tilt update; that's intentional — they
  // are cheap. What matters is the wrapper-object memo below
  // only changes when a primitive the consumer actually reads
  // changes, not on every orientation event.
  const moving: "idle" | "forward" | "backward" =
    tilt.pitch > fwdT ? "forward" : tilt.pitch < backT ? "backward" : "idle";
  const turning: "idle" | "left" | "right" =
    tilt.yaw < -lookT ? "left" : tilt.yaw > lookT ? "right" : "idle";

  // QA16: memoize the returned object only on primitives that
  // are visible to consumers. With the per-event quantum skip
  // above, tilt.pitch/roll/yaw change at most ~5Hz when the
  // phone is still. Without that skip, this object was a new
  // identity 60x/s and every consumer re-rendered every frame.
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tilt.pitch, tilt.roll, tilt.yaw, tilt.available, permission],
  );
}