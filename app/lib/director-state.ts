// Director state — small shared store for the active style +
// variant, so the Director overlay (CSS cinema filter) can react
// to either VoiceDream or DesktopDream chip clicks without
// prop-drilling. The chip owner remains the source of truth;
// this is just a mirror.
//
// We use a tiny pub-sub instead of zustand to avoid pulling in
// a new dep just for this.

import { dreamBus } from "./event-bus";
import { STYLE_PRESETS, TIME_VARIANTS } from "./style-presets";

export interface DirectorState {
  styleId: string | null;
  variantId: string | null;
}

let state: DirectorState = { styleId: null, variantId: null };

type Listener = (s: DirectorState) => void;
const listeners = new Set<Listener>();

export function getDirectorState(): DirectorState {
  return state;
}

export function setDirectorState(patch: Partial<DirectorState>): void {
  state = { ...state, ...patch };
  // Notify bus subscribers AND local listeners so different
  // hooks can subscribe via either path.
  dreamBus.emit("dream:directorChange", state);
  for (const cb of [...listeners]) {
    try {
      cb(state);
    } catch {
      // ponytail
    }
  }
}

export function subscribeDirector(cb: Listener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

// QA12/F10: Director keyboard shortcuts.
//
//   D       → cycle to the next style (Hyperreal → Photoreal → Cyberpunk → ...)
//   Shift+D → cycle backwards
//   N       → cycle to the next time/weather variant
//   Shift+N → cycle backwards
//   0       → reset both to NO_LOOK
//
// All setDirectorState() calls also emit a directorChange
// event, so the Director overlay + the chip owner both
// update. The cycle helpers return the new ids so the
// caller can show a toast.

export function cycleStyle(direction: 1 | -1 = 1): string | null {
  const ids = STYLE_PRESETS.map((p) => p.id);
  if (ids.length === 0) return null;
  const current = state.styleId;
  const i = current ? ids.indexOf(current) : -1;
  const next = ids[(i + direction + ids.length) % ids.length];
  setDirectorState({ styleId: next });
  return next;
}

export function cycleVariant(direction: 1 | -1 = 1): string | null {
  const ids = TIME_VARIANTS.map((v) => v.id);
  if (ids.length === 0) return null;
  const current = state.variantId;
  const i = current ? ids.indexOf(current) : -1;
  const next = ids[(i + direction + ids.length) % ids.length];
  setDirectorState({ variantId: next });
  return next;
}

export function resetDirector(): void {
  setDirectorState({ styleId: null, variantId: null });
}
