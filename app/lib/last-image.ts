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
let lastImageUrl: string | null = null;

export function setLastImageUrl(url: string | null): void {
  lastImageUrl = url;
}

export function readLastImageUrl(): string | undefined {
  return lastImageUrl ?? undefined;
}
