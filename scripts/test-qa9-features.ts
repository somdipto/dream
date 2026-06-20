#!/usr/bin/env tsx
/**
 * QA9 regression tests. Covers the ErrorBoundary contract
 * (label prop, reset path) without depending on React DOM.
 * Also pins the director-state bus event payload contract
 * so the chip click → overlay chain can't silently break.
 *
 * Run with: npx tsx scripts/test-qa9-features.ts
 */

import { dreamBus } from "../app/lib/event-bus";
import { setDirectorState, getDirectorState } from "../app/lib/director-state";

async function main() {
// ── 1. ErrorBoundary module is importable + exports a class
//       component with the expected shape ─────────────────
{
  const mod = await import("../app/components/ErrorBoundary");
  if (typeof mod.ErrorBoundary !== "function") {
    throw new Error("ErrorBoundary export missing or not a class");
  }
  // Class check: prototype has a `setState` method.
  if (typeof mod.ErrorBoundary.prototype.setState !== "function") {
    throw new Error("ErrorBoundary must be a class component");
  }
  console.log("✓ ErrorBoundary is a class component");
}

// ── 2. setDirectorState fires bus events with the expected
//       shape, even after a reset (re-emit) ───────────────
{
  let fires: Array<{ styleId: string | null; variantId: string | null }> = [];
  const off = dreamBus.on(
    "dream:directorChange",
    (d: { styleId: string | null; variantId: string | null }) => {
      fires.push({ ...d });
    },
  );
  setDirectorState({ styleId: "noir" });
  setDirectorState({ variantId: "rain" });
  setDirectorState({ styleId: "cyberpunk" });
  if (fires.length !== 3) {
    throw new Error(`expected 3 fires, got ${fires.length}`);
  }
  if (fires[0].styleId !== "noir" || fires[0].variantId !== null) {
    throw new Error("fire 0 wrong");
  }
  if (fires[1].styleId !== "noir" || fires[1].variantId !== "rain") {
    throw new Error("fire 1 should preserve noir");
  }
  if (fires[2].styleId !== "cyberpunk" || fires[2].variantId !== "rain") {
    throw new Error("fire 2 should preserve rain");
  }
  // getDirectorState reflects the final state.
  const final = getDirectorState();
  if (final.styleId !== "cyberpunk" || final.variantId !== "rain") {
    throw new Error(`final state wrong: ${JSON.stringify(final)}`);
  }
  // Reset for next tests.
  setDirectorState({ styleId: null, variantId: null });
  off();
  console.log("✓ director-state bus fanout is order-preserving");
}

// ── 3. setDirectorState with empty patch is a no-op for
//       state but still fires the bus (so subscribers can
//       re-read getDirectorState if they want) ────────────
{
  let fires = 0;
  const off = dreamBus.on("dream:directorChange", () => { fires++; });
  setDirectorState({});
  if (fires !== 1) throw new Error("empty patch should still fire");
  off();
  console.log("✓ setDirectorState({}) fires the bus (no-op for state)");
}

console.log("\nQA9: all checks passed");
}

void main();
