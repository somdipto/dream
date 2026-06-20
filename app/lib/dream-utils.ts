// Shared utilities for the Dream app: deterministic seed derivation
// and URL-based dream sharing.
//
// `hashSeed` is intentionally a small FNV-1a variant — we don't need
// cryptographic strength, just a stable 32-bit function so that two
// sessions asking for "a misty pine forest" with the same sessionNonce
// land on the same anchor frame.
//
// `encodeDream` / `decodeDream` pack a prompt + seed into a URL-safe
// base64 string so a friend can paste `?d=...` and walk into the
// same dream. Encoding is UTF-8 safe (uses TextEncoder → Uint8Array →
// base64) so emoji, accented characters, and CJK prompts all round-trip.

export function hashSeed(input: string): number {
  // FNV-1a 32-bit
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// Convert a Uint8Array to a base64-url-safe string. Works on the
// full 0-255 byte range, so emoji and CJK characters round-trip.
function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(payload: string): Uint8Array {
  const b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Encode a prompt + seed into a URL-safe base64 payload. */
export function encodeDream(prompt: string, seed: number): string {
  if (typeof window === "undefined") return "";
  // Cap prompt length to keep share URLs manageable.
  const safePrompt = (prompt ?? "").slice(0, 500);
  const json = JSON.stringify({ p: safePrompt, s: (seed >>> 0) });
  return bytesToBase64Url(new TextEncoder().encode(json));
}

/** Decode a payload produced by `encodeDream`. Returns null on parse fail. */
export function decodeDream(payload: string): { prompt: string; seed: number } | null {
  if (!payload || payload.length > 4096) return null;
  try {
    const bytes = base64UrlToBytes(payload);
    const json = new TextDecoder().decode(bytes);
    const obj = JSON.parse(json) as { p?: unknown; s?: unknown };
    if (typeof obj.p !== "string" || typeof obj.s !== "number") return null;
    return { prompt: obj.p.slice(0, 500), seed: obj.s >>> 0 };
  } catch {
    return null;
  }
}

/** Build a full shareable URL for the current dream. */
export function buildShareUrl(prompt: string, seed: number): string {
  if (typeof window === "undefined") return "";
  const payload = encodeDream(prompt, seed);
  if (!payload) return "";
  const url = new URL(window.location.href);
  // Preserve any unrelated params (utm, cohort, etc.) — only replace `d`.
  url.searchParams.set("d", payload);
  return url.toString();
}

/** Read a ?d= payload from the current URL. Returns null on miss/bad. */
export function readDreamFromUrl(): { prompt: string; seed: number } | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  const d = params.get("d");
  if (!d) return null;
  return decodeDream(d);
}

/** Strip the ?d= param from the URL (call after consuming). */
export function clearDreamFromUrl(): void {
  if (typeof window === "undefined") return;
  if (!window.location.search.includes("d=")) return;
  const url = new URL(window.location.href);
  url.searchParams.delete("d");
  window.history.replaceState({}, "", url.toString());
}
