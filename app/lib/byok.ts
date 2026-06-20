// BYOK — "Bring Your Own Key" storage for the user's Reactor API
// key, pasted directly in the UI rather than configured via a
// server env var.
//
// Why this exists: the M9.7 key pool only has access to keys the
// host deploys the app with. If the host's pool is exhausted (or
// the user is running a local clone without a deploy), there's no
// path to a working session. BYOK closes that gap — the user can
// paste their own Reactor key in the Begin overlay (or the 402
// error screen) and the server token route uses that key in
// addition to (and in front of) the env pool.
//
// Storage: the key is stored in localStorage as a plain string.
// The same client is the only one that ever holds this key, and
// the server only ever sees it as a request header. There is no
// in-memory or persistent store on the server that would survive
// a restart. This is appropriate for a hackathon demo where the
// user is the only operator of their device.
//
// Validation: the key is shape-checked (starts with "rk_", length
// in the expected range) before being accepted. Reactor's actual
// auth check happens at the server when the key is forwarded; this
// is just a friendly check that the user didn't paste garbage.

const STORAGE_KEY = "dream.byok.reactorKey";
const SHAPE = /^rk_[A-Za-z0-9]{30,120}$/;

export interface ByokState {
  /** Masked fingerprint of the saved key (last 4 chars). null if none. */
  fingerprint: string | null;
  /** The full key, only available in-memory. null if not loaded. */
  raw: string | null;
}

function fingerprint(k: string): string {
  if (k.length <= 4) return "***";
  return "***" + k.slice(-4);
}

function isValidShape(k: string): boolean {
  return typeof k === "string" && SHAPE.test(k.trim());
}

/** Load the saved user key from localStorage. Returns the raw key
 *  if present and shape-valid, otherwise null. */
export function loadUserKey(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    if (!v) return null;
    if (!isValidShape(v)) {
      // Garbled in storage — clean it out so the UI doesn't show
      // a stale fingerprint for a key that won't work.
      window.localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return v;
  } catch {
    return null;
  }
}

/** Read just the fingerprint (for the UI to show "using ***1234"
 *  without exposing the full key). */
export function getFingerprint(): string | null {
  const k = loadUserKey();
  return k ? fingerprint(k) : null;
}

/** Save a new user key. Returns true on success, false on
 *  shape-mismatch (the caller should show a friendly error). */
export function saveUserKey(input: string): boolean {
  if (typeof window === "undefined") return false;
  const k = (input ?? "").trim();
  if (!isValidShape(k)) return false;
  try {
    window.localStorage.setItem(STORAGE_KEY, k);
    return true;
  } catch {
    return false;
  }
}

/** Forget the user key. */
export function clearUserKey(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

export { fingerprint as _fingerprintForTest, isValidShape as _isValidShapeForTest };
