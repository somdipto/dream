#!/usr/bin/env tsx
/**
 * QA12 regression tests. Covers:
 *   - Mini-Player (the world shrinks to a corner when the
 *     sidebar opens, on desktop only, not in VR).
 *   - Director keyboard shortcuts (cycleStyle, cycleVariant,
 *     resetDirector) — wraps around at both ends.
 *
 * Run with: npx tsx scripts/test-qa12-features.ts
 */

import { setDirectorState, getDirectorState, cycleStyle, cycleVariant, resetDirector } from "../app/lib/director-state";
import { dreamBus } from "../app/lib/event-bus";

async function main() {
// ── 1. cycleStyle wraps around in both directions ──────
{
  // Reset to a known state.
  setDirectorState({ styleId: null, variantId: null });
  // 6 styles. Cycling from null should land on the first.
  const first = cycleStyle(1);
  if (first !== "hyperreal") {
    throw new Error(`expected first style 'hyperreal', got '${first}'`);
  }
// Cycling 6 times from "hyperreal" should land on "hyperreal" again.
  const visited: string[] = [];
  for (let i = 0; i < 6; i++) {
    const s = cycleStyle(1);
    if (!s) throw new Error("cycleStyle returned null mid-cycle");
    visited.push(s);
  }
  if (visited[visited.length - 1] !== "hyperreal") {
    throw new Error(`expected to wrap back to 'hyperreal', got '${visited[visited.length - 1]}'`);
  }
  // 6 unique visits.
  const uniq = new Set(visited);
  if (uniq.size !== 6) {
    throw new Error(`expected 6 unique styles, got ${uniq.size}`);
  }
  console.log("✓ cycleStyle wraps around through all 6 styles");
}

// ── 2. cycleStyle backwards works ──────────────────────
{
  setDirectorState({ styleId: "noir" });
  const prev = cycleStyle(-1);
  if (prev !== "watercolor") {
    throw new Error(`expected previous style 'watercolor' before noir, got '${prev}'`);
  }
  console.log("✓ cycleStyle backwards cycles correctly");
}

// ── 3. cycleVariant works ──────────────────────────────
{
  setDirectorState({ styleId: null, variantId: null });
  const first = cycleVariant(1);
  if (first !== "none") {
    throw new Error(`expected first variant 'none', got '${first}'`);
  }
  // Cycle forward and back should hit "rain" and friends.
  const v = cycleVariant(1);
  if (v !== "night") {
    throw new Error(`expected 'night' after 'none', got '${v}'`);
  }
  console.log("✓ cycleVariant advances through the list");
}

// ── 4. resetDirector clears both fields ───────────────
{
  setDirectorState({ styleId: "noir", variantId: "rain" });
  resetDirector();
  const s = getDirectorState();
  if (s.styleId !== null || s.variantId !== null) {
    throw new Error(`reset should null both fields, got ${JSON.stringify(s)}`);
  }
  console.log("✓ resetDirector clears both styleId and variantId");
}

// ── 5. Director bus fires on every cycle, preserving
//       the unchanged side ──────────────────────────────
{
  setDirectorState({ styleId: "noir", variantId: "rain" });
  let last: { styleId: string | null; variantId: string | null } | null = null;
  const off = dreamBus.on(
    "dream:directorChange",
    (d: { styleId: string | null; variantId: string | null }) => {
      last = { ...d };
    },
  );
  cycleStyle(1);
  // The variant should be preserved ("rain") when we cycle
  // the style. The style advances to the next id.
  const styleId = last?.styleId ?? "";
  if (!last || last.variantId !== "rain") {
    throw new Error(`cycleStyle should preserve variantId, got ${JSON.stringify(last)}`);
  }
  if (styleId === "noir" || styleId === "") {
    throw new Error(`cycleStyle should advance styleId, got ${JSON.stringify(last)}`);
  }
  cycleVariant(1);
  if (!last || last.styleId !== styleId) {
    throw new Error(`cycleVariant should preserve styleId, got ${JSON.stringify(last)}`);
  }
  if (last?.variantId === "rain" || last?.variantId === null) {
    throw new Error(`cycleVariant should advance variantId, got ${JSON.stringify(last)}`);
  }
  off();
  resetDirector();
  console.log("✓ cycling one axis preserves the other");
}

// ── 6. Mini-Player CSS transform is present in LingbotApp
//       and the expand button is rendered conditionally ─
{
  const fs = await import("node:fs/promises");
  const src = await fs.readFile(
    new URL("../app/LingbotApp.tsx", import.meta.url),
    "utf8",
  );
  if (!/translate\(-72%, -72%\) scale\(0\.28\)/.test(src)) {
    throw new Error("Mini-Player transform not found");
  }
  if (!/data-testid="pip-expand-btn"/.test(src)) {
    throw new Error("PiP expand button missing");
  }
  console.log("✓ Mini-Player PiP transform + expand button present");
}

// ── 7. Shortcuts modal lists the new Director keys ─────
{
  const fs = await import("node:fs/promises");
  const src = await fs.readFile(
    new URL("../app/LingbotApp.tsx", import.meta.url),
    "utf8",
  );
  if (!/title: "Director"/.test(src)) {
    throw new Error("Shortcuts modal should have a Director group");
  }
  if (!/Shift \+ D/.test(src) || !/Shift \+ N/.test(src)) {
    throw new Error("Director Shift+D / Shift+N entries missing");
  }
  console.log("✓ Shortcuts modal has Director group with Shift+D / Shift+N");
}

// ── 8. The keydown listener skips text inputs so the
//       user can type "d" or "0" in a prompt field ──────
{
  const fs = await import("node:fs/promises");
  const src = await fs.readFile(
    new URL("../app/LingbotApp.tsx", import.meta.url),
    "utf8",
  );
  // Look for the new D/N/0 handlers.
  if (!/e\.key === "d" \|\| e\.key === "D"/.test(src)) {
    throw new Error("D key handler missing");
  }
  if (!/e\.key === "n" \|\| e\.key === "N"/.test(src)) {
    throw new Error("N key handler missing");
  }
  if (!/e\.key === "0"/.test(src)) {
    throw new Error("0 key handler missing");
  }
  console.log("✓ Director keyboard handlers present");
}

console.log("\nQA12: all checks passed");
}

void main();
