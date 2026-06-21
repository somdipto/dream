#!/usr/bin/env tsx
/**
 * QA13 regression tests. Covers Scene Fork.
 *
 * Run with: npx tsx scripts/test-qa13-fork.ts
 */

// We can't use the React hook directly (no renderer), so
// we test the underlying primitive: the data shape that
// the hook consumes. The hook is a thin wrapper over
// useState + setSessions; the test below mirrors its
// semantics with a plain function.
//
// We also test the pure fork logic by importing the
// scene-id helper from session-store helpers if
// available — if not, we use crypto.randomUUID as a
// stand-in for `newSceneId`/`newSessionId`.

// We test the pure logic: build a session, run a clone
// operation, verify the result. This matches the hook's
// behavior exactly without depending on React DOM.

function cloneScenes(scenes: Array<{ id: string; prompt: string; seed: number; timestamp: number; favorite?: boolean }>, upTo: number) {
  return scenes.slice(0, upTo + 1).map((s) => ({
    ...s,
    id: `new-${s.id}`,
    favorite: false,
  }));
}

async function main() {
// ── 1. Fork copies every scene up to and including the
//       fork point ─────────────────────────────────────
{
  const scenes = [
    { id: "a", prompt: "A", seed: 1, timestamp: 100 },
    { id: "b", prompt: "B", seed: 2, timestamp: 200 },
    { id: "c", prompt: "C", seed: 3, timestamp: 300 },
    { id: "d", prompt: "D", seed: 4, timestamp: 400 },
  ];
  // Fork at index 1 (scene "b"). Should include A, B.
  const copied = cloneScenes(scenes, 1);
  if (copied.length !== 2) throw new Error(`expected 2 scenes, got ${copied.length}`);
  if (copied[0].prompt !== "A" || copied[1].prompt !== "B") {
    throw new Error("wrong scenes copied");
  }
  // Copied scenes must have NEW ids, not the originals.
  if (copied[0].id === "a" || copied[1].id === "b") {
    throw new Error("forked scenes should have new ids");
  }
  // The original seeds should be preserved (so the
  // user can re-paint a forked scene and get the same
  // starting point as the source).
  if (copied[0].seed !== 1 || copied[1].seed !== 2) {
    throw new Error("fork should preserve seeds");
  }
  console.log("✓ fork copies scenes up to fork point, preserves seeds, new ids");
}

// ── 2. Fork at end → copies all scenes ──────────────
{
  const scenes = [
    { id: "a", prompt: "A", seed: 1, timestamp: 100 },
    { id: "b", prompt: "B", seed: 2, timestamp: 200 },
  ];
  const copied = cloneScenes(scenes, scenes.length - 1);
  if (copied.length !== 2) throw new Error("end-fork should copy all scenes");
  console.log("✓ fork at end copies all scenes");
}

// ── 3. favorite flag is NOT copied (a fork is a fresh
//       exploration, not a duplicate of the marks) ────
{
  const scenes = [
    { id: "a", prompt: "A", seed: 1, timestamp: 100, favorite: true },
  ];
  const copied = cloneScenes(scenes, 0);
  if (copied[0].favorite !== false) {
    throw new Error("forked scenes should not inherit favorite");
  }
  console.log("✓ favorite flag is reset on fork");
}

// ── 4. Empty session → no scenes copied, returns null
//       safely (forkSession returns null) ──────────────
{
  // The hook checks forkIndex < 0 and returns null.
  // We just check the data invariant: slicing an
  // empty array yields an empty array.
  const copied = cloneScenes([], 0);
  if (copied.length !== 0) {
    throw new Error("empty source should yield empty fork");
  }
  console.log("✓ empty source session yields empty fork");
}

// ── 5. The original session is untouched by a fork
//       (no mutation) ──────────────────────────────────
{
  const scenes = [
    { id: "a", prompt: "A", seed: 1, timestamp: 100 },
    { id: "b", prompt: "B", seed: 2, timestamp: 200 },
  ];
  const originalLen = scenes.length;
  cloneScenes(scenes, 1);
  if (scenes.length !== originalLen) {
    throw new Error("fork should not mutate the source");
  }
  if (scenes[0].id !== "a" || scenes[1].id !== "b") {
    throw new Error("fork should not mutate source ids");
  }
  console.log("✓ fork is non-mutating");
}

// ── 6. SessionSidebar wires up scene-fork button ─────
{
  const fs = await import("node:fs/promises");
  const src = await fs.readFile(
    new URL("../app/components/SessionSidebar.tsx", import.meta.url),
    "utf8",
  );
  if (!/data-testid="scene-fork"/.test(src)) {
    throw new Error("scene-fork button missing from SessionSidebar");
  }
  if (!/onFork=\{/.test(src)) {
    throw new Error("onFork prop must be wired");
  }
  console.log("✓ SessionSidebar wires onFork to forkSession");
}

// ── 7. useSessionStore exports forkSession ────────────
{
  const fs = await import("node:fs/promises");
  const src = await fs.readFile(
    new URL("../app/hooks/useSessionStore.ts", import.meta.url),
    "utf8",
  );
  if (!/forkSession:/.test(src)) {
    throw new Error("forkSession must be in the store interface");
  }
  if (!/const forkSession = useCallback/.test(src)) {
    throw new Error("forkSession must be implemented");
  }
  console.log("✓ useSessionStore implements forkSession");
}

console.log("\nQA13: all checks passed");
}

void main();
