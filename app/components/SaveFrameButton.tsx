"use client";

// F11: Save Frame — captures the current video frame from the Lingbot
// SDK and downloads it as a PNG. Sits in the topbar so it's reachable
// from anywhere in the live world. Disabled until the SDK reports a
// live snapshot, so a fresh-load tap can't write a black PNG.
//
// Why this exists:
//   - Dream is a "prompt to world" playground. The whole point of
//     painting is to share or keep the result. Before this, the
//     only way to keep a frame was to fork the session, open the
//     sidebar, and click download on a specific scene. The sidebar
//     download uses the scene's stored prompt+seed and replays the
//     anchor image — it does NOT capture what the user is currently
//     looking at. This button captures the *current* canvas, which
//     is the only thing that matches the user's actual experience.
//
// Behavior:
//   1. Capture the canvas → Blob (or null on failure).
//   2. Compose a filename from the current scene's prompt + seed.
//   3. Trigger a click on a hidden <a download> link with a fresh
//      blob: URL.
//   4. Revoke the URL after 1s.
//   5. Surface success/failure via dream:toast (the existing
//      ToastCenter listens).

import { useCallback, useState } from "react";
import { captureCurrentFrame } from "../lib/pose-lock";
import { dreamBus } from "../lib/event-bus";
import { useSessions } from "./SessionProvider";

interface SaveFrameButtonProps {
  /** True if the SDK has delivered at least one snapshot. Used to
   *  dim the button before the first frame. Defaults to true. */
  hasLiveFrame?: boolean;
}

function safeFilename(prompt: string, seed: number): string {
  const base = prompt
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .slice(0, 40)
    .replace(/^_+|_+$/g, "");
  const stem = base || "dream";
  return `${stem}-${seed.toString(16)}.png`;
}

export function SaveFrameButton({ hasLiveFrame = true }: SaveFrameButtonProps) {
  const sessions = useSessions();
  const [busy, setBusy] = useState(false);
  const handleClick = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const blob = await captureCurrentFrame();
      if (!blob) {
        dreamBus.emit("dream:toast", {
          kind: "error",
          message: "No live frame to save yet — paint a scene first",
          ttlMs: 3500,
        });
        return;
      }
      const active = sessions.activeSession;
      const lastScene = active?.scenes[active.scenes.length - 1];
      // If we have a journal entry, name the file from it. Otherwise
      // use a generic timestamped name. Without this, every save
      // would be "untitled-0.png" and overwrites the previous one
      // in the user's Downloads folder.
      const filename = lastScene
        ? safeFilename(lastScene.prompt, lastScene.seed)
        : `dream-${Date.now()}.png`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      // Some browsers ignore programmatic downloads on detached
      // anchors — keep it attached to body until click.
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      dreamBus.emit("dream:toast", {
        kind: "success",
        message: `Saved ${filename}`,
        ttlMs: 2500,
      });
    } catch (err) {
      dreamBus.emit("dream:toast", {
        kind: "error",
        message: `Save failed: ${(err as Error)?.message ?? "unknown error"}`,
        ttlMs: 4000,
      });
    } finally {
      setBusy(false);
    }
  }, [busy, sessions.activeSession]);

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={!hasLiveFrame || busy}
      aria-label="Save the current world frame as a PNG"
      title="Save frame"
      data-testid="save-frame-btn"
      data-busy={busy ? "true" : "false"}
      className="grid h-12 w-12 place-items-center rounded-full border border-white/10 bg-black/40 text-white/80 backdrop-blur transition hover:bg-black/60 disabled:opacity-30 active:scale-95 sm:h-10 sm:w-10"
    >
      {/* Subtle distinction from the share button (🔗) so users
          don't confuse "save to my device" with "copy share link". */}
      {busy ? "…" : "⤓"}
    </button>
  );
}
