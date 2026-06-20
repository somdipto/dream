"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  deriveTitle,
  newSceneId,
  newSessionId,
  type Scene,
  type Session,
} from "../lib/session-types";
import {
  clearCorruptBackups,
  loadFromStorage,
  restoreCorruptBackup,
  saveToStorage,
} from "../lib/session-store";

export interface UseSessionStore {
  sessions: Session[];
  activeSession: Session | null;
  activeSessionId: string | null;
  addScene: (input: { prompt: string; seed: number }) => Scene | null;
  removeScene: (sceneId: string, sessionId?: string) => void;
  createSession: (opts?: { title?: string; seed?: { prompt: string; seed: number } | null }) => string;
  loadSession: (sessionId: string) => Scene | null;
  deleteSession: (sessionId: string) => void;
  restoreSession: (session: Session) => void;
  renameSession: (sessionId: string, title: string) => void;
  setActive: (sessionId: string | null) => void;
  /** QA3: toggle the favorite flag on a scene. */
  toggleFavorite: (sceneId: string, sessionId?: string) => void;
  /** QA3: recent prompts across all sessions, newest first. */
  recentPrompts: () => { prompt: string; seed: number; timestamp: number }[];
  /** Bumped when a save attempt hits quota and prunes. */
  pruneNotice: number;
  /** True once the store has hydrated from localStorage. */
  hydrated: boolean;
  /** True if the previous storage was unreadable; UI should offer restore. */
  recoveryNotice: boolean;
  restoreBackup: () => boolean;
  dismissRecovery: () => void;
}

// The actual implementation lives in a single React state. To keep it
// shared across components, mount it inside <SessionProvider> and read
// it via useSessions(). Calling useSessionStore() at the top level of
// a component is a developer error.

