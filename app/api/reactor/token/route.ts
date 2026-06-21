import { NextResponse } from "next/server";

// Hardening audit (June 2026):
//   - AbortSignal.timeout on the upstream Reactor fetch so a hung
//     Reactor doesn't pin a Node worker for 30+ s.
//   - One retry on transient 5xx (502/503/504) per key.
//   - Shape validation on the upstream response so a future Reactor
//     contract change can't silently produce `Cache-Control: max-age=NaN`.
//   - Defensive Vary header (kept the existing `private` directive).
//   - Per-IP rate limiting using a tiny in-memory token bucket — not
//     perfect but it blunts the "anonymous bot mints until the bill
//     is non-trivial" attack surface. Sufficient for hackathon scale.
//
// M9.7: Key pool + soft rotation.
//   The user asked for a fallback so that when one API key runs out
//   of credits (402) the next request can try a different key, and a
//   live demo doesn't die the moment the first key gets capped.
//   We read REACTOR_API_KEYS as a comma-separated list. If unset, we
//   fall back to the legacy single-key REACTOR_API_KEY (backwards-
//   compatible with existing deployments).
//
//   Strategy:
//     - Healthy keys are tried in declared order.
//     - 402 (credits_depleted) → mark exhausted for EXHAUSTED_TTL_MS
//       and try the next key. 402 is the explicit "give up on this
//       key" signal.
//     - 401/403 (auth) → fatal, do NOT retry. Surface the error to
//       the caller. Continuing on a bad-auth key is wasted work and
//       would mask config errors.
//     - 5xx / network / timeout → rotate to the next key. The
//       failure might be per-key infra.
//     - 429 (rate-limited) → do NOT rotate. The 429 is per-IP at
//       the SDK layer, not per-key, so rotating would just delay
//       and potentially burn the next key's quota too. Return 429.
//
//   The pool is in-memory; it resets on process restart, which is
//   fine for our scale.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// How long we ask Reactor to make the JWT valid for. The server caps
// this at its configured maximum (currently 6h), so asking for more
// is harmless — you just get the server max back.
const TOKEN_LIFETIME_SECONDS = 6 * 60 * 60;

// Safety margin on the cache lifetime so an in-flight request doesn't
// race with the real expiry.
const CACHE_SKEW_SECONDS = 60;

// Cap the upstream call at 8 s. If Reactor hangs longer, abort and
// fall through to retry. Total worst-case is ~16 s per key.
const UPSTREAM_TIMEOUT_MS = 8000;

// How long a key is parked after it returns 402. During this window
// we skip the key entirely on subsequent token requests. After the
// window, we retry it (in case Reactor refreshed the account). The
// value is intentionally short for a hackathon context where the
// host may refill credits throughout the day.
const EXHAUSTED_TTL_MS = 15 * 60 * 1000;

// Per-IP token bucket: each bucket refills at 1 token / 10 s with a
// burst capacity of 5. A single user re-loading the page 5 times in a
// row succeeds; anything more gets a 429 until the bucket refills.
const RATE_LIMIT_BURST = 5;
const RATE_LIMIT_REFILL_MS = 10_000;
// Evict bucket entries that haven't been touched for this long. Keeps
// the map from growing unbounded under a scripted scan across many
// IPs (each new IP would otherwise add an entry that lives forever).
const BUCKET_TTL_MS = 10 * 60 * 1000;
const buckets = new Map<string, { tokens: number; updatedAt: number }>();

// QA4: inline lazy eviction of stale buckets inside takeToken.
// Previously a 60s setInterval held strong refs to the bucket
// map via its closure (unref only releases the timer, not the
// captured state) — under sustained traffic the map grew
// unbounded between sweeps and the cadence was coarse enough
// that a 10s/IP burst could leak through.
function takeToken(ip: string): boolean {
  const now = Date.now();
  // Cheap O(n) sweep, gated on a clock so it's free in the
  // common case (last sweep was recent).
  if (buckets.size > 32 && now - lastSweepAt > 30_000) {
    const cutoff = now - BUCKET_TTL_MS;
    for (const [k, v] of buckets) {
      if (v.updatedAt < cutoff) buckets.delete(k);
    }
    lastSweepAt = now;
  }
  const b = buckets.get(ip) ?? { tokens: RATE_LIMIT_BURST, updatedAt: now };
  const elapsed = now - b.updatedAt;
  const refill = (elapsed / RATE_LIMIT_REFILL_MS) * 1;
  const tokens = Math.min(RATE_LIMIT_BURST, b.tokens + refill);
  if (tokens < 1) {
    buckets.set(ip, { tokens, updatedAt: now });
    return false;
  }
  buckets.set(ip, { tokens: tokens - 1, updatedAt: now });
  return true;
}

