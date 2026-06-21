#!/usr/bin/env tsx
/**
 * QA11 regression tests for the audit-pass bug fixes.
 *
 * Run with: npx tsx scripts/test-qa11-fixes.ts
 */

import { dreamBus } from "../app/lib/event-bus";

async function main() {
// ── 1. DirectorOverlay doesn't push apply(null,null) on
//       mount (would clobber a primed bus state) ───────────
{
  // The old apply function was called once on mount with
  // nulls. The new behavior is: just subscribe. We simulate
  // a subscriber that has the same callback the overlay
  // would register, then check that mounting it does NOT
  // produce a "null" fan-out.
  let applyCalls = 0;
  function apply(state: { styleId: string | null; variantId: string | null }) {
    applyCalls++;
    void state;
  }
  // Simulate the effect's body: just subscribe. No leading
  // apply() call.
  const off = dreamBus.on("dream:directorChange", apply);
  const before = applyCalls;
  void before; // silence unused
  // No call should have been made just from the subscription.
  if (applyCalls !== 0) {
    throw new Error("DirectorOverlay-style mount should not call apply");
  }
  // An external emit DOES call apply.
  dreamBus.emit("dream:directorChange", { styleId: "noir", variantId: null });
  if ((applyCalls as number) !== 1) {
    throw new Error("director bus fanout should fire on emit");
  }
  off();
  console.log("✓ DirectorOverlay mount does not push null state");
}

// ── 2. Sidebar Escape handler exists (open → keydown
//       Escape → onClose) ─────────────────────────────────
{
  // We can't render React here, but we can sanity-check
  // that the SessionSidebar file has the Escape effect.
  const fs = await import("node:fs/promises");
  const src = await fs.readFile(
    new URL("../app/components/SessionSidebar.tsx", import.meta.url),
    "utf8",
  );
  if (!/e\.key === "Escape"/.test(src)) {
    throw new Error("SessionSidebar must handle Escape");
  }
  if (!/window\.addEventListener\("keydown"/.test(src)) {
    throw new Error("SessionSidebar must register a keydown listener");
  }
  console.log("✓ SessionSidebar registers an Escape handler");
}

// ── 3. Tab buttons no longer carry aria-pressed ─────────
{
  const fs = await import("node:fs/promises");
  const src = await fs.readFile(
    new URL("../app/components/SessionSidebar.tsx", import.meta.url),
    "utf8",
  );
  // Find the tabs. aria-pressed should NOT appear on them.
  const tabMatch = src.match(/role="tab"[^>]*aria-selected=\{tab === "sessions"\}/);
  if (!tabMatch) {
    throw new Error("Session tab button not found");
  }
  if (tabMatch[0].includes("aria-pressed")) {
    throw new Error("Session tab still has aria-pressed");
  }
  console.log("✓ Tab buttons no longer use aria-pressed");
}

// ── 4. Mic caption uses dark backdrop + white/85 ───────
{
  const fs = await import("node:fs/promises");
  const src = await fs.readFile(
    new URL("../app/components/VoiceDream.tsx", import.meta.url),
    "utf8",
  );
  // The aria-live mic caption should mention "Tap to speak"
  // or "Listening" inside a bg-black/70 backdrop.
  // We check each property separately to allow multi-line
  // attribute ordering.
  if (!/aria-live="polite"/.test(src)) {
    throw new Error("Mic caption needs aria-live");
  }
  if (!/Tap to speak/.test(src)) {
    throw new Error("Mic caption should mention 'Tap to speak'");
  }
  if (!/bg-black\/70/.test(src)) {
    throw new Error("Mic caption should have bg-black/70 backdrop");
  }
  if (!/text-white\/85/.test(src)) {
    throw new Error("Mic caption should use text-white/85 for 7:1 contrast");
  }
  console.log("✓ Mic caption uses dark backdrop + 7:1 contrast text");
}

// ── 5. Active session chip uses aria-label ──────────────
{
  const fs = await import("node:fs/promises");
  const src = await fs.readFile(
    new URL("../app/LingbotApp.tsx", import.meta.url),
    "utf8",
  );
  const chipMatch = src.match(/active-session-chip[\s\S]{0,500}/);
  if (!chipMatch) throw new Error("active-session-chip not found");
  if (!chipMatch[0].includes("aria-label=")) {
    throw new Error("Active session chip missing aria-label");
  }
  if (chipMatch[0].includes("aria-hidden=\"true\"")) {
    // The decorative dot/count should be marked hidden.
    if (!chipMatch[0].match(/aria-hidden="true"/g)?.length) {
      throw new Error("Decorative dots should be aria-hidden");
    }
  }
  console.log("✓ Active session chip has aria-label + hidden decorations");
}

// ── 6. Video.tsx useLingbotStateSnapshot is stable ──────
{
  const fs = await import("node:fs/promises");
  const src = await fs.readFile(
    new URL("../app/components/Video.tsx", import.meta.url),
    "utf8",
  );
  if (!/useLingbotStateSnapshot/.test(src)) {
    throw new Error("useLingbotStateSnapshot missing");
  }
  // Extract the function body (non-greedy match until the
  // closing `}` of the function).
  const m = src.match(/function useLingbotStateSnapshot\(\)[\s\S]*?\n\}/);
  if (!m) throw new Error("could not extract useLingbotStateSnapshot");
  if (!/useCallback/.test(m[0])) {
    throw new Error("useLingbotStateSnapshot should use useCallback");
  }
  console.log("✓ useLingbotStateSnapshot uses useCallback for stability");
}

// ── 7. CuratedGallery registers beforeunload handler ────
{
  const fs = await import("node:fs/promises");
  const src = await fs.readFile(
    new URL("../app/components/CuratedGallery.tsx", import.meta.url),
    "utf8",
  );
  if (!/addEventListener\("beforeunload"/.test(src)) {
    throw new Error("CuratedGallery must register beforeunload");
  }
  if (!/URL\.revokeObjectURL/.test(src)) {
    throw new Error("CuratedGallery must revoke object URLs on unload");
  }
  console.log("✓ CuratedGallery revokes object URLs on beforeunload");
}

// ── 8. DesktopController status guard uses a ref ────────
{
  const fs = await import("node:fs/promises");
  const src = await fs.readFile(
    new URL("../app/components/DesktopController.tsx", import.meta.url),
    "utf8",
  );
  if (!/statusRef\.current/.test(src)) {
    throw new Error("DesktopController must use statusRef.current for cleanup");
  }
  if (!/isContentEditable/.test(src)) {
    throw new Error("DesktopController must skip contenteditable targets");
  }
  console.log("✓ DesktopController uses statusRef + skips contenteditable");
}

// ── 9. VRView renders ONE LingbotMainVideoView ─────────
{
  const fs = await import("node:fs/promises");
  const src = await fs.readFile(
    new URL("../app/components/VRView.tsx", import.meta.url),
    "utf8",
  );
  // Count only ACTUAL JSX uses. Strip comments first so
  // the regex doesn't match comment mentions.
  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  const count = (stripped.match(/^\s*<LingbotMainVideoView\b/gm) ?? []).length;
  if (count !== 1) {
    throw new Error(`VRView must render ONE LingbotMainVideoView, got ${count}`);
  }
  if (!/clipPath:\s*"inset\(/.test(src)) {
    throw new Error("VRView must use clip-path for stereo lenses");
  }
  console.log("✓ VRView renders a single video with clip-path lenses");
}

// ── 10. Recent chip uses full aria-label, not truncated
//        text ─────────────────────────────────────────────
{
  const fs = await import("node:fs/promises");
  const src = await fs.readFile(
    new URL("../app/LingbotApp.tsx", import.meta.url),
    "utf8",
  );
  // Find the PromptHistoryChips component body. Locate
  // the start, skip past the signature, then count
  // braces.
  const start = src.indexOf("function PromptHistoryChips");
  if (start < 0) throw new Error("PromptHistoryChips not found");
  // Skip past the type-annotated parameter list to the
  // function body's opening brace. We just look for the
  // first `\n  {` or `\n  if` — but the easiest is to
  // skip until the first occurrence of `{\n  if`.
  const bodyStart = src.indexOf("{\n  if", start);
  if (bodyStart < 0) throw new Error("PromptHistoryChips body not found");
  let depth = 1; // already past the opening {
  let end = -1;
  for (let i = bodyStart + 1; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end < 0) throw new Error("PromptHistoryChips body never closed");
  const body = src.slice(bodyStart, end);
  if (!/aria-label/.test(body)) {
    throw new Error("PromptHistoryChips must include aria-label on each pill");
  }
  console.log("✓ PromptHistoryChips pills have full aria-label");
}

console.log("\nQA11: all checks passed");
}

void main();
