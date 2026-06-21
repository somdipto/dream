// QA20 regression tests — run with:
//   npx tsc --target es2022 --module nodenext --moduleResolution nodenext --skipLibCheck --outDir tests/.build-qa20 tests/qa20-regressions.test.ts app/lib/byok.ts app/lib/byok-prompt.ts
//   node --test tests/.build-qa20/tests/qa20-regressions.test.js
//
// Pins invariants for the BYOK + credits_depleted flow:
//   - markSawCreditsDepleted() / consumeSawCreditsDepleted() round-trip
//   - peekSawCreditsDepleted() observes without consuming
//   - readCachedEnvProbe() respects the 30-min TTL
//   - probeEnvPool() classifies a 500 "no api key" as "empty"
//   - probeEnvPool() classifies a 200 token response as "ok"
//
// Why these matter: when the host env key is exhausted, the
// Begin overlay must surface the paste field automatically —
// the user can't be expected to hunt for a small link after
// the app just told them they're out of credits.

import { test } from "node:test";
import assert from "node:assert/strict";

const _store: Record<string, string> = {};
const g = globalThis as any;
if (typeof g.window === "undefined") {
  g.window = {
    localStorage: {
      getItem: (k: string) => (k in _store ? _store[k] : null),
      setItem: (k: string, v: string) => {
        _store[k] = String(v);
      },
      removeItem: (k: string) => {
        delete _store[k];
      },
      clear: () => {
        for (const k of Object.keys(_store)) delete _store[k];
      },
    },
  };
}

// Minimal fetch shim — tests below override per case.
const origFetch = g.fetch;
function setFetchResponse(handler: (url: string, init?: any) => Response | Promise<Response>) {
  g.fetch = (url: any, init?: any) => Promise.resolve(handler(String(url), init));
}
function resetFetch() {
  g.fetch = origFetch;
}

import {
  markSawCreditsDepleted,
  consumeSawCreditsDepleted,
  peekSawCreditsDepleted,
  readCachedEnvProbe,
  writeCachedEnvProbe,
  probeEnvPool,
} from "../app/lib/byok-prompt";

test("markSawCreditsDepleted round-trips with consume", () => {
  for (const k of Object.keys(_store)) delete _store[k];
  assert.equal(consumeSawCreditsDepleted(), false);
  markSawCreditsDepleted();
  assert.equal(peekSawCreditsDepleted(), true);
  // consume returns true AND clears the flag.
  assert.equal(consumeSawCreditsDepleted(), true);
  assert.equal(consumeSawCreditsDepleted(), false);
});

test("peekSawCreditsDepleted does not consume", () => {
  for (const k of Object.keys(_store)) delete _store[k];
  markSawCreditsDepleted();
  assert.equal(peekSawCreditsDepleted(), true);
  assert.equal(peekSawCreditsDepleted(), true);
  // Flag still set after a peek.
  assert.equal(consumeSawCreditsDepleted(), true);
});

test("readCachedEnvProbe returns unknown when nothing cached", () => {
  for (const k of Object.keys(_store)) delete _store[k];
  assert.equal(readCachedEnvProbe(), "unknown");
});

test("readCachedEnvProbe respects cached value", () => {
  for (const k of Object.keys(_store)) delete _store[k];
  writeCachedEnvProbe("empty");
  assert.equal(readCachedEnvProbe(), "empty");
  writeCachedEnvProbe("ok");
  assert.equal(readCachedEnvProbe(), "ok");
});

test("readCachedEnvProbe returns unknown for an expired entry", () => {
  for (const k of Object.keys(_store)) delete _store[k];
  // Backdate the probe to 31 minutes ago (TTL is 30).
  const longAgo = Date.now() - 31 * 60 * 1000;
  _store["dream.byok.envProbe.v1"] = JSON.stringify({ result: "empty", at: longAgo });
  assert.equal(readCachedEnvProbe(), "unknown");
});

test("probeEnvPool classifies a 500 no-api-key body as empty", async () => {
  for (const k of Object.keys(_store)) delete _store[k];
  setFetchResponse((url) => {
    assert.equal(url, "/api/reactor/token");
    return new Response(
      JSON.stringify({ error: "No Reactor API key is available. Set REACTOR_API_KEYS on the server, or paste your own key in the app." }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
  });
  try {
    const result = await probeEnvPool();
    assert.equal(result, "empty");
    assert.equal(readCachedEnvProbe(), "empty");
  } finally {
    resetFetch();
  }
});

test("probeEnvPool classifies a 200 token response as ok", async () => {
  for (const k of Object.keys(_store)) delete _store[k];
  setFetchResponse(() => {
    return new Response(
      JSON.stringify({ jwt: "fake.jwt.value", expires_at: Math.floor(Date.now() / 1000) + 600 }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  try {
    const result = await probeEnvPool();
    assert.equal(result, "ok");
    assert.equal(readCachedEnvProbe(), "ok");
  } finally {
    resetFetch();
  }
});

test("probeEnvPool classifies a 500 non-no-api-key body as ok", async () => {
  for (const k of Object.keys(_store)) delete _store[k];
  // 500 with a generic body (not the 'no api key' marker) means
  // a key WAS configured but failed. Don't make the user paste
  // their own — they may not have one.
  setFetchResponse(() => {
    return new Response(
      JSON.stringify({ error: "Upstream network error" }),
      { status: 502, headers: { "content-type": "application/json" } },
    );
  });
  try {
    const result = await probeEnvPool();
    assert.equal(result, "ok");
  } finally {
    resetFetch();
  }
});

test("probeEnvPool swallows network errors and reports ok", async () => {
  for (const k of Object.keys(_store)) delete _store[k];
  setFetchResponse(() => {
    throw new Error("network down");
  });
  try {
    const result = await probeEnvPool();
    assert.equal(result, "ok");
  } finally {
    resetFetch();
  }
});
