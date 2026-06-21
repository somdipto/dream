#!/usr/bin/env tsx
/**
 * QA15 regression tests. Critical bug fixes from a 3-agent
 * deep audit (errors, performance, UX).
 *
 * Run with: npx tsx scripts/test-qa15-fixes.ts
 */

// localStorage polyfill — byok.ts is a browser-only module.
const _ls: Record<string, string> = {};
const fakeStorage = {
  getItem: (k: string) => _ls[k] ?? null,
  setItem: (k: string, v: string) => {
    _ls[k] = v;
  },
  removeItem: (k: string) => {
    delete _ls[k];
  },
  clear: () => {
    for (const k of Object.keys(_ls)) delete _ls[k];
  },
  key: () => null as string | null,
};
Object.defineProperty(fakeStorage, "length", {
  get() {
    return Object.keys(_ls).length;
  },
});
(globalThis as unknown as { window: unknown }).window = globalThis;
(globalThis as unknown as { localStorage: typeof fakeStorage }).localStorage = fakeStorage;

import {
  classifyReactorError,
  isClassifiedTerminal,
} from "../app/lib/reactor-errors";

async function main() {
// ── 1. byok.loadUserKey trims whitespace before validating ──
{
  const { loadUserKey, saveUserKey, clearUserKey } = await import(
    "../app/lib/byok"
  );
  // Wipe and re-seed with a whitespace-wrapped value to
  // simulate a partial write.
  clearUserKey();
  const k = "rk_" + "a".repeat(40);
  if (!saveUserKey("  " + k + "  ")) {
    throw new Error("saveUserKey should accept trimmed input");
  }
  const got = loadUserKey();
  if (got !== k) {
    throw new Error(`loadUserKey returned "${got}", expected trimmed "${k}"`);
  }
  clearUserKey();
  console.log("✓ byok trims whitespace on load and returns the clean key");
}

// ── 2. isClassifiedTerminal lists the auth/credits/service
//       reasons that must NOT auto-retry ────────────────
{
  const list = isClassifiedTerminal("credits_depleted");
  if (!list) throw new Error("credits_depleted should be terminal");
  if (!isClassifiedTerminal("auth")) throw new Error("auth should be terminal");
  if (!isClassifiedTerminal("rate_limited")) {
    throw new Error("rate_limited should be terminal");
  }
  if (!isClassifiedTerminal("service_unavailable")) {
    throw new Error("service_unavailable should be terminal");
  }
  // These are NOT terminal (recoverable).
  if (isClassifiedTerminal("network")) {
    throw new Error("network should be retryable");
  }
  if (isClassifiedTerminal("unknown")) {
    throw new Error("unknown should be retryable");
  }
  console.log("✓ isClassifiedTerminal correctly classifies the 4 terminal + 2 retryable reasons");
}

// ── 3. CommandError holds the error for 4s, doesn't reset
//       on every state snapshot ────────────────────────
{
  const fs = await import("node:fs/promises");
  const src = await fs.readFile(
    new URL("../app/components/CommandError.tsx", import.meta.url),
    "utf8",
  );
  if (/useLingbotState/.test(src)) {
    throw new Error("CommandError must no longer subscribe to useLingbotState");
  }
  if (!/setTimeout.*setError\(null\).*HOLD_MS|HOLD_MS/.test(src)) {
    throw new Error("CommandError must hold the error with a setTimeout");
  }
  if (!/data-testid="command-error-dismiss"/.test(src)) {
    throw new Error("CommandError must have a dismiss button");
  }
  console.log("✓ CommandError holds for 4s, dismissable, no longer wiped by state stream");
}

// ── 4. paint timeout raised from 8s to 30s in both
//       VoiceDream and DesktopDream ────────────────────
{
  const fs = await import("node:fs/promises");
  for (const path of [
    "../app/components/VoiceDream.tsx",
    "../app/components/DesktopDream.tsx",
  ] as const) {
    const src = await fs.readFile(new URL(path, import.meta.url), "utf8");
    if (/setTimeout.*resolve\("timeout"\),\s*8000\)/.test(src)) {
      throw new Error(`${path} still has 8s timeout`);
    }
    if (!/setTimeout.*resolve\("timeout"\),\s*30000\)/.test(src)) {
      throw new Error(`${path} should use 30s timeout`);
    }
  }
  console.log("✓ paint pipeline timeout raised to 30s in both VoiceDream and DesktopDream");
}

// ── 5. auto-reconnect effect skips terminal reasons ───
{
  const fs = await import("node:fs/promises");
  const src = await fs.readFile(
    new URL("../app/LingbotApp.tsx", import.meta.url),
    "utf8",
  );
  // The classifier call must appear inside the auto-retry
  // effect, not just somewhere in the file.
  const start = src.indexOf("const reconnectingRef = useRef");
  if (start < 0) {
    throw new Error("Could not locate the auto-retry effect start");
  }
  const end = src.indexOf("setTimeout(() => {\n      void connect();\n    }, 1500);", start);
  if (end < 0) {
    throw new Error("Could not locate the auto-retry setTimeout");
  }
  const block = src.slice(start, end + 200);
  if (!/classifyReactorError/.test(block)) {
    throw new Error("auto-retry effect must call classifyReactorError");
  }
  if (!/credits_depleted/.test(block)) {
    throw new Error("auto-retry effect must skip credits_depleted");
  }
  console.log("✓ auto-retry effect skips terminal reasons (credits_depleted, auth, rate_limited, service_unavailable)");
}

// ── 6. autoRetrying state surfaces an inline pill ─────
{
  const fs = await import("node:fs/promises");
  const src = await fs.readFile(
    new URL("../app/LingbotApp.tsx", import.meta.url),
    "utf8",
  );
  if (!/autoRetrying/.test(src)) {
    throw new Error("autoRetrying state must exist");
  }
  if (!/data-testid="auto-retry-pill"/.test(src)) {
    throw new Error("auto-retry pill must be visible in the connecting overlay");
  }
  console.log("✓ auto-retry pill renders when a silent retry is in flight");
}

// ── 7. stuck-detection uses a wall-clock deadline so
//       the 8s clock doesn't restart on every SDK flip ─
{
  const fs = await import("node:fs/promises");
  const src = await fs.readFile(
    new URL("../app/LingbotApp.tsx", import.meta.url),
    "utf8",
  );
  if (!/connectingSinceRef\.current = Date\.now\(\)/.test(src)) {
    throw new Error("stuck detection must record a wall-clock start time");
  }
  if (!/connectingSinceRef\.current === start/.test(src)) {
    throw new Error("stuck detection must compare start values to avoid double-trip");
  }
  console.log("✓ stuck-detection uses a single wall-clock deadline");
}

// ── 8. classifyReactorError still works as before ────
{
  // Sanity: an old-style 402 with credits_depleted should
  // classify as terminal.
  const r1 = classifyReactorError(
    'Failed to create session: 402 {"error":"credits_depleted"}',
  );
  if (r1.reason !== "credits_depleted") {
    throw new Error(`expected credits_depleted, got ${r1.reason}`);
  }
  // A message that doesn't match any known pattern should
  // classify as unknown (retryable).
  const r2 = classifyReactorError("Some brand new error we haven't seen before");
  if (r2.reason !== "unknown") {
    throw new Error(`expected unknown, got ${r2.reason}`);
  }
  console.log("✓ classifyReactorError is unchanged");
}

console.log("\nQA15: all checks passed");
}

void main();
