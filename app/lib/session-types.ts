// Session and Scene types for the localStorage-backed dream journal.
//
// One Session = a notebook of painted scenes. Sessions persist across
// page reloads. The user can have many sessions; only the *active* one
// drives the current Reactor WebRTC connection. Loading a past session
// is purely metadata — the live world keeps rendering the most recent
// paint until the user paints another.
//
// Why store the seed, not the image bytes:
//   `generateSeedImage({ seed })` in `seed-image.ts` is fully deterministic.
//   Replaying a scene reuses the same seed → same procedural anchor →
//   visually identical to the original paint. localStorage quota is
//   therefore irrelevant for the seed (32 bits) and only marginal for
//   the prompt strings.
//
// LiveVocs note: the user referred to "LiveVocs" in their goal. That
// name does not appear in the codebase, in the Reactor docs, or on the
// open web. We interpret it as a synonym for the in-app voice pipeline
// (Web Speech API → paintDream). Every spoken phrase automatically
// appends a Scene to the active Session via `addScene`. No new voice
// integration is built — this is the existing pipeline + a hook.

export interface Scene {
  id: string;
  /** Raw user text (pre-composeScenePrompt). */
  prompt: string;
  /** 32-bit unsigned; lets us re-render the same anchor on replay. */
  seed: number;
  /** Date.now() at paint success. */
  timestamp: number;
}

export interface Session {
  id: string;
  /** First scene's prompt (truncated) or "Untitled session". */
  title: string;
  createdAt: number;
  /** Bumped on every scene add/remove — drives sidebar sort order. */
  updatedAt: number;
  /** Ordered oldest → newest. */
  scenes: Scene[];
}

export const STORAGE_KEY = "lingbot.sessions.v1";
export const ACTIVE_KEY = "lingbot.activeSessionId.v1";
export const SCHEMA_VERSION = 1;

export interface SerializedState {
  version: number;
  sessions: Session[];
}

export function newSessionId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  // Fallback: timestamp + random.
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function newSceneId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function deriveTitle(scenes: Scene[]): string {
  const first = scenes[0]?.prompt?.trim();
  if (!first) return "Untitled session";
  return first.length > 60 ? first.slice(0, 57) + "…" : first;
}