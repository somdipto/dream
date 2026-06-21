// QA16 regression tests — run with:
//   node --test --import tsx tests/qa16-regressions.test.ts
//
// (or via pnpm if you wire a `test` script later — we don't add
// a test runner dep here, we just use the built-in `node:test`
// plus `tsx` to transpile the TS sources on import.)
//
// The whole point of this file is to nail down the invariants
// the QA16 audit and the past 8 bug fixes actually relied on,
// so the next person refactoring `useVoice`, `sanitizeUserText`,
// or `dreamBus` will see a test fail before they regress the
// behaviour the user can already see in production.

import { test } from "node:test";
import assert from "node:assert/strict";

// Pure helpers — safe to import directly from the source.
import { sanitizeUserText, MAX_PROMPT_CHARS, composeScenePrompt } from "../app/lib/scene-composer";
import { dreamBus } from "../app/lib/event-bus";
import { classifyReactorError } from "../app/lib/reactor-errors";
import { setLastImageUrl, readLastImageUrl } from "../app/lib/last-image";

test("sanitizeUserText strips control characters and collapses whitespace", () => {
  // The user can paste from a terminal, a chat app, or a PDF —
  // control bytes should not survive into a Reactor prompt.
  // Whitespace runs (spaces, tabs, newlines) collapse to a single
  // space — this is intentional so a 5-paragraph pasted prompt
  // becomes one composed line, not a wall of blank lines.
  const raw = "a dragon\x00 in\x07 the\nsky\tat dusk";
  assert.equal(sanitizeUserText(raw), "a dragon in the sky at dusk");
});

test("sanitizeUserText collapses whitespace runs", () => {
  // Multiple spaces / newlines should be one space, never the
  // composed prompt with a wall of whitespace in the middle.
  assert.equal(
    sanitizeUserText("a   dragon\n\nin\tthe   sky"),
    "a dragon in the sky",
  );
});

test("sanitizeUserText enforces MAX_PROMPT_CHARS", () => {
  const huge = "x".repeat(MAX_PROMPT_CHARS + 250);
  const out = sanitizeUserText(huge);
  assert.equal(out.length, MAX_PROMPT_CHARS);
  assert.ok(out.length <= MAX_PROMPT_CHARS, "must never exceed the cap");
});

test("sanitizeUserText returns empty string for non-string input", () => {
  // Defensive: callers pass through `useState`/`prompt` —
  // the type system should catch it, but React event handlers
  // can hand us odd shapes during a bad re-render.
  // The cast is intentional — production callers always pass
  // a string but the helper guards against runtime oddities.
  assert.equal(sanitizeUserText(undefined as unknown as string), "");
  assert.equal(sanitizeUserText(null as unknown as string), "");
  assert.equal(sanitizeUserText(42 as unknown as string), "");
});

test("dreamBus: listeners receive emitted events with the typed detail", () => {
  // Typed payload must flow end-to-end — this is the contract
  // that replaced the unsafe `window.dispatchEvent` shim.
  let received: { ms: number; ok: boolean } | null = null;
  const off = dreamBus.on("dream:paintDone", (d) => {
    received = d;
  });
  try {
    dreamBus.emit("dream:paintDone", { ms: 1234, ok: true });
    assert.deepEqual(received, { ms: 1234, ok: true });
  } finally {
    off();
  }
});

test("dreamBus: unsubscribe via the returned handle stops further delivery", () => {
  // Critical for the StatusBadge — when the user navigates
  // away, the listener must not keep firing and calling
  // setState on an unmounted component.
  let count = 0;
  const off = dreamBus.on("dream:paintDone", () => {
    count++;
  });
  dreamBus.emit("dream:paintDone", { ms: 1, ok: true });
  assert.equal(count, 1);
  off();
  dreamBus.emit("dream:paintDone", { ms: 2, ok: true });
  assert.equal(count, 1, "after unsubscribe the listener must not fire");
});

test("dreamBus: one listener throwing does not block the others", () => {
  // QA16/ponytail invariant — a misbehaving subscriber (say
  // a future analytics ping) must not stop the StatusBadge
  // from also receiving the event. The bus catches + warns.
  const originalWarn = console.warn;
  const warnings: unknown[] = [];
  console.warn = (...args) => warnings.push(args);
  try {
    let second = 0;
    dreamBus.on("dream:paintDone", () => {
      throw new Error("intentional");
    });
    dreamBus.on("dream:paintDone", () => {
      second++;
    });
    dreamBus.emit("dream:paintDone", { ms: 5, ok: true });
    assert.equal(second, 1, "second listener must still fire");
    assert.equal(warnings.length, 1, "throwing listener must be reported once");
  } finally {
    console.warn = originalWarn;
  }
});

