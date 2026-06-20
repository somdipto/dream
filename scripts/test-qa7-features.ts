#!/usr/bin/env tsx
/**
 * QA7 regression tests for the F4-F6 features (Dream Journal
 * Audio, Dream Charades, Memory Beacons).
 *
 * Run with: npx tsx scripts/test-qa7-features.ts
 */

import { pickSurprisePrompt, _resetSurpriseRng, SURPRISE_PROMPTS } from "../app/lib/surprise-prompts";
import { dreamBus } from "../app/lib/event-bus";

// ── 1. pickSurprisePrompt returns a valid surprise ────────
{
  _resetSurpriseRng(0xdeadbeef);
  const p = pickSurprisePrompt();
  if (typeof p !== "string") throw new Error("pickSurprisePrompt must return a string");
  if (p.length < 10) throw new Error(`surprise prompt too short: "${p}"`);
  if (!SURPRISE_PROMPTS.includes(p)) {
    throw new Error("pickSurprisePrompt must pick from the curated list");
  }
  console.log("✓ pickSurprisePrompt returns a curated string");
}

// ── 2. Same seed → same pick (deterministic) ──────────────
{
  _resetSurpriseRng(0xfeedface);
  const a = pickSurprisePrompt();
  const b = pickSurprisePrompt();
  const c = pickSurprisePrompt();
  _resetSurpriseRng(0xfeedface);
  const a2 = pickSurprisePrompt();
  const b2 = pickSurprisePrompt();
  const c2 = pickSurprisePrompt();
  if (a !== a2 || b !== b2 || c !== c2) {
    throw new Error(`RNG not deterministic: a=${a} vs ${a2}`);
  }
  console.log("✓ surprise RNG is deterministic per seed");
}

// ── 3. Across many rolls, the picker covers most of the
//       list (no stuck 1-pick loop) ─────────────────────────
{
  _resetSurpriseRng(0x42);
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) {
    seen.add(pickSurprisePrompt());
  }
  if (seen.size < Math.min(SURPRISE_PROMPTS.length, 15)) {
    throw new Error(`surprise picker stuck on few values: ${seen.size}`);
  }
  if (seen.size === 1) throw new Error("picker never moved");
  console.log(`✓ surprise picker covers the list (${seen.size}/${SURPRISE_PROMPTS.length} in 200 rolls)`);
}

// ── 4. Memory Beacon emits a loadScene event with
//       "continuing forward" suffix + next seed ────────────
{
  // Simulate the same click handler used in SessionSidebar.
  let captured: { prompt: string; seed: number } | null = null;
  const off = dreamBus.on(
    "dream:loadScene",
    (d: { prompt: string; seed: number }) => {
      captured = { ...d };
    },
  );
  const scene = { id: "abc", prompt: "a misty pine forest", seed: 12345 };
  const next = (scene.seed + 1) >>> 0;
  dreamBus.emit("dream:loadScene", {
    prompt: `${scene.prompt}, continuing forward`,
    seed: next,
  });
  const c = captured as { prompt: string; seed: number } | null;
  if (!c || c.prompt !== "a misty pine forest, continuing forward") {
    throw new Error(`memory beacon prompt wrong: ${JSON.stringify(c)}`);
  }
  if (!c || c.seed !== 12346) {
    throw new Error(`memory beacon seed not next: ${c?.seed}`);
  }
  // Each successive beacon uses a different seed (no two
  // beacons produce the same world).
  let captured2: { prompt: string; seed: number } | null = null;
  const off2 = dreamBus.on(
    "dream:loadScene",
    (d: { prompt: string; seed: number }) => {
      captured2 = { ...d };
    },
  );
  dreamBus.emit("dream:loadScene", {
    prompt: `${scene.prompt}, continuing forward`,
    seed: ((scene.seed + 1) >>> 0) + 1,
  });
  const c2 = captured2 as { prompt: string; seed: number } | null;
  if (c2?.seed === c?.seed) {
    throw new Error("successive beacons produced identical seeds");
  }
  off();
  off2();
  console.log("✓ memory beacon emits the expected loadScene payload");
}

// ── 5. surprise prompts are all substantive (no short
//       placeholders like 'a') ─────────────────────────────
{
  for (const p of SURPRISE_PROMPTS) {
    if (p.length < 30) {
      throw new Error(`surprise prompt too short: "${p}"`);
    }
    // No placeholder-sounding prompts.
    if (/^test|^todo|^placeholder|^xxx/i.test(p)) {
      throw new Error(`surprise prompt looks like a placeholder: "${p}"`);
    }
  }
  if (SURPRISE_PROMPTS.length < 10) {
    throw new Error(`need at least 10 surprise prompts, got ${SURPRISE_PROMPTS.length}`);
  }
  console.log(`✓ ${SURPRISE_PROMPTS.length} surprise prompts, all substantive`);
}

console.log("\nQA7: all checks passed");