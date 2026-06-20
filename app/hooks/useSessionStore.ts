"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
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
    const result = saveToStorage(sessions, activeId, { pruneOnQuota: true });
    if (!result.ok && result.reason === "quota") {
      setPruneNotice((n) => n + 1);
    }
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
      // Dedupe: if the active session already has a scene with the
      // same prompt + same seed within the last 3 seconds, skip the
      // add. This handles the double-fire pattern where voice.onFinal
      // AND the form's onSubmit both try to add the same prompt
      // back-to-back (audit bug #7), AND it tolerates intentional
      // re-rolls (different seed).
      const now = Date.now();
      const dup = sessions.find((s) => s.id === activeId)?.scenes.find(
        (sc) => sc.prompt === trimmed && sc.seed === seed && now - sc.timestamp < 3000,
      );
      if (dup) return null;
      const scene: Scene = {
        id: newSceneId(),
        prompt: trimmed,
        seed,
        timestamp: Date.now(),
      };
      setSessions((prev) => {
        if (activeId === null || !prev.some((s) => s.id === activeId)) {
          const newS: Session = {
            id: newSessionId(),
            title: deriveTitle([scene]),
            createdAt: Date.now(),
            updatedAt: Date.now(),
            scenes: [scene],
          };
          setActiveId(newS.id);
          return [newS, ...prev];
        }
        return prev.map((s) => {
          if (s.id !== activeId) return s;
          const scenes = [...s.scenes, scene];
          return {
            ...s,
            scenes,
            title: s.title || deriveTitle(scenes),
            updatedAt: Date.now(),
          };
        });
      });
      return scene;
    },
    [activeId, sessions],
  );

  const removeScene = useCallback(
    (sceneId: string, sessionId?: string) => {
      const targetId = sessionId ?? activeId;
      if (!targetId) return;
      setSessions((prev) =>
        prev
          .map((s) => {
            if (s.id !== targetId) return s;
            const scenes = s.scenes.filter((sc) => sc.id !== sceneId);
            return {
              ...s,
              scenes,
              title: deriveTitle(scenes) || s.title,
              updatedAt: Date.now(),
            };
          })
          .filter((s) => s.scenes.length > 0),
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

  const loadSession = useCallback(
    (sessionId: string): Scene | null => {
      const target = sessions.find((s) => s.id === sessionId);
      if (!target) return null;
      setActiveId(sessionId);
      return target.scenes[target.scenes.length - 1] ?? null;
    },
    [sessions],
  );

  const deleteSession = useCallback((sessionId: string) => {
    setSessions((prev) => prev.filter((s) => s.id !== sessionId));
    setActiveId((curr) => {
      if (curr !== sessionId) return curr;
      // If we deleted the active session, fall back to the most-recent
      // remaining session so the user's next paint doesn't silently
      // land in a brand-new session. (Audit bug #98.)
      return null;
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

  const setActive = useCallback((sessionId: string | null) => {
    // Validate that the requested id exists in our sessions list.
    // Without this, a stale id (e.g. from a URL or a deleted session
    // referenced in some external state) silently flips activeId to
    // a known-bad value and the next render shows `activeSession`
    // as null with no signal to the user. Allow null explicitly —
    // that's how callers deselect.
    if (sessionId !== null) {
      // Read the latest sessions list via a functional setter so we
      // don't depend on a closure-captured `sessions` value.
      setSessions((prev) => {
        if (prev.some((s) => s.id === sessionId)) {
          // Found — commit the activeId change. (We can't call
          // setActiveId here because we're inside a setter; do it
          // after this microtask.)
          queueMicrotask(() => setActiveId(sessionId));
        } else {
          // Stale id — log and no-op so the journal doesn't get
          // accidentally re-rooted to a non-existent session.
          // eslint-disable-next-line no-console
          console.warn(
            "[dream] setActive: session not found, ignoring:",
            sessionId,
          );
        }
        // Always return prev unchanged — this setter exists only for
        // its side effect of validating the id.
        return prev;
      });
      return;
    }
    setActiveId(null);
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

  return {
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
    pruneNotice,
    hydrated,
    recoveryNotice,
    restoreBackup,
    dismissRecovery,
  };
}