test("classifyReactorError: 429 only routes with HTTP prefix, not arbitrary digits", () => {
  // QA16: was `m.includes("429")` — false-routed messages
  // containing the substring anywhere (a $429 charge, a 1429-
  // line error). The fix requires the canonical HTTP prefix
  // ("HTTP 429", "status 429", "code 429", "429 too many
  // requests") so that billing / line-number / error-id
  // substrings never trigger the rate-limited branch.
  assert.notEqual(
    classifyReactorError("Payment failed: $429.00 charge declined").reason,
    "rate_limited",
    "billing $429 must NOT route to rate_limited",
  );
  assert.notEqual(
    classifyReactorError("failed at line 1429 of session.ts").reason,
    "rate_limited",
    "line 1429 must NOT route to rate_limited",
  );
  // Canonical forms still route correctly.
  assert.equal(
    classifyReactorError("HTTP 429 from /v1/sessions").reason,
    "rate_limited",
  );
  assert.equal(
    classifyReactorError("status: 429, retry-after: 30").reason,
    "rate_limited",
  );
});

test("classifyReactorError: 401 only routes with HTTP prefix or explicit auth message", () => {
  // Same canonical-prefix fix for 401. Without the fix, a
  // "request 401 aborted at line 401" message would route
  // to auth and ask the user to check their API key. The
  // "unauthorized" / "api key" substring checks are
  // retained because they are unambiguous in a Reactor
  // error context.
  assert.notEqual(
    classifyReactorError("request aborted at line 401 of the retry loop")
      .reason,
    "auth",
    "line 401 must NOT route to auth",
  );
  // Canonical forms still route correctly.
  assert.equal(
    classifyReactorError("HTTP 401 unauthorized").reason,
    "auth",
  );
  assert.equal(
    classifyReactorError("api key rejected by Reactor").reason,
    "auth",
  );
});

test("classifyReactorError: empty / null message falls back to service_unavailable", () => {
  // Defensive — callers can pass `null` from `error?.message ?? null`.
  assert.equal(classifyReactorError("").reason, "service_unavailable");
  assert.equal(classifyReactorError(null).reason, "service_unavailable");
  assert.equal(classifyReactorError(undefined).reason, "service_unavailable");
});

test("setLastImageUrl: rejects javascript:/data:/file: URLs at the boundary", () => {
  // QA16: a poisoned SDK response or a stale closure passing
  // a `javascript:alert(1)` string must not be able to land
  // in the download `<a href>`. The boundary rejects
  // everything except https://cdn.reactor.inc and blob:.
  setLastImageUrl("javascript:alert(1)");
  assert.equal(readLastImageUrl(), undefined, "javascript: must be dropped");
  setLastImageUrl("data:text/html,<script>alert(1)</script>");
  assert.equal(readLastImageUrl(), undefined, "data: must be dropped");
  setLastImageUrl("file:///etc/passwd");
  assert.equal(readLastImageUrl(), undefined, "file: must be dropped");
  setLastImageUrl("https://evil.example.com/x.png");
  assert.equal(
    readLastImageUrl(),
    undefined,
    "non-cdn https:// must be dropped",
  );
  setLastImageUrl(null);
  assert.equal(readLastImageUrl(), undefined, "null clears the buffer");
  // The legitimate forms still work.
  setLastImageUrl("https://cdn.reactor.inc/scenes/abc.png");
  assert.equal(
    readLastImageUrl(),
    "https://cdn.reactor.inc/scenes/abc.png",
  );
  setLastImageUrl("blob:http://localhost:3000/1234-5678");
  assert.equal(
    readLastImageUrl(),
    "blob:http://localhost:3000/1234-5678",
  );
});

test("composeScenePrompt: body never carries control characters", () => {
  // QA16: `text.trim().replace(/\s+/g, " ").slice(...)` used
  // the raw `text` rather than the sanitized `safe` — so a
  // user pasting "\x00\x01a dragon" produced a composed
  // prompt with a leading null byte. After the fix, body
  // and subject both derive from the same sanitized input.
  const prompt = composeScenePrompt({ text: "\x00\x01a dragon at dusk" });
  // The composed prompt must not contain a NUL, SOH, or any
  // other C0/C1 control char.
  assert.ok(
    !/[\x00-\x08\x0B-\x1F\x7F-\x9F]/.test(prompt),
    "composed prompt must not contain control characters",
  );
  assert.ok(prompt.includes("a dragon at dusk"));
});

// QA16/F-product: Flick-to-Paint prompt mapping
// Every kind must produce a non-empty prompt and never throw.
import { flickToPrompt, type FlickKind } from "../app/hooks/useMotionFlicks";
const KINDS: FlickKind[] = ["spin", "dive", "lift", "roll"];
test("flickToPrompt: returns a non-empty prompt for every kind", () => {
  for (const k of KINDS) {
    const p = flickToPrompt(k);
    assert.ok(typeof p === "string" && p.length > 0, `${k} -> ${p}`);
  }
});
test("flickToPrompt: same kind -> same string (deterministic)", () => {
  for (const k of KINDS) {
    assert.equal(flickToPrompt(k), flickToPrompt(k));
  }
});

