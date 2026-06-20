"use client";

import { createContext, useContext } from "react";
import {
  useSessionStoreImpl,
  type UseSessionStore,
} from "../hooks/useSessionStore";

// One React-side store for the user's dream journal. Backs onto
// localStorage via `session-store.ts`. Survives reloads. Components
// access it via the `useSessions()` hook so the state is shared
// across the whole tree.

const SessionContext = createContext<UseSessionStore | null>(null);

export function useSessions(): UseSessionStore {
  const v = useContext(SessionContext);
  if (!v) {
    throw new Error("useSessions must be used inside <SessionProvider>");
  }
  return v;
}

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const store = useSessionStoreImpl();
  return <SessionContext.Provider value={store}>{children}</SessionContext.Provider>;
}