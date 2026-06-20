// One-shot flag: when set, the next call to fetchToken will bypass
// the browser HTTP cache (Cache-Control: private, max-age=...) and
// hit /api/reactor/token with a fresh upstream call. After that
// call, the flag auto-clears so the next call returns to the
// normal cache path.
//
// This is wired into the 402 credits_depleted recovery flow: when
// the SDK reports a depleted key mid-session, the React side sets
// this flag before calling `connect()` again, so the Lingbot SDK
// sees a fresh JWT minted from the next healthy fallback key (see
// app/api/reactor/token/route.ts M9.7 pool logic). Without this
// bypass, the SDK would happily reuse the cached 6-hour JWT for
// the now-exhausted key and the user would be stuck in the
// 402-error loop.

let pending = false;

export function bustNextToken(): void {
  pending = true;
}

export function consumeBust(): boolean {
  if (!pending) return false;
  pending = false;
  return true;
}