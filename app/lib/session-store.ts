// Pure functions for the localStorage-backed session store. No React.
// SSR-safe (guards on typeof window).
//
// Reads: loadFromStorage() returns { sessions, activeId, recovered }.
//   On corrupt JSON we back up the raw blob to a "corrupt" key before
//   resetting, and surface `recovered: true` so the UI can offer
//   "Restore last journal". (Audit bug #30.)
// Writes: saveToStorage() returns { ok: true } or { ok: false, reason }.
//   On QuotaExceededError, prunes the oldest non-active sessions and
//   retries once. If still over, returns failure.

import {
  ACTIVE_KEY,
  CORRUPT_BACKUP_PREFIX,
  SCHEMA_VERSION,
  STORAGE_KEY,
  type SerializedState,
  type Session,
} from "./session-types";

const CORRUPT_BACKUP_KEY = CORRUPT_BACKUP_PREFIX;

export type SaveResult = { ok: true } | { ok: false; reason: "quota" | "unavailable" };

export interface LoadResult {
  sessions: Session[];
  activeId: string | null;
  /** True if the previous storage blob was corrupt and was preserved
   *  under CORRUPT_BACKUP_KEY — UI should offer a recovery path. */
  recovered: boolean;
}

export function loadFromStorage(): LoadResult {
  if (typeof window === "undefined") {
    return { sessions: [], activeId: null, recovered: false };
  }
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    // localStorage blocked (e.g. private mode in some browsers).
    return { sessions: [], activeId: null, recovered: false };
  }
  if (!raw) return { sessions: [], activeId: null, recovered: false };
  let parsed: any;
  let recovered = false;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    // Corrupt JSON. Preserve the raw blob so the user has a chance
    // to recover it from devtools, and signal the UI. We don't auto-
    // overwrite — the next save only fires if the user does something,
    // and by then we want them to have seen the recovery prompt.
    // eslint-disable-next-line no-console
    console.warn("[session-store] corrupt JSON in storage; backing up", e);
    try {
      const ts = Date.now();
      window.localStorage.setItem(
        `${CORRUPT_BACKUP_KEY}.${ts}`,
        raw.slice(0, 100_000),
      );
    } catch {
      // ignore — backup best-effort
    }
    return { sessions: [], activeId: null, recovered: true };
  }
  const sessions = extractSessions(parsed);
  // Only treat as "recovered" if the parsed shape had a recognizable
  // sessions array but yielded zero results. An empty-but-valid
  // `{ version:1, sessions: [] }` (user deleted everything) must NOT
  // surface a recovery banner — that's a clean-slate device.
  const hadSessionsKey =
    parsed && typeof parsed === "object" && Array.isArray((parsed as any).sessions);
  if (sessions.length === 0 && hadSessionsKey) {
    // Storage had a sessions array but nothing parsed out — partial
    // write or schema drift. Back up the raw blob so the user has
    // a chance to recover it from devtools.
    try {
      // Use a monotonic counter + Date.now() so multiple corruption
      // events within the same millisecond don't collide.
      window.localStorage.setItem(
        `${CORRUPT_BACKUP_KEY}.${Date.now()}.${Math.floor(Math.random() * 1e6)}`,
        raw.slice(0, 100_000),
      );
      recovered = true;
    } catch {
      // ignore
    }
  }
  let activeId: string | null = null;
  try {
    const a = window.localStorage.getItem(ACTIVE_KEY);
    if (a && sessions.some((s) => s.id === a)) activeId = a;
  } catch {
    // ignore
  }
  return { sessions, activeId, recovered };
}

function extractSessions(parsed: any): Session[] {
  // Accept either a bare array (legacy / forward-compat) or
  // `{ version, sessions }`. Previously the bare-array branch was
  // commented but never implemented.
  const arr = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object"
      ? (parsed as any).sessions
      : null;
  if (!Array.isArray(arr)) return [];
  const out: Session[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    if (typeof item.id !== "string") continue;
    if (!Array.isArray(item.scenes)) continue;
    const scenes = item.scenes
      .filter(
        (s: any) =>
          s &&
          typeof s === "object" &&
          typeof s.id === "string" &&
          typeof s.prompt === "string" &&
          typeof s.seed === "number" &&
          typeof s.timestamp === "number",
      )
      .map((s: any) => ({
        id: s.id,
        prompt: s.prompt,
        seed: s.seed >>> 0,
        timestamp: s.timestamp,
      }));
    out.push({
      id: item.id,
      title: typeof item.title === "string" ? item.title : "Untitled session",
      createdAt: typeof item.createdAt === "number" ? item.createdAt : Date.now(),
      updatedAt: typeof item.updatedAt === "number" ? item.updatedAt : Date.now(),
      scenes,
    });
  }
  return out;
}

