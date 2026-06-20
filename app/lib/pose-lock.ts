"use client";

// Pose Lock — capture the current world frame and use it as the next
// paint's anchor image instead of a procedural noise gradient. Lets
// the user freeze a moment and evolve the world from there rather
// than resetting to a blank canvas each prompt.
//
// The capture path:
//   1. Find the active <LingbotMainVideoView> rendered <video>.
//   2. Draw it onto an offscreen canvas at the SDK's expected
//      seed-image dimensions.
//   3. Encode to PNG via OffscreenCanvas.convertToBlob (or
//      canvas.toBlob on the regular path).
//   4. Return the Blob, ready for `uploadFile` + `setImage`.
//
// Returns null if no <video> is visible yet (user hasn't connected
// or hasn't waited for the first frame).

import { SEED_IMAGE_HEIGHT, SEED_IMAGE_WIDTH } from "./seed-image";

/**
 * Look up the <video> element rendered by LingbotMainVideoView.
 * We try a few selectors because the SDK's component is opaque.
 */
function findVideo(): HTMLVideoElement | null {
  if (typeof document === "undefined") return null;
  // The SDK's main video view sits inside a container that has
  // data-testid="video-stage" (added by app/components/Video.tsx).
  const stage = document.querySelector('[data-testid="video-stage"] video');
  if (stage instanceof HTMLVideoElement) return stage;
  // Fallback: any <video> with width > 0 in the page.
  const videos = document.querySelectorAll("video");
  for (const v of Array.from(videos)) {
    if (v.videoWidth > 0 && v.videoHeight > 0) return v;
  }
  return null;
}

export async function captureCurrentFrame(): Promise<Blob | null> {
  const v = findVideo();
  if (!v || v.videoWidth === 0 || v.videoHeight === 0) return null;
  // Some browsers require the video to be playing/ready before we
  // can draw its frame. Bail if not ready — the caller can retry.
  if (v.readyState < 2) return null;
  const w = SEED_IMAGE_WIDTH;
  const h = SEED_IMAGE_HEIGHT;
  let blob: Blob | null = null;
  if (typeof OffscreenCanvas !== "undefined") {
    const off = new OffscreenCanvas(w, h);
    const ctx = off.getContext("2d");
    if (!ctx) return null;
    // Cover-fit: scale to fill the seed frame, cropping as needed.
    const vr = v.videoWidth / v.videoHeight;
    const tr = w / h;
    let sx = 0,
      sy = 0,
      sw = v.videoWidth,
      sh = v.videoHeight;
    if (vr > tr) {
      // source is wider than target — crop horizontally
      sw = v.videoHeight * tr;
      sx = (v.videoWidth - sw) / 2;
    } else {
      sh = v.videoWidth / tr;
      sy = (v.videoHeight - sh) / 2;
    }
    ctx.drawImage(v, sx, sy, sw, sh, 0, 0, w, h);
    try {
      blob = await off.convertToBlob({ type: "image/png" });
    } catch {
      blob = null;
    }
  } else {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d");
    if (!ctx) return null;
    const vr = v.videoWidth / v.videoHeight;
    const tr = w / h;
    let sx = 0,
      sy = 0,
      sw = v.videoWidth,
      sh = v.videoHeight;
    if (vr > tr) {
      sw = v.videoHeight * tr;
      sx = (v.videoWidth - sw) / 2;
    } else {
      sh = v.videoWidth / tr;
      sy = (v.videoHeight - sh) / 2;
    }
    ctx.drawImage(v, sx, sy, sw, sh, 0, 0, w, h);
    blob = await new Promise<Blob | null>((resolve) =>
      c.toBlob((b) => resolve(b), "image/png"),
    );
  }
  return blob;
}
