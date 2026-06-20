"use client";

import { useEffect, useRef, useState } from "react";
import { useLingbot } from "@reactor-models/lingbot";

// Desktop input controller. Active only when `enabled` is true (i.e.
// on the desktop layout AND the world is ready).
//
// Provides:
//   - WASD / arrow keys for movement  (W=forward, S=back, A=strafe_left,
//                                       D=strafe_right)
//   - Arrow keys for camera look      (←/→ look_horizontal, ↑/↓ look_vertical)
//   - Mouse position relative to viewport center drives continuous look
//     (left half → look left, right half → look right, top half → look
//     up, bottom half → look down). Returns to idle when the mouse is
//     inside a small dead-zone at center.
//
// Mouse sensitivity:
//   - Default max rotation speed dropped from 25 → 12 deg/frame
//     (the old value translated to ~1500°/s at 60fps, which felt
//     like the camera was glued to a fidget spinner).
//   - User can tune sensitivity in 0.25×–3× steps via the HUD slider.
//     Preference persists in localStorage.
//   - Dead zone widened from 12% → 15% so a drifting mouse near the
//     center doesn't produce micro-rotations.
//
// Design notes:
//   - Lingbot's look axes are *continuous* (`idle | left | right`) with
//     a configurable `rotation_speed_deg`. We tune speed by mouse
//     distance from center so a small mouse drift = slow turn, a big
//     drift = fast turn. Same model for the look axes.
//   - WASD movement is held (persistent state), not pulsed. Same as the
//     existing gyroscope controller — chunks can drop pulses at
//     boundaries but persistent state sticks.
//   - All commands are change-driven. We never re-send the same value
//     twice. Re-renders only happen on key down / up / mouse move.

type Movement = "idle" | "forward" | "back" | "strafe_left" | "strafe_right";
type LookH = "idle" | "left" | "right";
type LookV = "idle" | "up" | "down";

const MAX_ROT_SPEED = 12;       // deg/frame at full mouse deflection
const DEAD_ZONE = 0.15;         // 15% of half-viewport → no rotation
const MAX_ROT_DIST = 0.7;       // 70% of half-viewport → max rotation speed
const SENSITIVITY_KEY = "dream.mouseSensitivity.v1";
const SENSITIVITY_DEFAULT = 1.0;
const SENSITIVITY_MIN = 0.25;
const SENSITIVITY_MAX = 3.0;

function loadSensitivity(): number {
  if (typeof window === "undefined") return SENSITIVITY_DEFAULT;
  try {
    const raw = window.localStorage.getItem(SENSITIVITY_KEY);
    if (!raw) return SENSITIVITY_DEFAULT;
    const v = parseFloat(raw);
    if (!Number.isFinite(v)) return SENSITIVITY_DEFAULT;
    return Math.max(SENSITIVITY_MIN, Math.min(SENSITIVITY_MAX, v));
  } catch {
    return SENSITIVITY_DEFAULT;
  }
}