export function saveToStorage(
  sessions: Session[],
  activeId: string | null,
  options: { pruneOnQuota?: boolean } = {},
): SaveResult {
  if (typeof window === "undefined") return { ok: false, reason: "unavailable" };
  const payload: SerializedState = { version: SCHEMA_VERSION, sessions };
  const json = JSON.stringify(payload);
  try {
    window.localStorage.setItem(STORAGE_KEY, json);
    if (activeId === null) {
      window.localStorage.removeItem(ACTIVE_KEY);
    } else {
      window.localStorage.setItem(ACTIVE_KEY, JSON.stringify(activeId));
    }
    return { ok: true };
  } catch (e: any) {
    const isQuota =
      e?.name === "QuotaExceededError" ||
      e?.code === 22 ||
      e?.code === 1014 ||
      /quota/i.test(String(e?.message ?? ""));
    if (!isQuota) {
      // eslint-disable-next-line no-console
      console.warn("[session-store] save failed:", e);
      return { ok: false, reason: "unavailable" };
    }
    if (!options.pruneOnQuota) {
      // eslint-disable-next-line no-console
      console.warn("[session-store] quota exceeded; refusing to auto-prune");
      return { ok: false, reason: "quota" };
    }
    // Prune: keep active + 5 most-recent by updatedAt. Drop the rest.
    const sorted = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
    const keepIds = new Set<string>();
    if (activeId) keepIds.add(activeId);
    for (const s of sorted) {
      if (keepIds.size >= 6) break;
      keepIds.add(s.id);
    }
    const pruned = sessions.filter((s) => keepIds.has(s.id));
    try {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ version: SCHEMA_VERSION, sessions: pruned }),
      );
      if (activeId === null) {
        window.localStorage.removeItem(ACTIVE_KEY);
      } else {
        window.localStorage.setItem(ACTIVE_KEY, JSON.stringify(activeId));
      }
      // eslint-disable-next-line no-console
      console.warn(
        "[session-store] quota exceeded; pruned to",
        pruned.length,
        "sessions",
      );
      return { ok: true };
    } catch (e2) {
      // eslint-disable-next-line no-console
      console.warn("[session-store] save still failed after prune:", e2);
      return { ok: false, reason: "quota" };
    }
  }
}

/**
 * Attempt to restore from the most recent corrupt backup. Returns
 * the recovered sessions on success. The caller is responsible for
 * re-hydrating the React state with these (and for writing them back
 * to the primary STORAGE_KEY via saveToStorage, which will succeed
 * since we just verified parseability).
 *
 * Returns null if no backup is found or if no backup parses cleanly.
 */
export function restoreCorruptBackup(): { sessions: Session[] } | null {
  if (typeof window === "undefined") return null;
  let keys: string[] = [];
  try {
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k && k.startsWith(CORRUPT_BACKUP_KEY)) keys.push(k);
    }
  } catch {
    return null;
  }
  if (keys.length === 0) return null;
  // Sort newest first (the timestamp suffix).
  keys.sort((a, b) => {
    const ta = Number(a.split(".").pop() ?? 0);
    const tb = Number(b.split(".").pop() ?? 0);
    return tb - ta;
  });
  for (const k of keys) {
    let raw: string | null = null;
    try {
      raw = window.localStorage.getItem(k);
    } catch {
      continue;
    }
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      const sessions = extractSessions(parsed);
      if (sessions.length > 0) return { sessions };
    } catch {
      // try next backup
    }
  }
  return null;
}

/**
 * Drop all corrupt backup keys. Call after a successful restore (or
 * after the user dismisses the recovery prompt) so they don't pile up.
 */
export function clearCorruptBackups(): void {
  if (typeof window === "undefined") return;
  const toRemove: string[] = [];
  try {
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k && k.startsWith(CORRUPT_BACKUP_KEY)) toRemove.push(k);
    }
  } catch {
    return;
  }
  for (const k of toRemove) {
    try {
      window.localStorage.removeItem(k);
    } catch {
      // ignore
    }
  }
}