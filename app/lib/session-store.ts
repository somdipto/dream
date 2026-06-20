// Pure functions for the localStorage-backed session store. No React.
// SSR-safe (guards on typeof window).
//
// Reads: loadFromStorage() returns { sessions, activeId }. Always
// succeeds — corrupt JSON is logged and treated as empty.
// Writes: saveToStorage() returns { ok: true } or { ok: false, reason }.
//   On QuotaExceededError, prunes the oldest non-active sessions and
//   retries once. If still over, returns failure.

import {
  ACTIVE_KEY,
  SCHEMA_VERSION,
  STORAGE_KEY,
  type SerializedState,
  type Session,
} from "./session-types";

export type SaveResult = { ok: true } | { ok: false; reason: "quota" | "unavailable" };

export interface LoadResult {
  sessions: Session[];
  activeId: string | null;
}

export function loadFromStorage(): LoadResult {
  if (typeof window === "undefined") {
    return { sessions: [], activeId: null };
  }
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    // localStorage blocked (e.g. private mode in some browsers).
    return { sessions: [], activeId: null };
  }
  if (!raw) return { sessions: [], activeId: null };
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    // Corrupt JSON. Self-heal by treating as empty; the next write
    // overwrites with a clean state.
    // eslint-disable-next-line no-console
    console.warn("[session-store] corrupt JSON in storage; resetting", e);
    return { sessions: [], activeId: null };
  }
  const sessions = extractSessions(parsed);
  let activeId: string | null = null;
  try {
    const a = window.localStorage.getItem(ACTIVE_KEY);
    if (a && sessions.some((s) => s.id === a)) activeId = a;
  } catch {
    // ignore
  }
  return { sessions, activeId };
}

function extractSessions(parsed: any): Session[] {
  if (!parsed || typeof parsed !== "object") return [];
  // Accept either the new { version, sessions } shape or a bare array
  // (for forward-compat with older builds).
  const arr = Array.isArray(parsed) ? parsed : parsed.sessions;
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