// Typed event bus for cross-component signals.
//
// Previously we used `window.dispatchEvent(new CustomEvent("dream:loadScene", ...))`.
// That had two problems:
//   1. Security: any third-party script or browser extension could fire
//      a `dream:loadScene` event with arbitrary `{prompt, seed}` and
//      hijack the paint pipeline.
//   2. Type safety: the detail shape was `unknown` to consumers; the
//      cast `as CustomEvent<{prompt, seed}>` lived in three files.
//
// The bus is created lazily (one instance per module) and exposed as
// `dreamBus`. Any module can `emit` or `on`; listeners are deduped by
// `symbol`s and an `off` helper returns the unsubscribe handle. The
// bus never touches `window`/`document` so it works under SSR.

export interface DreamLoadSceneEvent {
  prompt: string;
  seed: number;
}

export interface DreamBusEvents {
  "dream:loadScene": DreamLoadSceneEvent;
  /** Fired by DesktopDefaultScene after the first auto-paint lands
   *  successfully — used by VoiceDream (or future components) to
   *  suppress their own default-paint so we don't double-fire. */
  "dream:firstPaintLanded": { prompt: string; seed: number };
  /** Fired by useSessionStore when a save hits quota and was pruned. */
  "dream:pruned": { kept: number; removed: number };
  /** Fired when a user-visible toast should appear. */
  "dream:toast": { id?: string; kind: "info" | "error" | "success"; message: string; ttlMs?: number };
  /** Fired before `dream:loadScene` so any in-flight paint can
   *  short-circuit and not commit `addScene` to the wrong session.
   *  Listeners (VoiceDream, DesktopDream) set an `abortedRef` flag
   *  that each Promise.race winner checks before calling
   *  `sessions.addScene`. Cheap, no SDK change required. */
  "dream:abortPaint": Record<string, never>;
  /** QA3: emitted after every paint attempt (success or fail).
   *  Carries the time taken in milliseconds and whether the
   *  paint succeeded. The StatusBadge uses it to show
   *  "Last paint: 4.2s" so the user can see the connection
   *  is healthy. QA4: now emitted on all outcomes so the
   *  user can tell "model is up but internal details was bad"
   *  apart from "connection is broken" — failures show as
   *  a stale duration with the dot color flipping to amber. */
  "dream:paintDone": { ms: number; ok: boolean };
  /** QA6/F2: emitted by the chip strips whenever the active
   *  style or time/weather variant changes. The Director
   *  overlay listens and applies the matching CSS filter. */
  "dream:directorChange": { styleId: string | null; variantId: string | null };
  /** QA16/F-product: emitted by MobileFlickPaint when a sharp
   *  device tilt/flick is detected. Carried through the same
   *  paint pipeline as a chip tap or voice final, so the user
   *  can express a world-change with a physical gesture. */
  "flick:prompt": { prompt: string; kind: "spin" | "dive" | "lift" | "roll" };
  /** F8: emitted by the BYOK fingerprint chip in the topbar when
   *  the user taps it. The ReactorErrorScreen listens and opens
   *  its paste field so the user can replace their saved key. */
  "dream:openByok": Record<string, never>;
}

type EventName = keyof DreamBusEvents;
type Listener<E extends EventName> = (detail: DreamBusEvents[E]) => void;

class DreamBus {
  private listeners: Map<EventName, Set<Listener<EventName>>> = new Map();

  on<E extends EventName>(event: E, cb: Listener<E>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(cb as Listener<EventName>);
    return () => {
      set!.delete(cb as Listener<EventName>);
    };
  }

  off<E extends EventName>(event: E, cb: Listener<E>): void {
    this.listeners.get(event)?.delete(cb as Listener<EventName>);
  }

  emit<E extends EventName>(event: E, detail: DreamBusEvents[E]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const cb of [...set]) {
      try {
        (cb as Listener<E>)(detail);
      } catch (e) {
        // ponytail: a misbehaving listener must not stop the others.
        // eslint-disable-next-line no-console
        console.warn("[dream-bus] listener threw:", e);
      }
    }
  }
}

// One bus per module — re-imports share the same instance.
export const dreamBus = new DreamBus();