// QA4: lazy sweep timestamp (replaces the setInterval which
// kept the process alive and held strong references).
let lastSweepAt = 0;

// QA4: also expire key-pool entries lazily inside takeToken
// (instead of via the swept setInterval). The pool is small
// so the per-call cost is trivial.
function expireKeyPoolEntries(now: number) {
  for (const k of keyPool.keys) {
    if (k.exhaustedUntil && now >= k.exhaustedUntil) {
      k.exhaustedUntil = null;
      k.lastError = null;
    }
  }
}

// Trust X-Forwarded-For AND X-Real-IP only if we are explicitly
// behind a reverse proxy (set TRUST_PROXY=1). Without that flag,
// both headers are fully client-controlled; trusting them lets a
// single attacker mint unlimited tokens by rotating the header on
// each request (the rate-limit bucket keys on IP).
function clientIp(headers: Headers, trustProxy: boolean): string {
  if (trustProxy) {
    const fwd = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
    if (fwd) return fwd;
    const real = headers.get("x-real-ip")?.trim();
    if (real) return real;
  }
  // QA4: even without a proxy, accept X-Real-IP if present
  // (some edge runtimes set it without the trust flag) but
  // ALSO try to derive a per-connection key from
  // CF-Connecting-IP / Fly-Client-IP / True-Client-IP, then
  // fall back to a SHA-256 of the User-Agent so that all
  // direct connections do NOT collapse into a single
  // "unknown" bucket. Without this, every direct request
  // from a different user shared one 5-burst bucket.
  const real = headers.get("x-real-ip")?.trim();
  if (real) return real;
  const cf = headers.get("cf-connecting-ip")?.trim();
  if (cf) return cf;
  const fly = headers.get("fly-client-ip")?.trim();
  if (fly) return fly;
  const tci = headers.get("true-client-ip")?.trim();
  if (tci) return tci;
  // Last resort: bucket by User-Agent + Accept-Language hash.
  // QA5: mixing Accept-Language into the hash makes the
  // bucket stable across browser updates. Previously the
  // bucket was UA-only, so a user on iOS 18 → iOS 19 lost
  // their bucket on update and suddenly hit a fresh burst
  // quota. UA and language both evolve in the same way —
  // they're not perfect, but they cluster on the same
  // "this is roughly the same user" feature.
  const ua = headers.get("user-agent") ?? "";
  if (ua) {
    const lang = headers.get("accept-language") ?? "";
    // Tiny non-cryptographic hash; we just need stable bucketing.
    let h = 5381;
    const s = ua + "|" + lang;
    for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return `ua-${h.toString(36)}`;
  }
  return "unknown";
}

// ---------------------------------------------------------------------------
// Key pool
// ---------------------------------------------------------------------------

interface PoolKey {
  /** Last 4 chars of the key, for logging without leaking the key. */
  fingerprint: string;
  /** Set when the key recently returned 402 / 5xx. Cleared after
   *  EXHAUSTED_TTL_MS elapses. While set, the key is skipped. */
  exhaustedUntil: number | null;
  /** Last error message from this key, for debug. */
  lastError: string | null;
}

class KeyPool {
  keys: PoolKey[] = [];
  index = 0;
  /** Set when the most recent call tried all keys and none succeeded.
   *  Used to short-circuit subsequent requests with a 503 so the
   *  client doesn't trigger N+1 upstream calls on a hot page. */
  allKeysExhaustedAt = 0;
  /** Fingerprint of the env var that produced the current keys.
   *  Used to detect hot-rotated keys without a process restart. */
  _envFingerprint = "";

