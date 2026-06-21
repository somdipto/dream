// Persisted flag: "this device has hit a credits_depleted error
// at least once." When true, the Begin overlay's BYOK paste field
// auto-opens so the user lands on a working paste box, not a
// tiny "BYOK" link they have to find. Cleared when the user
// successfully saves a new key.

const SAW_DEPLETED_KEY = "dream.byok.sawDepleted.v1";
const PROBED_KEY = "dream.byok.envProbe.v1";
const PROBE_TTL_MS = 30 * 60 * 1000; // 30 min

export function markSawCreditsDepleted(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SAW_DEPLETED_KEY, "1");
  } catch {
    // localStorage may be unavailable in private mode; ignore.
  }
}

export function consumeSawCreditsDepleted(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const v = window.localStorage.getItem(SAW_DEPLETED_KEY);
    if (v !== "1") return false;
    window.localStorage.removeItem(SAW_DEPLETED_KEY);
    return true;
  } catch {
    return false;
  }
}

export function peekSawCreditsDepleted(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(SAW_DEPLETED_KEY) === "1";
  } catch {
    return false;
  }
}

/** Cached result of an env-key probe. "ok" means the env pool
 *  has at least one usable key, "empty" means the server returned
 *  500 with "no api key" / "set REACTOR_API_KEYS", and "unknown"
 *  means we haven't probed yet. */
export type EnvProbeResult = "ok" | "empty" | "unknown";

export function readCachedEnvProbe(): EnvProbeResult {
  if (typeof window === "undefined") return "unknown";
  try {
    const raw = window.localStorage.getItem(PROBED_KEY);
    if (!raw) return "unknown";
    const parsed = JSON.parse(raw) as { result: EnvProbeResult; at: number };
    if (Date.now() - parsed.at > PROBE_TTL_MS) return "unknown";
    return parsed.result;
  } catch {
    return "unknown";
  }
}

export function writeCachedEnvProbe(result: Exclude<EnvProbeResult, "unknown">): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      PROBED_KEY,
      JSON.stringify({ result, at: Date.now() }),
    );
  } catch {
    // ignore
  }
}

/** Probe the server once to learn whether an env key is configured.
 *  Fires a HEAD-equivalent: a no-user-key token request. The route
 *  returns 500 with "no api key" if the env pool is empty, or a
 *  valid token (which we discard) otherwise. */
export async function probeEnvPool(): Promise<Exclude<EnvProbeResult, "unknown">> {
  try {
    const r = await fetch("/api/reactor/token", { cache: "no-store" });
    if (r.status === 200) {
      writeCachedEnvProbe("ok");
      return "ok";
    }
    let body = "";
    try {
      body = await r.text();
    } catch {
      // ignore
    }
    if (r.status === 500 && /no api key|no reactor api key/i.test(body)) {
      writeCachedEnvProbe("empty");
      return "empty";
    }
    // Any other status: we have *some* key, just not necessarily
    // one with credits. Treat as "ok" so we don't pester the user
    // to paste a key they may not have.
    writeCachedEnvProbe("ok");
    return "ok";
  } catch {
    return "ok";
  }
}
