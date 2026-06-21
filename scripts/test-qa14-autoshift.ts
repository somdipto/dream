#!/usr/bin/env tsx
/**
 * QA14 regression tests. Covers Time-of-day auto-shift.
 *
 * Run with: npx tsx scripts/test-qa14-autoshift.ts
 */

import { timeBandForHour, timeBandForNow, labelForBand, variantIdForBand } from "../app/lib/time-of-day";

async function main() {
// ── 1. Hour 6 → dawn, hour 14 → none, hour 18 → sunset,
//       hour 23 → night ────────────────────────────────
{
  if (timeBandForHour(6) !== "dawn") throw new Error("6am should be dawn");
  if (timeBandForHour(14) !== "none") throw new Error("2pm should be none");
  if (timeBandForHour(18) !== "sunset") throw new Error("6pm should be sunset");
  if (timeBandForHour(23) !== "night") throw new Error("11pm should be night");
  console.log("✓ band lookup matches expected hours");
}

// ── 2. Edge cases: 4am is night, 5am is dawn, 8am is
//       none, 17 is sunset, 20 is night ──────────────
{
  if (timeBandForHour(4) !== "night") throw new Error("4am should be night");
  if (timeBandForHour(5) !== "dawn") throw new Error("5am should be dawn");
  if (timeBandForHour(8) !== "none") throw new Error("8am should be none");
  if (timeBandForHour(17) !== "sunset") throw new Error("17:00 should be sunset");
  if (timeBandForHour(20) !== "night") throw new Error("20:00 should be night");
  console.log("✓ band edges are correct at hour boundaries");
}

// ── 3. variantIdForBand maps bands to variant ids ──
{
  if (variantIdForBand("dawn") !== "dawn") throw new Error("dawn->dawn");
  if (variantIdForBand("none") !== "none") throw new Error("none->none");
  if (variantIdForBand("sunset") !== "sunset") throw new Error("sunset->sunset");
  if (variantIdForBand("night") !== "night") throw new Error("night->night");
  console.log("✓ variant mapping is the identity (for the bands we map)");
}

// ── 4. labelForBand is human-friendly ──────────────
{
  if (labelForBand("dawn") !== "Dawn") throw new Error("dawn label");
  if (labelForBand("none") !== "Day") throw new Error("none label");
  if (labelForBand("sunset") !== "Golden hour") throw new Error("sunset label");
  if (labelForBand("night") !== "Night") throw new Error("night label");
  console.log("✓ labels are human-friendly");
}

// ── 5. timeBandForNow is a valid band ───────────────
{
  const b = timeBandForNow();
  if (b !== "dawn" && b !== "none" && b !== "sunset" && b !== "night") {
    throw new Error(`unexpected band: ${b}`);
  }
  console.log("✓ timeBandForNow returns a valid band");
}

// ── 6. LingbotApp wires timeBandForNow into a useEffect
//       that fires on the rising edge of hasBegun ─────
{
  const fs = await import("node:fs/promises");
  const src = await fs.readFile(
    new URL("../app/LingbotApp.tsx", import.meta.url),
    "utf8",
  );
  if (!/timeBandForNow/.test(src)) {
    throw new Error("LingbotApp must call timeBandForNow");
  }
  if (!/variantIdForBand/.test(src)) {
    throw new Error("LingbotApp must call variantIdForBand");
  }
  if (!/lastAutoShiftedRef/.test(src)) {
    throw new Error("auto-shift must use a ref to detect rising edge");
  }
  console.log("✓ LingbotApp auto-shift is wired with rising-edge guard");
}

// ── 7. The auto-shift is opt-out: a user-set variant
//       should NOT be overridden. (Contract: we check
//       current.variantId === null before applying.) ─
{
  // We can't render the React hook here, but we can
  // verify the contract: the helper sets only when the
  // current variant is null. We test that by re-reading
  // the file's logic: it must guard on current.variantId.
  const fs = await import("node:fs/promises");
  const src = await fs.readFile(
    new URL("../app/LingbotApp.tsx", import.meta.url),
    "utf8",
  );
  if (!/current\.variantId === null/.test(src)) {
    throw new Error("auto-shift must guard on current.variantId === null");
  }
  console.log("✓ auto-shift respects a user-picked variant");
}

console.log("\nQA14: all checks passed");
}

void main();