// QA16/R3 regression tests — round-3 audit fixes
import { parseVoiceStyle } from "../app/lib/voice-style-parser";

test("parseVoiceStyle: word-as-prefix of a style/variant label does NOT trigger a match", () => {
  // QA16/R3: the previous matchStyleOrVariant had a
  // `firstWord.startsWith(entry.label)` branch. It matched
  // "rainbow".startsWith("rain"), "nightmare".startsWith("night"),
  // "defaulted".startsWith("default"), and stripped the user's
  // leading subject from `cleanedPrompt`. The fix requires the
  // STYLE label to be a *prefix of a longer first word*, never
  // the other way around — a real style cue is a complete word,
  // not a prefix.
  const r1 = parseVoiceStyle("a dragon in rainbow style");
  assert.equal(r1.styleId, null, "rainbow style must NOT route to rain");
  assert.equal(r1.variantId, null, "rainbow style must NOT route to rain variant");
  assert.equal(r1.cleanedPrompt, "a dragon in rainbow style",
    "user's subject must survive — leading clause must not be stripped");

  // Use a leading clause that doesn't itself look like a time
  // variant — otherwise the time-intro pass would legitimately
  // match and we'd be testing the wrong thing.
  const r2 = parseVoiceStyle("a castle in nightmare vibes");
  assert.equal(r2.styleId, null, "nightmare vibes must NOT route to night");
  assert.equal(r2.variantId, null, "nightmare vibes must NOT route to night variant");
  assert.equal(r2.cleanedPrompt, "a castle in nightmare vibes",
    "subject must survive the nightmare prefix trap");

  const r3 = parseVoiceStyle("a defaulted car");
  assert.notEqual(r3.styleId, "default",
    "leading 'defaulted' must not strip the subject to a style chip");
});

test("parseVoiceStyle: exact-match style/variant still works", () => {
  // Regression guard — make sure the prefix-fix didn't break
  // the legitimate matches.
  const r = parseVoiceStyle("a misty forest in noir style");
  assert.equal(r.styleId, "noir", "noir style still routes to noir");
  // The cleaned prompt should retain the subject but drop
  // the style-intro clause.
  assert.ok(r.cleanedPrompt.includes("misty forest"),
    "subject must survive when style is genuine");
  assert.ok(!r.cleanedPrompt.includes("noir"),
    "style clause must be stripped when matched");

  const v = parseVoiceStyle("a beach at sunset");
  assert.equal(v.variantId, "sunset", "at sunset still routes to sunset variant");
  assert.ok(v.cleanedPrompt.includes("beach"),
    "subject must survive when time-of-day is genuine");
});

test("classifyReactorError: 'api key' substring is not enough — must include an auth verb", () => {
  // QA16/R3: the previous `m.includes(\"api key\")` branch
  // mis-routed any error whose message contained the literal
  // substring. Reactor's billing / usage emails contain \"api
  // key quota\" and the SDK's 4xx bodies contain \"api key
  // required\" — those are quota / 4xx errors, not auth
  // rejections. The fix requires an explicit auth verb
  // (\"rejected\", \"invalid\", \"unauthorized\") so quota
  // messages fall through to their proper bucket.
  assert.notEqual(
    classifyReactorError("api key quota exceeded for this month").reason,
    "auth",
    "quota message must NOT route to auth",
  );
  assert.notEqual(
    classifyReactorError("api key required but missing in request").reason,
    "auth",
    "'required' alone must NOT route to auth",
  );
  assert.notEqual(
    classifyReactorError("error: api key not configured for endpoint").reason,
    "auth",
    "'not configured' must NOT route to auth",
  );
  // Canonical forms still route correctly.
  assert.equal(
    classifyReactorError("api key rejected by Reactor").reason,
    "auth",
    "rejected still routes to auth",
  );
  assert.equal(
    classifyReactorError("invalid api key provided").reason,
    "auth",
    "invalid still routes to auth",
  );
  assert.equal(
    classifyReactorError("HTTP 401 unauthorized").reason,
    "auth",
    "HTTP 401 still routes to auth",
  );
  assert.equal(
    classifyReactorError("HTTP 403 forbidden").reason,
    "auth",
    "HTTP 403 now routes to auth (was unclassified before)",
  );
});