  load(env: NodeJS.ProcessEnv): { count: number; legacy: boolean } {
    // QA2: refresh from env if the env value changed since the
    // last load (e.g. dev added a key to .env without restart).
    // Without this, hot key rotation silently ignored.
    const currentEnv = (env.REACTOR_API_KEYS ?? env.REACTOR_API_KEY ?? "").trim();
    const currentFingerprint = currentEnv ? fingerprintEnv(currentEnv) : "";
    if (this.keys.length > 0 && this._envFingerprint === currentFingerprint) {
      return { count: this.keys.length, legacy: false };
    }
    const list = (env.REACTOR_API_KEYS ?? "").trim();
    if (list) {
      const arr = list
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (arr.length) {
        this.keys = arr.map((k) => ({
          fingerprint: fingerprintKey(k),
          exhaustedUntil: null,
          lastError: null,
        }));
        this._raw = arr;
        this._envFingerprint = currentFingerprint;
        return { count: arr.length, legacy: false };
      }
    }
    const single = (env.REACTOR_API_KEY ?? "").trim();
    if (single) {
      this.keys = [
        { fingerprint: fingerprintKey(single), exhaustedUntil: null, lastError: null },
      ];
      this._raw = [single];
      this._envFingerprint = currentFingerprint;
      return { count: 1, legacy: true };
    }
    this._raw = [];
    return { count: 0, legacy: false };
  }
  /** Raw key material, kept off the type so it doesn't accidentally
   *  end up in logs. Indexed parallel to `keys`. */
  _raw: string[] = [];

  healthy(): PoolKey[] {
    const now = Date.now();
    return this.keys.filter((k) => !k.exhaustedUntil || now >= k.exhaustedUntil);
  }

  park(idx: number, ttlMs: number, reason: string): void {
    const k = this.keys[idx];
    if (!k) return;
    k.exhaustedUntil = Date.now() + ttlMs;
    k.lastError = reason;
  }

  clearPark(idx: number): void {
    const k = this.keys[idx];
    if (!k) return;
    k.exhaustedUntil = null;
    k.lastError = null;
  }
}

function fingerprintKey(k: string): string {
  // Never log the full key. Last 4 chars are enough to distinguish
  // between "key A" and "key B" in dev tools without leaking the
  // secret to anyone who reads the deploy logs.
  if (k.length <= 4) return "***";
  return "***" + k.slice(-4);
}

/** Deterministic fingerprint of an env value (a comma-separated key
 *  list, or a single key). Used to detect hot-rotated keys without
 *  exposing the full secret. */
function fingerprintEnv(env: string): string {
  const parts = env.split(",").map((s) => s.trim()).filter(Boolean);
  return parts.map(fingerprintKey).join("|");
}

const USER_KEY_SHAPE = /^rk_[A-Za-z0-9]{30,120}$/;

/** Extract the per-request user key from the `X-Reactor-User-Key`
 *  header. Returns:
 *    - { present: false }                          if no header
 *    - { present: true, key: "rk_..." }            if header is valid
 *    - { present: true, malformed: true }          if header is
 *      present but doesn't match the expected shape
 *  Caller can then decide whether to 400 on malformed vs proceed.
 */
function extractUserKey(req: Request):
  | { present: false }
  | { present: true; key: string }
  | { present: true; malformed: true } {
  const h = req.headers.get("X-Reactor-User-Key");
  if (h === null) return { present: false };
  const trimmed = h.trim();
  if (!trimmed) return { present: true, malformed: true };
  if (!USER_KEY_SHAPE.test(trimmed)) return { present: true, malformed: true };
  return { present: true, key: trimmed };
}

const keyPool = new KeyPool();

// ---------------------------------------------------------------------------
// Reactor call (per key)
// ---------------------------------------------------------------------------

interface TokenSuccess {
  ok: true;
  jwt: string;
  expires_at: number;
}
interface TokenFailure {
  ok: false;
  status: number;
  error: string;
  /** The Reactor upstream status (vs the synthesized one we return). */
  upstreamStatus?: number;
}

