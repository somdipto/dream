"use client";

import { useEffect, useRef, useState } from "react";
import { useLingbot } from "@reactor-models/lingbot";

// Touch-driven "joystick" the user can drag to look around and move
// when their device denies gyroscope permission (or the device doesn't
// have a gyroscope at all). Renders only when `enabled` is true.
//
// Layout: full-screen touch surface. The drag distance from the touch
// start maps to:
//   - look_horizontal (drag X) — left/right at deadzone = 12%
//   - look_vertical   (drag Y, top half up, bottom half down)
//   - movement         (drag Y past 60% of half-screen)
// Tapping the surface (no drag) does nothing — only an actual drag
// fires a command. This keeps the joystick from interfering with
// taps on the mic button or text input behind it.

type LookH = "idle" | "left" | "right";
type LookV = "idle" | "up" | "down";
type Movement = "idle" | "forward" | "back";

const DEAD_ZONE = 0.12;
const MAX_ROT_DIST = 0.7;
const WALK_THRESHOLD = 0.6;

export function VirtualJoystick({ enabled }: { enabled: boolean }) {
  const { setMovement, setLookHorizontal, setLookVertical, setRotationSpeedDeg, status } = useLingbot();
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const startRef = useRef<{ x: number; y: number; t: number } | null>(null);
  const activeIdRef = useRef<number | null>(null);
  const lastSentRef = useRef<{ lh: LookH; lv: LookV; mv: Movement; sp: number }>({
    lh: "idle",
    lv: "idle",
    mv: "idle",
    sp: 5,
  });
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    const surface = surfaceRef.current;
    if (!surface) return;

    function onStart(e: TouchEvent) {
      if (status !== "ready") return;
      // Only one finger drives the joystick — extra fingers ignored
      // so the user can tap mic/UI with their other hand.
      if (activeIdRef.current !== null) return;
      const t = e.changedTouches[0];
      if (!t) return;
      activeIdRef.current = t.identifier;
      startRef.current = { x: t.clientX, y: t.clientY, t: Date.now() };
      setDragging(true);
      e.preventDefault();
    }

    function onMove(e: TouchEvent) {
      if (activeIdRef.current === null) return;
      let touch: Touch | null = null;
      for (let i = 0; i < e.changedTouches.length; i++) {
        if (e.changedTouches[i].identifier === activeIdRef.current) {
          touch = e.changedTouches[i];
          break;
        }
      }
      if (!touch) return;
      const s = startRef.current;
      if (!s) return;
      const w = window.innerWidth;
      const h = window.innerHeight;
      const nx = (touch.clientX - s.x) / (w / 2);
      const ny = (touch.clientY - s.y) / (h / 2);
      const clampedX = Math.max(-1, Math.min(1, nx));
      const clampedY = Math.max(-1, Math.min(1, ny));

      let lookH: LookH = "idle";
      let lookV: LookV = "idle";
      let movement: Movement = "idle";

      if (Math.abs(clampedX) > DEAD_ZONE) {
        lookH = clampedX < 0 ? "left" : "right";
      }
      // Vertical: only the bottom half of the surface drives look
      // up/down — the top is for status badges and the bottom-right
      // has the mic.
      if (s.y > h * 0.35 && Math.abs(clampedY) > DEAD_ZONE * 1.5) {
        lookV = clampedY < 0 ? "up" : "down";
      }
      // Forward: drag down by ≥60% of half-screen height.
      if (clampedY > WALK_THRESHOLD) {
        movement = "forward";
      } else if (clampedY < -WALK_THRESHOLD) {
        movement = "back";
      }

      const dominant = Math.max(
        Math.min(Math.abs(clampedX) / MAX_ROT_DIST, 1),
        Math.min(Math.abs(clampedY) / MAX_ROT_DIST, 1),
      );
      const rotSpeed = 12 * Math.max(0.2, dominant);

      const prev = lastSentRef.current;
      if (lookH !== prev.lh) {
        void setLookHorizontal({ look_horizontal: lookH });
        prev.lh = lookH;
      }
      if (lookV !== prev.lv) {
        void setLookVertical({ look_vertical: lookV });
        prev.lv = lookV;
      }
      if (movement !== prev.mv) {
        void setMovement({ movement });
        prev.mv = movement;
      }
      if (Math.abs(rotSpeed - prev.sp) > 0.3) {
        void setRotationSpeedDeg({ rotation_speed_deg: rotSpeed });
        prev.sp = rotSpeed;
      }
      e.preventDefault();
    }

    function onEnd(e: TouchEvent) {
      let found = false;
      for (let i = 0; i < e.changedTouches.length; i++) {
        if (e.changedTouches[i].identifier === activeIdRef.current) {
          found = true;
          break;
        }
      }
      if (!found) return;
      activeIdRef.current = null;
      startRef.current = null;
      setDragging(false);
      const prev = lastSentRef.current;
      if (prev.lh !== "idle") {
        void setLookHorizontal({ look_horizontal: "idle" });
        prev.lh = "idle";
      }
      if (prev.lv !== "idle") {
        void setLookVertical({ look_vertical: "idle" });
        prev.lv = "idle";
      }
      if (prev.mv !== "idle") {
        void setMovement({ movement: "idle" });
        prev.mv = "idle";
      }
    }

    surface.addEventListener("touchstart", onStart, { passive: false });
    surface.addEventListener("touchmove", onMove, { passive: false });
    surface.addEventListener("touchend", onEnd, { passive: true });
    surface.addEventListener("touchcancel", onEnd, { passive: true });
    return () => {
      surface.removeEventListener("touchstart", onStart);
      surface.removeEventListener("touchmove", onMove);
      surface.removeEventListener("touchend", onEnd);
      surface.removeEventListener("touchcancel", onEnd);
    };
  }, [enabled, status, setMovement, setLookHorizontal, setLookVertical, setRotationSpeedDeg]);

  if (!enabled) return null;
  return (
    <div
      ref={surfaceRef}
      role="application"
      aria-label="Drag to look around and walk forward"
      data-testid="virtual-joystick"
      className="pointer-events-auto absolute inset-0 z-10 md:hidden"
      style={{
        touchAction: "none",
        // R11: pure black — no radial gradient under the
        // finger. The old 4%-white radial halo was a tiny
        // gradient but the user said "completely black" so
        // we drop it.
        background: "transparent",
      }}
    >
      {!dragging && (
        <div className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/15 bg-black/30 px-4 py-2 text-[11px] text-white/70 backdrop-blur">
          👆 Drag to look · drag down to walk
        </div>
      )}
    </div>
  );
}