// Director state — small shared store for the active style +
// variant, so the Director overlay (CSS cinema filter) can react
// to either VoiceDream or DesktopDream chip clicks without
// prop-drilling. The chip owner remains the source of truth;
// this is just a mirror.
//
// We use a tiny pub-sub instead of zustand to avoid pulling in
// a new dep just for this.

import { dreamBus } from "./event-bus";

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
