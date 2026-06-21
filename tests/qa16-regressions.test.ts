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
