import { NextResponse } from "next/server";

// Hardening audit (June 2026):
//   - AbortSignal.timeout on the upstream Reactor fetch so a hung
//     Reactor doesn't pin a Node worker for 30+ s.
//   - One retry on transient 5xx (502/503/504).
//   - Shape validation on the upstream response so a future Reactor
//     contract change can't silently produce `Cache-Control: max-age=NaN`.
//   - Defensive Vary header (kept the existing `private` directive).
//   - Per-IP rate limiting using a tiny in-memory token bucket — not
//     perfect but it blunts the "anonymous bot mints until the bill
//     is non-trivial" attack surface. Sufficient for hackathon scale.

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
// fall through to retry. Total worst-case is ~16 s for the user.
const UPSTREAM_TIMEOUT_MS = 8000;

// Per-IP token bucket: each bucket refills at 1 token / 10 s with a
// burst capacity of 5. A single user re-loading the page 5 times in a
// row succeeds; anything more gets a 429 until the bucket refills.
const RATE_LIMIT_BURST = 5;
const RATE_LIMIT_REFILL_MS = 10_000;
const buckets = new Map<string, { tokens: number; updatedAt: number }>();

function takeToken(ip: string): boolean {
  const now = Date.now();
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

function clientIp(headers: Headers): string {
  return (
    headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    headers.get("x-real-ip") ||
    "unknown"
  );
}

interface TokenSuccess {
  ok: true;
  jwt: string;
  expires_at: number;
}
interface TokenFailure {
  ok: false;
  status: number;
  error: string;
}

async function mintToken(apiKey: string): Promise<TokenSuccess | TokenFailure> {
  let lastErr: { status: number; error: string } | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
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
      if (res.status >= 500 && res.status <= 504 && attempt === 0) {
        // Transient — backoff briefly and retry once.
        lastErr = { status: res.status, error: `Reactor ${res.status}` };
        await new Promise<void>((r) => setTimeout(r, 250));
        continue;
      }
      if (!res.ok) {
        return { ok: false, status: res.status, error: "Upstream authentication service unavailable" };
      }
      const raw = (await res.json().catch(() => null)) as
        | { jwt?: unknown; expires_at?: unknown; token?: unknown; ttl?: unknown }
        | null;
      if (!raw) return { ok: false, status: 502, error: "Upstream returned non-JSON" };
      // Accept either {jwt, expires_at} or {token, ttl-seconds} for
      // forward-compat with future Reactor response shapes.
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
    } catch (e: any) {
      const isAbort = e?.name === "AbortError" || /aborted/i.test(String(e?.message ?? ""));
      lastErr = {
        status: isAbort ? 504 : 500,
        error: isAbort ? "Upstream timed out" : "Upstream network error",
      };
      if (attempt === 1) break;
      await new Promise<void>((r) => setTimeout(r, 250));
    }
  }
  return { ok: false, status: lastErr?.status ?? 500, error: lastErr?.error ?? "Unknown error" };
}

// Mint a Reactor JWT and return it with a `Cache-Control` header
// that lets the browser reuse it for the rest of its lifetime.
//
// Why GET and not POST?
//   POST responses are not cached by browsers. We expose this route
//   as GET so the browser's HTTP cache can serve repeat calls
//   transparently — no localStorage, no JWT parsing in client code.
//   The route handler still POSTs to Reactor internally.
//
// Why `private`?
//   Tells shared caches (CDNs, corporate proxies) not to store the
//   response. JWTs are per-user and must never be reused across users.
//
// Why derive `max-age` from `expires_at`?
//   Reactor decides the actual token lifetime (it caps the request
//   at its server max). Reading `expires_at` off the response means
//   the cache window is always in sync with whatever the server
//   actually granted, with a one-minute safety skew baked in.
export async function GET(req: Request) {
  const ip = clientIp(req.headers);
  if (!takeToken(ip)) {
    return NextResponse.json(
      { error: "Too many token requests — slow down" },
      {
        status: 429,
        headers: {
          "Retry-After": "10",
          "Cache-Control": "no-store",
        },
      },
    );
  }

  const apiKey = process.env.REACTOR_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "REACTOR_API_KEY is not set on the server" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }

  const result = await mintToken(apiKey);
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error },
      {
        status: result.status,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const remaining = result.expires_at - nowSeconds - CACHE_SKEW_SECONDS;
  // Clamp to [0, TOKEN_LIFETIME_SECONDS] so a bogus upstream timestamp
  // (e.g. year 9999) can't trick the browser into caching forever.
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
        "Vary": "Cookie, Authorization",
      },
    },
  );
}