export function DesktopController({ enabled }: { enabled: boolean }) {
  const { setMovement, setLookHorizontal, setLookVertical, setRotationSpeedDeg, status } = useLingbot();

  const keysRef = useRef<Set<string>>(new Set());
  const mouseRef = useRef({ x: 0, y: 0 }); // -1..1, 0=center
  const sensitivityRef = useRef<number>(SENSITIVITY_DEFAULT);
  const [sensitivity, setSensitivityState] = useState<number>(SENSITIVITY_DEFAULT);
  const lastSent = useRef<{
    movement: Movement;
    lookH: LookH;
    lookV: LookV;
    rotSpeed: number;
  }>({ movement: "idle", lookH: "idle", lookV: "idle", rotSpeed: 5 });

  // Hydrate the saved sensitivity on mount.
  useEffect(() => {
    const v = loadSensitivity();
    sensitivityRef.current = v;
    setSensitivityState(v);
  }, []);

  function setSensitivity(v: number) {
    const clamped = Math.max(SENSITIVITY_MIN, Math.min(SENSITIVITY_MAX, v));
    sensitivityRef.current = clamped;
    setSensitivityState(clamped);
    try {
      window.localStorage.setItem(SENSITIVITY_KEY, clamped.toString());
    } catch {
      // ignore — privacy mode
    }
    // Force a re-tick so the new speed takes effect immediately.
    tick();
  }

  // --- Keyboard wiring ---
  useEffect(() => {
    if (!enabled) return;

    function isMovementKey(k: string): boolean {
      return (
        k === "w" || k === "W" ||
        k === "a" || k === "A" ||
        k === "s" || k === "S" ||
        k === "d" || k === "D" ||
        k === "ArrowUp" || k === "ArrowDown" ||
        k === "ArrowLeft" || k === "ArrowRight"
      );
    }

    function onDown(e: KeyboardEvent) {
      if (!isMovementKey(e.key)) return;
      // Don't capture if user is typing in the text input.
      const tag = (e.target as HTMLElement | null)?.tagName ?? "";
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      keysRef.current.add(e.key);
      e.preventDefault();
      tick();
    }
    function onUp(e: KeyboardEvent) {
      if (!isMovementKey(e.key)) return;
      keysRef.current.delete(e.key);
      tick();
    }
    function onBlur() {
      // Reset all keys when the window loses focus — prevents the
      // user from getting stuck walking forever after alt-tabbing.
      keysRef.current.clear();
      tick();
    }

    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [enabled]);

  // --- Mouse-look wiring ---
  useEffect(() => {
    if (!enabled) return;

    function onMove(e: MouseEvent) {
      const w = window.innerWidth;
      const h = window.innerHeight;
      // Normalize: -1 = far edge, 0 = center, +1 = far edge.
      const nx = (e.clientX - w / 2) / (w / 2);
      const ny = (e.clientY - h / 2) / (h / 2);
      mouseRef.current = { x: nx, y: ny };
      tick();
    }
    window.addEventListener("mousemove", onMove);
    return () => window.removeEventListener("mousemove", onMove);
  }, [enabled]);

  // --- Centralized state → SDK tick. Called on every key/mouse change. ---
  function tick() {
    // Skip sending commands while the SDK is not ready. Lingbot
    // rejects commands with "cannot send command while status is
    // disconnect must be ready" otherwise.
    if (status !== "ready") return;
    // 1. Movement. WASD wins. Arrow keys share the same slot for
    //    movement so the keyboard layout stays intuitive (↑ = forward,
    //    ↓ = back).
    const k = keysRef.current;
    let movement: Movement = "idle";
    if (k.has("w") || k.has("W") || k.has("ArrowUp")) movement = "forward";
    else if (k.has("s") || k.has("S") || k.has("ArrowDown")) movement = "back";
    else if (k.has("a") || k.has("A")) movement = "strafe_left";
    else if (k.has("d") || k.has("D")) movement = "strafe_right";

    // 2. Read mouse position once. Both look axes and the rotation-
    //    speed scaler need it, so don't re-pull it inside nested blocks.
    const mx = mouseRef.current.x;
    const my = mouseRef.current.y;

    // 3. Look horizontal: ←/→ win when held, otherwise mouse-x.
    let lookH: LookH = "idle";
    let lookV: LookV = "idle";
    if (k.has("ArrowLeft")) lookH = "left";
    else if (k.has("ArrowRight")) lookH = "right";
    else if (Math.abs(mx) > DEAD_ZONE) {
      lookH = mx < 0 ? "left" : "right";
    }

    // 4. Look vertical: keyboard takes priority; mouse-y otherwise.
    //    (The mouse is naturally biased toward the bottom of the
    //    screen where the input UI sits; we use a tighter threshold
    //    for vertical so the user can hover over the bottom UI without
    //    tilting the camera down.)
    if (lookH === "idle" && Math.abs(my) > DEAD_ZONE * 1.5) {
      lookV = my < 0 ? "up" : "down";
    }

    // 5. Rotation speed scales with mouse distance and the user's
    //    sensitivity multiplier. Keyboard look uses a fixed base speed
    //    so it feels predictable, but the user can still tune it via
    //    the slider.
    const sens = sensitivityRef.current;
    let rotSpeed = MAX_ROT_SPEED * 0.3 * sens; // ~3.6 deg/frame for keyboard @ 1x
    const mouseDriven =
      !k.has("ArrowLeft") && !k.has("ArrowRight") && !k.has("ArrowUp") && !k.has("ArrowDown");
    if (mouseDriven && (lookH !== "idle" || lookV !== "idle")) {
      const dominant = Math.max(
        Math.min(Math.abs(mx) / MAX_ROT_DIST, 1),
        Math.min(Math.abs(my) / MAX_ROT_DIST, 1),
      );
      rotSpeed = MAX_ROT_SPEED * Math.max(0.2, dominant) * sens;
    }

    // 6. Send only on change.
    const prev = lastSent.current;
    if (movement !== prev.movement) {
      void setMovement({ movement });
      prev.movement = movement;
    }
    if (lookH !== prev.lookH) {
      void setLookHorizontal({ look_horizontal: lookH });
      prev.lookH = lookH;
    }
    if (lookV !== prev.lookV) {
      void setLookVertical({ look_vertical: lookV });
      prev.lookV = lookV;
    }
    if (Math.abs(rotSpeed - prev.rotSpeed) > 0.3) {
      void setRotationSpeedDeg({ rotation_speed_deg: rotSpeed });
      prev.rotSpeed = rotSpeed;
    }
  }

  // Reset all axes when the controller unmounts (e.g. leaving the
  // desktop layout) so we don't leave the model stuck walking forever.
  // CRITICAL: only send the reset if the SDK is still ready. Sending
  // commands while disconnected throws "cannot send command while
  // status is disconnect must be ready" — see REA-1847.
  useEffect(() => {
    return () => {
      if (status !== "ready") return;
      void setMovement({ movement: "idle" });
      void setLookHorizontal({ look_horizontal: "idle" });
      void setLookVertical({ look_vertical: "idle" });
    };
  }, [status, setMovement, setLookHorizontal, setLookVertical]);

  // Show a small HUD on desktop so the user knows the controls exist.
  // Kept unobtrusive — bottom-right, fades on first key press. Now
  // includes a sensitivity slider so the user can dial the speed to
  // their taste (and we never have to ship a magic-number default).
  return (
    <DesktopControlsHUD
      enabled={enabled}
      sensitivity={sensitivity}
      setSensitivity={setSensitivity}
    />
  );
}

function DesktopControlsHUD({
  enabled,
  sensitivity,
  setSensitivity,
}: {
  enabled: boolean;
  sensitivity: number;
  setSensitivity: (v: number) => void;
}) {
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    function onFirst() {
      setDismissed(true);
      window.removeEventListener("keydown", onFirst);
      window.removeEventListener("mousemove", onFirst);
    }
    window.addEventListener("keydown", onFirst, { once: true });
    window.addEventListener("mousemove", onFirst, { once: true });
    return () => {
      window.removeEventListener("keydown", onFirst);
      window.removeEventListener("mousemove", onFirst);
    };
  }, [enabled]);

  if (!enabled) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-auto fixed right-3 top-20 z-20 hidden w-56 rounded-lg border border-white/10 bg-black/70 px-3 py-2 text-[10px] text-white/80 shadow-lg backdrop-blur md:block"
      style={{ animation: "fadeInSlow 600ms ease-out" }}
    >
      {!dismissed && (
        <>
          <p className="font-medium uppercase tracking-wider text-white/50">Controls</p>
          <p className="mt-1">
            <kbd className="rounded bg-white/10 px-1.5 py-0.5">W</kbd>{" "}
            <kbd className="rounded bg-white/10 px-1.5 py-0.5">A</kbd>{" "}
            <kbd className="rounded bg-white/10 px-1.5 py-0.5">S</kbd>{" "}
            <kbd className="rounded bg-white/10 px-1.5 py-0.5">D</kbd>{" "}
            <span className="ml-1 text-white/50">move</span>
          </p>
          <p className="mt-1">
            <kbd className="rounded bg-white/10 px-1.5 py-0.5">↑</kbd>{" "}
            <kbd className="rounded bg-white/10 px-1.5 py-0.5">↓</kbd>{" "}
            <kbd className="rounded bg-white/10 px-1.5 py-0.5">←</kbd>{" "}
            <kbd className="rounded bg-white/10 px-1.5 py-0.5">→</kbd>{" "}
            <span className="ml-1 text-white/50">look</span>
          </p>
          <p className="mt-1 text-white/50">mouse — look</p>
        </>
      )}
      <div className={dismissed ? "pt-1" : "mt-2 border-t border-white/10 pt-2"}>
        <label className="flex items-center justify-between gap-2">
          <span className="text-white/60">Mouse sensitivity</span>
          <span className="font-mono text-white/85">{sensitivity.toFixed(2)}×</span>
        </label>
        <input
          type="range"
          min={SENSITIVITY_MIN}
          max={SENSITIVITY_MAX}
          step={0.05}
          value={sensitivity}
          onChange={(e) => setSensitivity(parseFloat(e.target.value))}
          aria-label="Mouse sensitivity"
          data-testid="mouse-sensitivity-slider"
          className="mt-1 w-full accent-white"
        />
        <div className="mt-1 flex justify-between text-[9px] text-white/40">
          <span>0.25×</span>
          <button
            type="button"
            onClick={() => setSensitivity(SENSITIVITY_DEFAULT)}
            className="hover:text-white/70"
          >
            reset
          </button>
          <span>3×</span>
        </div>
      </div>
    </div>
  );
}