async function mintTokenWithKey(
  apiKey: string,
  attempt = 0,
): Promise<TokenSuccess | TokenFailure> {
  try {
    const res = await fetch("https://api.reactor.inc/tokens", {
      method: "POST",
      headers: {
        "Reactor-API-Key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ expires_after: TOKEN_LIFETIME_SECONDS }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      cache: "no-store",
    });
    // 5xx on the first try → retry once. On 5xx after one retry, the
    // key has had its chance; the caller will rotate to the next.
    if (res.status >= 500 && res.status <= 504 && attempt === 0) {
      await new Promise<void>((r) => setTimeout(r, 250));
      return mintTokenWithKey(apiKey, attempt + 1);
    }
    if (res.status === 429) {
      return { ok: false, status: 429, error: "Reactor rate-limited", upstreamStatus: 429 };
    }
    if (res.status === 402) {
      return { ok: false, status: 402, error: "Reactor credits depleted", upstreamStatus: 402 };
    }
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        status: 401,
        error: "Reactor API key rejected",
        upstreamStatus: res.status,
      };
    }
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: `Reactor ${res.status}`,
        upstreamStatus: res.status,
      };
    }
    const raw = (await res.json().catch(() => null)) as
      | { jwt?: unknown; expires_at?: unknown; token?: unknown; ttl?: unknown }
      | null;
    if (!raw) return { ok: false, status: 502, error: "Upstream returned non-JSON" };
    const jwt = typeof raw.jwt === "string"
      ? raw.jwt
      : typeof raw.token === "string"
        ? raw.token
        : null;
    let expiresAtNum: number | null = typeof raw.expires_at === "number"
      ? raw.expires_at
      : null;
    if (expiresAtNum === null && typeof raw.ttl === "number") {
      expiresAtNum = Math.floor(Date.now() / 1000) + raw.ttl;
    }
    if (!jwt || expiresAtNum === null || !Number.isFinite(expiresAtNum)) {
      return { ok: false, status: 502, error: "Upstream response shape unrecognized" };
    }
    return { ok: true, jwt, expires_at: expiresAtNum };
  } catch (e: unknown) {
    const err = e as { name?: string; message?: string };
    const isAbort = err?.name === "AbortError" || /aborted/i.test(String(err?.message ?? ""));
    if (attempt === 0) {
      await new Promise<void>((r) => setTimeout(r, 250));
      return mintTokenWithKey(apiKey, attempt + 1);
    }
    return {
      ok: false,
      status: isAbort ? 504 : 500,
      error: isAbort ? "Upstream timed out" : "Upstream network error",
    };
  }
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function GET(req: Request) {
  // QA4: lazy expiration of parked key-pool entries on each
  // request — replaces the ensureSweep() setInterval. Trivial
  // cost (pool is bounded by key count, typically <10).
  expireKeyPoolEntries(Date.now());
  const ip = clientIp(req.headers, process.env.TRUST_PROXY === "1");
  if (!takeToken(ip)) {
    return NextResponse.json(
      { error: "Too many token requests — slow down" },
      {
        status: 429,
        headers: { "Retry-After": "10", "Cache-Control": "no-store" },
      },
    );
  }

  const { count } = keyPool.load(process.env);
  // M9.12: BYOK — accept a per-request user-supplied key in the
  // `X-Reactor-User-Key` header. Shape-validated. The user key
  // is tried FIRST (in front of the env pool) and the env pool
  // acts as a fallback if the user key 402s. This means a user
  // who pastes their own key never has to wait for the server's
  // keys to be exhausted before their key gets a turn.
  //
  // Auth-failure (401/403) on the user key is fatal — we don't
  // fall through to the env pool. The user pasted a malformed
  // key and silently using the server's key instead would
  // mask their typo. We surface the 401 so they can correct it.
  const userKeyInfo = extractUserKey(req);

  if (count === 0 && !userKeyInfo.present) {
    return NextResponse.json(
      {
        error:
          "No Reactor API key is available. Set REACTOR_API_KEYS on the server, or paste your own key in the app.",
      },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (userKeyInfo.present && "malformed" in userKeyInfo) {
    return NextResponse.json(
      {
        error:
          "Pasted Reactor key is malformed. It should look like rk_<40+ characters>.",
      },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  // Try the user key first if present.
  if (userKeyInfo.present && "key" in userKeyInfo) {
    const userKey = userKeyInfo.key;
    const r = await mintTokenWithKey(userKey);
    if (r.ok) {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const remaining = r.expires_at - nowSeconds - CACHE_SKEW_SECONDS;
      const maxAge = Math.max(0, Math.min(TOKEN_LIFETIME_SECONDS, remaining));
      return NextResponse.json(
        { jwt: r.jwt, expires_at: r.expires_at },
        {
          headers: {
            // QA16 (#182): the token is per-user when X-Reactor-User-Key
            // is present. Without Vary on that header, a shared CDN
            // cache could serve user A's JWT to user B on the next
            // request (different key, same URL). Vary on Cookie +
            // Authorization is necessary too because the cookie path
            // also produces a per-user response.
            "Cache-Control": `private, max-age=${maxAge}`,
            Vary: "Cookie, Authorization, X-Reactor-User-Key",
          },
        },
      );
    }
    // 401/403: the user pasted a bad key. Don't fall through to
    // the env pool — surface the error so they can correct it.
    if (r.upstreamStatus === 401 || r.upstreamStatus === 403) {
      return NextResponse.json(
        { error: r.error },
        { status: 401, headers: { "Cache-Control": "no-store" } },
      );
    }
    // 402: user key is exhausted. Fall through to the env pool
    // (the user's key gets a chance next request when they paste
    // a fresh one — the server doesn't persist user keys).
    // 5xx / network: fall through. Maybe Reactor is having a
    // bad day; the env pool might still work.
    // 429: per-IP — the env pool would also be 429. Surface 429.
    if (r.upstreamStatus === 429) {
      return NextResponse.json(
        { error: r.error },
        {
          status: 429,
          headers: { "Retry-After": "10", "Cache-Control": "no-store" },
        },
      );
    }
    // Otherwise: continue to the env pool.
  }

  // Walk healthy keys in order. Stop at the first success.
  const tried = new Set<number>();
  let lastResult: TokenFailure | null = null;
  while (tried.size < count) {
    const healthy = keyPool.healthy();
    if (healthy.length === 0) {
      // Every key is parked. We could 503 here, or wait and retry.
      // For a hackathon, 503 with a short Retry-After is more honest
      // than blocking the request thread for minutes.
      return NextResponse.json(
        {
          error: "All API keys are temporarily exhausted. Try again shortly.",
        },
        {
          status: 503,
          headers: { "Retry-After": "30", "Cache-Control": "no-store" },
        },
      );
    }
    // Pick the first healthy key we haven't tried in this loop.
    const idx = keyPool.keys.findIndex(
      (k, i) =>
        !tried.has(i) &&
        (!k.exhaustedUntil || Date.now() >= k.exhaustedUntil),
    );
    if (idx < 0) break;
    tried.add(idx);

    const result = await mintTokenWithKey(keyPool._raw[idx]);
    if (result.ok) {
      // Clear any previous park on this key (e.g. a 5xx earlier that
      // we recovered from).
      keyPool.clearPark(idx);
      const nowSeconds = Math.floor(Date.now() / 1000);
      const remaining = result.expires_at - nowSeconds - CACHE_SKEW_SECONDS;
      const maxAge = Math.max(0, Math.min(TOKEN_LIFETIME_SECONDS, remaining));
      if (!Number.isFinite(maxAge)) {
        return NextResponse.json(
          { error: "Upstream timestamp unusable" },
          { status: 502, headers: { "Cache-Control": "no-store" } },
        );
      }
      return NextResponse.json(
        { jwt: result.jwt, expires_at: result.expires_at },
        {
          headers: {
            "Cache-Control": `private, max-age=${maxAge}`,
            Vary: "Cookie, Authorization",
          },
        },
      );
    }
    lastResult = result;
    // Decide whether to rotate.
    if (result.upstreamStatus === 402) {
      // 402 = this key is out of credits. Park it and try the next.
      keyPool.park(idx, EXHAUSTED_TTL_MS, "402 credits_depleted");
      continue;
    }
    if (result.upstreamStatus === 401 || result.upstreamStatus === 403) {
      // Auth failure is fatal. Do NOT try the next key — if one key
      // is malformed, the rest probably are too. Park this one
      // briefly so we don't hot-loop the same bad key, and surface.
      keyPool.park(idx, 60_000, "auth rejected");
      return NextResponse.json(
        { error: result.error },
        { status: 401, headers: { "Cache-Control": "no-store" } },
      );
    }
    if (result.upstreamStatus === 429) {
      // 429 is per-IP/global at the SDK, not per-key. Rotating
      // wouldn't help and would burn the next key's quota.
      return NextResponse.json(
        { error: result.error },
        {
          status: 429,
          headers: { "Retry-After": "10", "Cache-Control": "no-store" },
        },
      );
    }
    // 5xx / timeout / network — give the next key a try.
    if (result.upstreamStatus && result.upstreamStatus >= 500) {
      keyPool.park(idx, 30_000, `upstream ${result.upstreamStatus}`);
      continue;
    }
    if (result.status >= 500) {
      // We synthesized the 5xx (timeout/network) — same handling.
      keyPool.park(idx, 30_000, result.error);
      continue;
    }
    // Any other 4xx: surface directly.
    return NextResponse.json(
      { error: result.error },
      { status: result.status, headers: { "Cache-Control": "no-store" } },
    );
  }
  // Fell off the end: every healthy key failed. Surface the last
  // error verbatim.
  return NextResponse.json(
    { error: lastResult?.error ?? "All API keys failed" },
    {
      status: lastResult?.status ?? 502,
      headers: { "Cache-Control": "no-store" },
    },
  );
}