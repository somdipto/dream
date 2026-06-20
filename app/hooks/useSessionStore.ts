"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  deriveTitle,
  newSceneId,
  newSessionId,
  type Scene,
  type Session,
} from "../lib/session-types";
import { loadFromStorage, saveToStorage } from "../lib/session-store";

export interface UseSessionStore {
  sessions: Session[];
  activeSession: Session | null;
  activeSessionId: string | null;
  addScene: (input: { prompt: string; seed: number }) => Scene | null;
  removeScene: (sceneId: string) => void;
  createSession: (opts?: { title?: string; seed?: { prompt: string; seed: number } | null }) => string;
  loadSession: (sessionId: string) => Scene | null;
  deleteSession: (sessionId: string) => void;
  setActive: (sessionId: string | null) => void;
  /** Bumped when a save attempt hits quota and prunes. */
  pruneNotice: number;
  /** True once the store has hydrated from localStorage. */
  hydrated: boolean;
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

  useEffect(() => {
    const r = loadFromStorage();
    setSessions(r.sessions);
    setActiveId(r.activeId);
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
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
      const scene: Scene = {
        id: newSceneId(),
        prompt: trimmed,
        seed: input.seed >>> 0,
        timestamp: Date.now(),
      };
      // eslint-disable-next-line no-console
      console.log("[ss] addScene prompt=", trimmed.slice(0, 20), "activeId=", activeId, "sessions=", sessions.length);
      setSessions((prev) => {
        if (activeId === null || !prev.some((s) => s.id === activeId)) {
          // eslint-disable-next-line no-console
          console.log("[ss]   creating new session");
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
    [activeId],
  );

  const removeScene = useCallback(
    (sceneId: string) => {
      setSessions((prev) => {
        if (!activeId) return prev;
        return prev
          .map((s) => {
            if (s.id !== activeId) return s;
            const scenes = s.scenes.filter((sc) => sc.id !== sceneId);
            return {
              ...s,
              scenes,
              title: deriveTitle(scenes) || s.title,
              updatedAt: Date.now(),
            };
          })
          .filter((s) => s.scenes.length > 0);
      });
    },
    [activeId],
  );

  const createSession = useCallback(
    (opts?: { title?: string; seed?: { prompt: string; seed: number } | null }): string => {
      // eslint-disable-next-line no-console
      console.log("[ss] createSession called");
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
    setActiveId((curr) => (curr === sessionId ? null : curr));
  }, []);

  const setActive = useCallback((sessionId: string | null) => {
    setActiveId(sessionId);
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
    setActive,
    pruneNotice,
    hydrated,
  };
}