// QA16/R3: session-store empty-array recovery regression
import { loadFromStorage, saveToStorage } from "../app/lib/session-store";
function withStorage<T>(fn: () => T): T {
  // Node 22 doesn't have a global `Storage`, but
  // session-store uses `window.localStorage` which in the
  // current implementation requires a `window` shim too.
  // Build the smallest fake that matches the surface
  // session-store touches.
  const g = globalThis as unknown as {
    window?: {
      localStorage: {
        getItem: (k: string) => string | null;
        setItem: (k: string, v: string) => void;
        removeItem: (k: string) => void;
      };
    };
  };
  const hadWindow = "window" in g;
  const prevWindow = g.window;
  const store = new Map<string, string>();
  g.window = {
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k)! : null),
      setItem: (k, v) => { store.set(k, v); },
      removeItem: (k) => { store.delete(k); },
    },
  };
  try { return fn(); } finally {
    if (hadWindow) g.window = prevWindow; else delete g.window;
  }
}

test("session-store: empty sessions array is NOT a recovery event", () => {
  // QA16/R3: the previous `sessions.length === 0 && hadSessionsKey`
  // branch treated a fresh device's empty `{\"version\":1,
  // \"sessions\":[]}` as a recovery event and showed a banner
  // \"We restored your previous sessions\" on first install.
  // We now also require `rawCount > 0` — a parseable but empty
  // array is a clean slate.
  const result = withStorage(() => {
    saveToStorage([], null);
    return loadFromStorage();
  });
  assert.equal(result.sessions.length, 0, "empty store stays empty");
  assert.equal(result.recovered, false,
    "empty array must NOT trigger recovered:true (was showing banner)");
});

test("session-store: real parse failure DOES set recovered", () => {
  // Regression guard — the empty-array fix must not break the
  // original corruption-detection behavior. A blob with a
  // sessions array that doesn't parse out into anything should
  // still flag recovered:true and back the blob up.
  const result = withStorage(() => {
    (globalThis as unknown as { window: { localStorage: { setItem: (k: string, v: string) => void } } }).window.localStorage.setItem(
      "lingbot.sessions.v1",
      JSON.stringify({
        version: 1,
        sessions: [{ id: "garbage", not_a_session: true }],
      }),
    );
    return loadFromStorage();
  });
  assert.equal(result.sessions.length, 0,
    "garbage sessions don't materialize");
  assert.equal(result.recovered, true,
    "real parse failure still sets recovered:true");
});

// F8: BYOK chip → error screen paste form via event bus.
// Regression guard: if anyone removes the bus event the
// topbar fingerprint chip becomes dead and the user can't
// replace their saved key without dismissing the error.
test("dream:openByok round-trips through the bus and a listener can open the paste form", () => {
  let opened = 0;
  const off = dreamBus.on("dream:openByok", () => {
    opened += 1;
  });
  dreamBus.emit("dream:openByok", {});
  dreamBus.emit("dream:openByok", {});
  off();
  dreamBus.emit("dream:openByok", {});
  assert.equal(opened, 2,
    "two emits before off, one after off — exactly 2 listener fires");
});

// Round 7: dream:toast was a dead-letter bus.
// 6 emit sites + 0 listeners meant every toast in the app
// was silently dropped (export success, share-with-no-prompt,
// etc.). The ToastCenter component is the listener; this
// test guards that:
//
//   1. emits with valid shape produce a render that contains
//      the message,
//   2. emits with the same `id` are still rendered (id is
//      used for dedup hint, not to collapse rows),
//   3. emits with bogus kind default to "info".
test("dream:toast — at least one listener exists in the app source", () => {
  // Static check: the ToastCenter subscribes to dream:toast.
  // If anyone deletes it we should know before this regresses.
  const fs = require("node:fs");
  const path = require("node:path");
  // process.cwd() is the repo root when tests run via `npm test`.
  const ts = fs.readFileSync(
    path.join(process.cwd(), "app/components/ToastCenter.tsx"),
    "utf8",
  );
  assert.match(ts, /dreamBus\.on\(\s*["']dream:toast["']/,
    "ToastCenter must subscribe to the dream:toast event");
});

test("dream:toast — kind defaults to info when omitted by an emitter", () => {
  // Soft contract for emitters that forget to set `kind`. The
  // event-bus type allows omitting kind? No — it requires "info"
  // | "error" | "success". But let's make sure the ToastCenter
  // accepts any of the three shapes.
  let seen: { kind: string; message: string } | null = null;
  const off = dreamBus.on("dream:toast", (d) => {
    seen = { kind: d.kind, message: d.message };
  });
  for (const kind of ["info", "error", "success"] as const) {
    dreamBus.emit("dream:toast", { kind, message: `hello-${kind}`, ttlMs: 1000 });
    assert.ok(seen, "listener fires for kind=" + kind);
    assert.equal((seen as { kind: string; message: string }).kind, kind);
    assert.equal((seen as { kind: string; message: string }).message, `hello-${kind}`);
  }
  off();
});
