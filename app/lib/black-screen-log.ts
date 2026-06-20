// M9.16: Persistent memory of black-screen events.
//
// The user asked to "add memory" to the black-screen issue. Rather
// than a one-off fix, persist each detected event so:
//   1. The user can see "we noticed the last 3 attempts hit a black
//      screen" on the next load — confirmation that the issue is
//      real and being tracked, not imagined.
//   2. We can correlate events across sessions to identify patterns
//      (always after voice-final? always with prompt X? always
//      with a specific seed range?).
//   3. The dev panel / console can dump the log for debugging.
//
// Detection sources (multiple, not just the dark-frame watchdog):
//   - dark-frame watchdog: Video.tsx samples the <video> every 2s;
//     below luma 22/255 counts as a black-screen event.
//   - seed upload timeout: VoiceDream.paintDream logs when the
//     seed image fails to upload within 4s (user sees a stuck
//     "loading" with no video).
//   - image-ready timeout: setImage never confirms within 6s.
//   - render timeout: the full pipeline Promise.race times out at
//     8s (M9.x).
//   - user-reported: the error screen has a "this is a black
//     screen" link that records a manual report.
//
// All five feed this log. The user-facing surface is a small
// "Black screen" button on the Begin overlay that opens a
// recent-events panel — confirms to the user that we're tracking
// it, and gives them a one-click "clear log" affordance.
//
// Storage: localStorage as JSON. Capped at MAX_ENTRIES to bound
// the size; oldest entries drop off.

export interface BlackScreenEvent {
  /** When it happened. Unix ms. */
  ts: number;
  /** Where it came from. */
  source:
    | "dark-frame-watchdog"
    | "seed-upload-timeout"
    | "image-ready-timeout"
    | "render-timeout"
    | "user-report"
    | "unknown";
  /** Prompt text the user was trying to paint, if known. */
  prompt: string | null;
  /** Seed for that paint, if known. */
  seed: number | null;
  /** Active session id at the time, if known. */
  sessionId: string | null;
  /** Luma sample for dark-frame events (0-255). null otherwise. */
  luma: number | null;
  /** Free-form note. */
  note: string | null;
}

const STORAGE_KEY = "dream.blackScreenLog";
const MAX_ENTRIES = 50;

interface PersistedShape {
  v: 1;
  events: BlackScreenEvent[];
}

function read(): BlackScreenEvent[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as PersistedShape;
    if (parsed?.v !== 1 || !Array.isArray(parsed.events)) return [];
    return parsed.events;
  } catch {
    return [];
  }
}

function write(events: BlackScreenEvent[]): void {
  if (typeof window === "undefined") return;
  try {
    const trimmed = events.slice(-MAX_ENTRIES);
    const payload: PersistedShape = { v: 1, events: trimmed };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Quota — drop the oldest until it fits, then retry.
    try {
      const half = events.slice(-Math.floor(MAX_ENTRIES / 2));
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ v: 1, events: half }),
      );
    } catch {
      // Give up silently — the log is best-effort memory, not a
      // critical store.
    }
  }
}

export function recordBlackScreen(
  partial: Omit<BlackScreenEvent, "ts"> & { ts?: number },
): void {
  const ev: BlackScreenEvent = {
    ts: partial.ts ?? Date.now(),
    source: partial.source,
    prompt: partial.prompt,
    seed: partial.seed,
    sessionId: partial.sessionId,
    luma: partial.luma,
    note: partial.note,
  };
  const current = read();
  current.push(ev);
  write(current);
}

export function getBlackScreenLog(): BlackScreenEvent[] {
  return read();
}

export function clearBlackScreenLog(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

export function blackScreenLogCount(): number {
  return read().length;
}
