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
  /**
   * QA13/F11: fork an existing session at a given scene
   * id (or at the end if not specified). The new
   * session owns an independent copy of every scene up
   * to and including the fork point, with "(fork)"
   * appended to the title. The original is left
   * untouched. Returns the new session id, or null if
   * the source session/scene wasn't found.
   */
  forkSession: (opts: { sessionId: string; atSceneId?: string }) => string | null;
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
  const [sessions, _setSessionsRaw] = useState<Session[]>([]);
  // QA17: every write to `sessions` goes through this wrapper so
  // that `sessionsRef.current` stays in lock-step with the React
  // state. The previous design mirrored `sessions → sessionsRef`
  // in a `useEffect` post-commit, which lagged by one render —
  // long enough that a same-tick `setActive(staleId)` would pass
  // the existence check (line 481) against the still-unculled ref
  // and orphan the active pointer. By updating the ref inside
  // the setter (BEFORE the next render) we keep every consumer
  // that reads `sessionsRef.current` honest about the current
  // session list.
  const setSessions = useCallback(
    (next: React.SetStateAction<Session[]>) => {
      _setSessionsRaw((prev) => {
        const resolved =
          typeof next === "function"
            ? (next as (p: Session[]) => Session[])(prev)
            : next;
        sessionsRef.current = resolved;
        return resolved;
      });
    },
    [],
  );
  const [activeId, setActiveId] = useState<string | null>(null);
  const [pruneNotice, setPruneNotice] = useState(0);
  const [hydrated, setHydrated] = useState(false);
  const [recoveryNotice, setRecoveryNotice] = useState(false);
  // Mirror of `sessions` for read-only use in stable callbacks
  // (notably setActive's id validation). Avoids the need to thread
  // `sessions` into the dep array, which would change the callback
  // identity every state update and force every consumer to re-run.
  //
  // QA17: now kept in lock-step with React state by the setSessions
  // wrapper above (synchronously, inside the updater). The previous
  // useEffect-based mirror lagged by one render and was the root
  // cause of the same-tick setActive(staleId) orphan bug.
  const sessionsRef = useRef<Session[]>([]);

  // QA16: mirror activeId into a ref so updaters inside
  // setSessions can read the LATEST activeId even when called
  // from a callback that was built before the most recent
  // setActive. addScene's callback identity is tied to the
  // activeId from when it was last memoized; a synchronous
  // setActive → addScene pair would otherwise see the OLD id.
  //
  // The mirroring is done INSIDE the custom setActive wrapper
  // below (and the other setters that mutate activeId), not
  // via a post-commit effect — a post-commit effect lags by
  // one render, which is exactly the bug we are fixing. The
  // effect below remains as a backstop for any code path
  // that calls the raw setActiveId directly.
  const activeIdRef = useRef<string | null>(activeId);
  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  // QA16: wrap setActiveId so every update mirrors into
  // activeIdRef synchronously. Without this, a `setActive +
  // addScene` pair in the same JS tick would see the OLD
  // activeIdRef.current inside addScene's updater.
  const setActiveIdSync = useCallback((next: string | null | ((prev: string | null) => string | null)) => {
    if (typeof next === "function") {
      setActiveId((prev) => {
        const v = (next as (p: string | null) => string | null)(prev);
        activeIdRef.current = v;
        return v;
      });
    } else {
      activeIdRef.current = next;
      setActiveId(next);
    }
  }, []);

  useEffect(() => {
    const r = loadFromStorage();
    setSessions(r.sessions);
    setActiveIdSync(r.activeId);
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
      // QA16: per-session merge — never clobber a fresher local
      // edit with a stale cross-tab read. Each session is keyed
      // by id, and we pick the side with the larger `updatedAt`.
      // A session that exists locally but not in storage is
      // preserved (it may be mid-write), and a session that
      // exists only in storage is added.
      setSessions((prev) => {
        const byId = new Map<string, Session>();
        for (const s of prev) byId.set(s.id, s);
        for (const s of r.sessions) {
          const ours = byId.get(s.id);
          if (!ours || (s.updatedAt ?? 0) > (ours.updatedAt ?? 0)) {
            byId.set(s.id, s);
          }
        }
        return Array.from(byId.values()).sort(
          (a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0),
        );
      });
      // Reconcile activeId — keep the current one if still
      // present, otherwise take the incoming one.
      setActiveIdSync((curr) => {
        if (curr && r.sessions.some((s) => s.id === curr)) return curr;
        return r.activeId;
      });
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
        // QA16: read activeId from the same render-frame ref as
        // setActive, not from the addScene closure. When the
        // caller did `setActive(newId); addScene(...)` back to
        // back, addScene's identity was rebuilt on the next render
        // and the closure still held the OLD activeId. Using a
        // ref here means the updater always sees the latest
        // activeId the React commit has reached. We mirror
        // activeId into this ref via a tiny effect below.
        const currActiveId = activeIdRef.current;
        const target = prev.find((s) => s.id === currActiveId);
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
          setActiveIdSync(newS.id);
          added = true;
          return [newS, ...prev];
        }
        added = true;
        return prev.map((s) => {
          if (s.id !== currActiveId) return s;
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
      setActiveIdSync(id);
      return id;
    },
    [],
  );

  // QA13/F11: fork a session at a scene id. Copies
  // every scene up to and including the fork point
  // into a brand-new session. The original session is
  // left intact, so the user can experiment without
  // polluting the source.
  //
  // We use `sessionsRef` (not the closure-captured
  // `sessions`) so a rapid double-fork always sees the
  // latest session list — the previous version of
  // similar code lagged by one render and forked the
  // wrong snapshot.
  const forkSession = useCallback(
    (opts: { sessionId: string; atSceneId?: string }): string | null => {
      const source = sessionsRef.current.find((s) => s.id === opts.sessionId);
      if (!source) return null;
      // Find the fork point — the scene index up to
      // which we copy. If no atSceneId is given, fork
      // at the end (the most recent scene).
      let forkIndex = source.scenes.length - 1;
      if (opts.atSceneId) {
        const idx = source.scenes.findIndex((sc) => sc.id === opts.atSceneId);
        if (idx < 0) return null;
        forkIndex = idx;
      }
      if (forkIndex < 0) return null;
      // Deep-copy the scenes up to the fork point. New
      // ids so the fork can be edited independently of
      // the source — toggling favorite on a forked
      // scene won't flip the source scene.
      const copiedScenes: Scene[] = source.scenes.slice(0, forkIndex + 1).map((s) => ({
        ...s,
        id: newSceneId(),
        // favorite is intentionally NOT copied — a
        // fork is a fresh exploration, not a copy of
        // the user's marks.
        favorite: false,
      }));
      const id = newSessionId();
      const fork: Session = {
        id,
        title: `${source.title} (fork)`,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        scenes: copiedScenes,
      };
      setSessions((prev) => [fork, ...prev]);
      setActiveIdSync(id);
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
    setActiveIdSync(sessionId);
    return target.scenes[target.scenes.length - 1] ?? null;
  }, []);

  const deleteSession = useCallback((sessionId: string) => {
    // QA16/R3: previous version called setActiveIdSync from
    // inside the setSessions updater. React may discard the
    // first updater invocation under concurrent rendering
    // (and the strict-mode dev double-invocation does this
    // every render), which leaves the inner setState with a
    // potentially stale snapshot. Compute the next active id
    // here from sessionsRef.current — a plain ref read, no
    // React magic — and dispatch the two setStates as sibling
    // calls outside the updater.
    //
    // QA17: also keep `sessionsRef.current` in lock-step with
    // the React state. The `setActive` callback (line 451
    // below) validates incoming ids against sessionsRef so
    // that a caller passing a stale id (e.g. a session that
    // was deleted in the same tick) cannot accidentally
    // re-root the journal to a non-existent session. Without
    // this synchronous update, sessionsRef lags by one render
    // and the validation passes against the deleted id,
    // orphaning the active pointer on the next commit.
    const remaining = sessionsRef.current.filter((s) => s.id !== sessionId);
    setSessions(remaining);
    const curr = sessionsRef.current.find((s) => s.id === sessionId) ? sessionId : null;
    setActiveIdSync((prev) => {
      if (prev !== curr) return prev;
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
      setActiveIdSync(null);
      return;
    }
    if (sessionsRef.current.some((s) => s.id === sessionId)) {
      setActiveIdSync(sessionId);
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
      forkSession,
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
      forkSession,
      setActive,
      toggleFavorite,
      recentPrompts,
      restoreBackup,
      dismissRecovery,
    ],
  );
}