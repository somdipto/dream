// QA19 regression tests — run with:
//   npx tsc --target es2022 --module nodenext --moduleResolution nodenext --skipLibCheck --outDir tests/.build-qa19 tests/qa19-regressions.test.ts app/lib/session-store.ts app/lib/event-bus.ts app/lib/reactor-errors.ts app/lib/last-image.ts
//   node --test tests/.build-qa19/tests/qa19-regressions.test.js
//
// Pins the invariants the round-5 audit fixed:
//   - S1: deleting the last session must persist; the empty
//        state must be written to localStorage, not silently
//        dropped, otherwise the session resurrects on reload.
//   - L4: the auto-retry effect must depend on the error
//        message, not the error object identity. A
//        same-reference ReactorError whose message mutates
//        would otherwise not re-classify and burn a key.
//
// The hooks themselves aren't directly testable without a
// renderer, so we test the *units* that back the fixes:
// saveToStorage + classifyReactorError.

import { test } from "node:test";
import assert from "node:assert/strict";

// Minimal window/localStorage shim for Node. session-store is
// SSR-safe and short-circuits on `typeof window === "undefined"`,
// so without this shim every call returns the empty default and
// the storage round-trip is a no-op.
const _store: Record<string, string> = {};
const g = globalThis as any;
if (typeof g.window === "undefined") {
  g.window = { localStorage: {
    getItem: (k: string) => (k in _store ? _store[k] : null),
    setItem: (k: string, v: string) => { _store[k] = String(v); },
    removeItem: (k: string) => { delete _store[k]; },
    clear: () => { for (const k of Object.keys(_store)) delete _store[k]; },
  } };
}

import { saveToStorage, loadFromStorage } from "../app/lib/session-store";
import { classifyReactorError } from "../app/lib/reactor-errors";
import type { Session } from "../app/lib/session-types";

const STORAGE_KEY = "lingbot.sessions.v1";
const ACTIVE_KEY = "lingbot.activeSessionId.v1";

// ────────────────────────────────────────────────────────────────────
// Task #250 (S1) — session-store persists the empty state
// ────────────────────────────────────────────────────────────────────

function makeSession(id: string, title = "S"): Session {
  return {
    id,
    title,
    createdAt: 1000,
    updatedAt: 1000,
    scenes: [
      {
        id: "sc1",
        prompt: "alpine meadow",
        seed: 7,
        timestamp: 1000,
      },
    ],
  };
}

test("session-store: deleting the last session persists an empty state", () => {
  // The previous bug: the post-hydration save effect early-
  // returned on `sessions.length === 0 && activeId === null`,
  // so a user who deleted their last session saw no write.
  // Reload resurrected the pre-delete session.
  window.localStorage.clear();
  saveToStorage([makeSession("a")], "a");
  const before = loadFromStorage();
  assert.equal(before.sessions.length, 1, "precondition: one session on disk");
  const result = saveToStorage([], null);
  assert.equal(result.ok, true, "save must succeed");
  const after = loadFromStorage();
  assert.equal(after.sessions.length, 0, "empty state must be persisted");
  assert.equal(after.activeId, null, "activeId must be cleared");
  const raw = window.localStorage.getItem(STORAGE_KEY);
  assert.ok(raw, "raw storage must be present");
  const parsed = JSON.parse(raw!);
  assert.deepEqual(parsed.sessions, [], "disk must show empty sessions");
});

test("session-store: activeId is removed when the last session is deleted", () => {
  window.localStorage.clear();
  saveToStorage([makeSession("a")], "a");
  assert.ok(window.localStorage.getItem(ACTIVE_KEY), "precondition: activeId on disk");
  saveToStorage([], null);
  assert.equal(window.localStorage.getItem(ACTIVE_KEY), null, "activeId must be removed");
});

// ────────────────────────────────────────────────────────────────────
// Task #247 (L4) — classifyReactorError pins the messages
// the auto-retry effect bails on, AND the ones it doesn't.
// The retry effect now depends on `lastError?.message` (not
// object identity), so the *value* of the message is what
// matters. These tests pin those shapes.
// ────────────────────────────────────────────────────────────────────

test("reactor-errors: 'credits_depleted' classifies correctly", () => {
  const c = classifyReactorError("credits have been depleted on this account");
  assert.equal(c.reason, "credits_depleted");
});

test("reactor-errors: 'auth' classifies correctly", () => {
  const c = classifyReactorError("HTTP 401: invalid api key");
  assert.equal(c.reason, "auth");
});

test("reactor-errors: 'rate_limited' classifies correctly", () => {
  const c = classifyReactorError("429 too many requests");
  assert.equal(c.reason, "rate_limited");
});

test("reactor-errors: 'service_unavailable' classifies correctly", () => {
  const c = classifyReactorError("All API keys are temporarily exhausted");
  assert.equal(c.reason, "service_unavailable");
});

test("reactor-errors: unrecognised message classifies as 'unknown' (not terminal → retry fires)", () => {
  // 'unknown' is NOT in isClassifiedTerminal, so the auto-retry
  // effect will fire for these — which is what we want for
  // genuinely transient SDK errors that the classifier hasn't
  // been taught to recognise yet.
  const c = classifyReactorError("websocket closed unexpectedly");
  assert.equal(c.reason, "unknown");
});
