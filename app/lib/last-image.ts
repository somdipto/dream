// Tiny in-memory buffer for the most-recent image URL the SDK has
// delivered. Set by Video.tsx on every snapshot; read by
// SessionSidebar.tsx when the user clicks "Download as PNG" on a
// scene.
//
// Lives outside React so a download triggered from a stale closure
// (e.g. a long-running async downloadScenePng) still sees the
// freshest frame.
//
// Extracted from SessionSidebar.tsx in QA6 — was previously
// re-exported from there, which produced a circular import
// (Video imported it; SessionSidebar imported React from inside
// itself; on Vite the runtime value came back undefined).
//
// QA16: setLastImageUrl now rejects any URL that isn't an
// `https://` CDN URL or a `blob:` URL. Reactor URLs come from
// `cdn.reactor.inc` (HTTPS). Blob URLs come from the SDK or
// from the in-app seed-image generator. Anything else —
// `javascript:`, `data:`, `vbscript:`, `file:`, etc. — is
// refused at the boundary so a poisoned SDK response or a
// stale closure passing the wrong string can't be used as
// an `<a href>` later (which would be XSS).
let lastImageUrl: string | null = null;

function isAllowedImageUrl(url: unknown): url is string {
  if (typeof url !== "string" || url.length === 0) return false;
  if (url.startsWith("blob:")) return true;
  if (url.startsWith("https://cdn.reactor.inc")) return true;
  // Other HTTPS URLs are technically possible (custom proxy),
  // but we don't currently have any. Tightening the allow-list
  // is intentional — a future caller can relax it deliberately.
  return false;
}

export function setLastImageUrl(url: string | null): void {
  if (url === null) {
    lastImageUrl = null;
    return;
  }
  if (!isAllowedImageUrl(url)) {
    // Silently drop — we never want a poisoned URL to land in
    // the download href. The user will see a "no image yet"
    // state, which is the correct fallback.
    return;
  }
  lastImageUrl = url;
}

export function readLastImageUrl(): string | undefined {
  return lastImageUrl ?? undefined;
}