export function useSessionStoreImpl(): UseSessionStore {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [pruneNotice, setPruneNotice] = useState(0);
  const [hydrated, setHydrated] = useState(false);
  const [recoveryNotice, setRecoveryNotice] = useState(false);
  // Mirror of `sessions` for read-only use in stable callbacks
  // (notably setActive's id validation). Avoids the need to thread
  // `sessions` into the dep array, which would change the callback
  // identity every state update and force every consumer to re-run.
  const sessionsRef = useRef<Session[]>([]);
  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useEffect(() => {
    const r = loadFromStorage();
    setSessions(r.sessions);
    setActiveId(r.activeId);
    setRecoveryNotice(r.recovered);
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    // Skip the very first save after hydration — loadFromStorage
    // already wrote the data; we don't need to write it back verbatim.
    if (sessions.length === 0 && activeId === null) return;
    // QA5: debounce the save. Previously every state change
    // (favorite toggle, scene add, etc.) wrote the full
    // journal synchronously to localStorage, blocking the
    // main thread for 5-20ms. Burst a 200ms debounce so a
    // flurry of writes (e.g. painting 5 scenes quickly)
    // coalesces into a single write.
    const handle = setTimeout(() => {
      const result = saveToStorage(sessions, activeId, { pruneOnQuota: true });
      if (!result.ok && result.reason === "quota") {
        setPruneNotice((n) => n + 1);
      }
    }, 200);
    return () => clearTimeout(handle);
  }, [sessions, activeId, hydrated]);

  useEffect(() => {
    function onStorage() {
      const r = loadFromStorage();
      setSessions(r.sessions);
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const activeSession = useMemo(
    () => sessions.find((s) => s.id === activeId) ?? null,
    [sessions, activeId],
  );

  const addScene = useCallback(
    (input: { prompt: string; seed: number }): Scene | null => {
      const trimmed = input.prompt.trim();
      if (!trimmed) return null;
      const seed = input.seed >>> 0;
      const now = Date.now();
      const scene: Scene = {
        id: newSceneId(),
        prompt: trimmed,
        seed,
        timestamp: now,
      };
      // QA2: dedupe runs INSIDE the setSessions updater so two
      // near-simultaneous calls see each other's writes via `prev`,
      // not `sessionsRef.current` (which is updated post-commit).
      // The earlier M9.9 fix moved the read to `sessionsRef` to
      // avoid stale closures, but that ref still lags by one commit
      // — two calls within the same JS tick both read the pre-A
      // list. Moving the dedupe into the updater makes it the
      // authoritative single-threaded check.
      let added = false;
      setSessions((prev) => {
        const target = prev.find((s) => s.id === activeId);
        // Dedupe against the active session's last scene within 3s.
        if (target) {
          const last = target.scenes[target.scenes.length - 1];
          if (
            last &&
            last.prompt === scene.prompt &&
            last.seed === scene.seed &&
            now - last.timestamp < 3000
          ) {
            return prev;
          }
        }
        if (!target) {
          const newS: Session = {
            id: newSessionId(),
            title: deriveTitle([scene]),
            createdAt: now,
            updatedAt: now,
            scenes: [scene],
          };
          setActiveId(newS.id);
          added = true;
          return [newS, ...prev];
        }
        added = true;
        return prev.map((s) => {
          if (s.id !== activeId) return s;
          const scenes = [...s.scenes, scene];
          return {
            ...s,
            scenes,
            title: s.title || deriveTitle(scenes),
            updatedAt: now,
          };
        });
      });
      return added ? scene : null;
    },
    [activeId],
  );

  const removeScene = useCallback(
    (sceneId: string, sessionId?: string) => {
      const targetId = sessionId ?? activeId;
      if (!targetId) return;
      // QA2: previously this filter stripped the entire session
      // when its last scene was removed. The user clicked "delete
      // scene" and their whole session vanished. Now the session
      // survives with an empty scenes list; the active pointer
      // stays where it was. The chip in the topbar still shows
      // the session title (so the user knows it's not a bug).
      setSessions((prev) =>
        prev.map((s) => {
          if (s.id !== targetId) return s;
          const scenes = s.scenes.filter((sc) => sc.id !== sceneId);
          return {
            ...s,
            scenes,
            title: deriveTitle(scenes) || s.title,
            updatedAt: Date.now(),
          };
        }),
      );
    },
    [activeId],
  );

  const createSession = useCallback(
    (opts?: { title?: string; seed?: { prompt: string; seed: number } | null }): string => {
      const seedScene: Scene | null =
        opts?.seed && opts.seed.prompt.trim()
          ? {
              id: newSceneId(),
              prompt: opts.seed.prompt.trim(),
              seed: opts.seed.seed >>> 0,
              timestamp: Date.now(),
            }
          : null;
      const id = newSessionId();
      const newS: Session = {
        id,
        title: opts?.title ?? (seedScene ? deriveTitle([seedScene]) : "Untitled session"),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        scenes: seedScene ? [seedScene] : [],
      };
      setSessions((prev) => [newS, ...prev]);
      setActiveId(id);
      return id;
    },
    [],
  );

  const loadSession = useCallback((sessionId: string): Scene | null => {
    // Read from sessionsRef so consecutive calls within the same
    // render see the latest list. (The previous closure-captured
    // `sessions` would lag by one render in that case.)
    const target = sessionsRef.current.find((s) => s.id === sessionId);
    if (!target) return null;
    setActiveId(sessionId);
    return target.scenes[target.scenes.length - 1] ?? null;
  }, []);

  const deleteSession = useCallback((sessionId: string) => {
    setSessions((prev) => {
      const remaining = prev.filter((s) => s.id !== sessionId);
      setActiveId((curr) => {
        if (curr !== sessionId) return curr;
        // QA2: deleted the active session — fall back to the
        // most-recently-updated remaining session. Previously
        // this returned null, leaving the user with no active
        // pointer and the next paint auto-creating a brand-new
        // session. (Audit bug #19.)
        if (remaining.length === 0) return null;
        const mostRecent = [...remaining].sort(
          (a, b) => b.updatedAt - a.updatedAt,
        )[0];
        return mostRecent.id;
      });
      return remaining;
    });
  }, []);

  // Restores a previously-deleted session back into the list. Used by
  // the sidebar's undo-toast. (Audit bug #32.)
  const restoreSession = useCallback((session: Session) => {
    setSessions((prev) => {
      if (prev.some((s) => s.id === session.id)) return prev;
      return [session, ...prev];
    });
  }, []);

  const renameSession = useCallback((sessionId: string, title: string) => {
    const trimmed = title.trim().slice(0, 120);
    if (!trimmed) return;
    setSessions((prev) =>
      prev.map((s) =>
        s.id === sessionId
          ? { ...s, title: trimmed, updatedAt: Date.now() }
          : s,
      ),
    );
  }, []);

  const toggleFavorite = useCallback(
    (sceneId: string, sessionId?: string) => {
      const targetId = sessionId ?? activeId;
      if (!targetId) return;
      setSessions((prev) =>
        prev.map((s) => {
          if (s.id !== targetId) return s;
          return {
            ...s,
            scenes: s.scenes.map((sc) =>
              sc.id === sceneId
                ? { ...sc, favorite: !sc.favorite }
                : sc,
            ),
            updatedAt: Date.now(),
          };
        }),
      );
    },
    [activeId],
  );

  const recentPrompts = useCallback(
    () => {
      const out: { prompt: string; seed: number; timestamp: number }[] = [];
      for (const s of sessionsRef.current) {
        for (const sc of s.scenes) {
          out.push({
            prompt: sc.prompt,
            seed: sc.seed,
            timestamp: sc.timestamp,
          });
        }
      }
      out.sort((a, b) => b.timestamp - a.timestamp);
      return out.slice(0, 10);
    },
    [],
  );

  const setActive = useCallback((sessionId: string | null) => {
    // Validate that the requested id exists in our sessions list.
    // Without this, a stale id (e.g. from a URL or a deleted session
    // referenced in some external state) silently flips activeId to
    // a known-bad value and the next render shows `activeSession`
    // as null with no signal to the user. Allow null explicitly —
    // that's how callers deselect.
    //
    // We read the latest sessions list from `sessionsRef` rather
    // than abusing `setSessions` as a side-effect setter (the
    // previous M9.4 implementation did this; the issue was that
    // re-rendering setSessions with an unchanged value still
    // triggers a state update and would be a no-op cycle).
    if (sessionId === null) {
      setActiveId(null);
      return;
    }
    if (sessionsRef.current.some((s) => s.id === sessionId)) {
      setActiveId(sessionId);
      return;
    }
    // Stale id — log and no-op so the journal doesn't get
    // accidentally re-rooted to a non-existent session.
    // eslint-disable-next-line no-console
    console.warn(
      "[dream] setActive: session not found, ignoring:",
      sessionId,
    );
  }, []);

  const restoreBackup = useCallback((): boolean => {
    const r = restoreCorruptBackup();
    if (!r) return false;
    setSessions(r.sessions);
    setRecoveryNotice(false);
    clearCorruptBackups();
    return true;
  }, []);

  const dismissRecovery = useCallback(() => {
    setRecoveryNotice(false);
    clearCorruptBackups();
  }, []);

  // QA4: memoize the returned store object so consumers don't
  // re-render on every parent state change. Previously the
  // object literal was a new reference every render, which
  // propagated to <SessionContext.Provider value=...> and
  // re-rendered every consumer (Sidebar, VoiceDream, etc.)
  // on every keystroke in the interim transcript. The
  // callbacks are already useCallback'd and stable; only the
  // state values change identity between renders, so the
  // memo is keyed on those.
  return useMemo(
    () => ({
      sessions,
      activeSession,
      activeSessionId: activeId,
      addScene,
      removeScene,
      createSession,
      loadSession,
      deleteSession,
      restoreSession,
      renameSession,
      setActive,
      toggleFavorite,
      recentPrompts,
      pruneNotice,
      hydrated,
      recoveryNotice,
      restoreBackup,
      dismissRecovery,
    }),
    [
      sessions,
      activeSession,
      activeId,
      pruneNotice,
      hydrated,
      recoveryNotice,
      addScene,
      removeScene,
      createSession,
      loadSession,
      deleteSession,
      restoreSession,
      renameSession,
      setActive,
      toggleFavorite,
      recentPrompts,
      restoreBackup,
      dismissRecovery,
    ],
  );
}