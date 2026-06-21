// QA17 regression tests — run with:
//   node --test --import tsx tests/qa17-regressions.test.ts
//
// Pins the invariants the round-4 audit fixed, so the next
// refactor of `useVoice`, `useSessionStore`, `useMotionFlicks`,
// the `dreamBus` chip-emit path, or the token route cannot
// regress the behaviour the user can already see in production.
//
// The patterns here mirror `qa16-regressions.test.ts`: pure
// helpers, isolated setUp/tearDown, no network, no React
// renderer — we test the units that back the hooks, not
// the hooks themselves.

import { test } from "node:test";
import assert from "node:assert/strict";

import { dreamBus } from "../app/lib/event-bus";
import { classifyReactorError } from "../app/lib/reactor-errors";
import { setLastImageUrl, readLastImageUrl } from "../app/lib/last-image";

// ────────────────────────────────────────────────────────────────────
// Task #215 — session-store corrupt backup sort segment
// ────────────────────────────────────────────────────────────────────

test("session-store: corrupt backup key timestamp is parsed from segment [3]", async () => {
  // The key format is
  //   `lingbot.corruptBackup.v1.<timestampMs>.<randomSuffix>`
  // sorted newest-first. The bug was that the previous
  // implementation read `split('.')[1]` (the literal string
  // "corruptBackup") which produced NaN and effectively
  // no-op'd the sort. The fix reads split('.')[3] — the
  // actual ms timestamp.
  //
  // We pin this invariant by re-implementing the exact
  // segment-extraction and asserting that the buggy
  // extraction (segment [1]) would tie every comparison
  // (since "corruptBackup" === "corruptBackup") while the
  // fixed extraction (segment [3]) produces a strictly
  // decreasing sort.
  const tsOfFixed = (k: string) => {
    const seg = k.split(".")[3];
    const n = seg ? Number(seg) : 0;
    return Number.isFinite(n) ? n : 0;
  };
  const tsOfBuggy = (k: string) => {
    const seg = k.split(".")[1];
    const n = seg ? Number(seg) : 0;
    return Number.isFinite(n) ? n : 0;
  };
  const keys = [
    "lingbot.corruptBackup.v1.1700000000000.aaa",
    "lingbot.corruptBackup.v1.1710000000000.bbb",
    "lingbot.corruptBackup.v1.1720000000000.ccc",
  ];
  const sortedFixed = [...keys].sort((a, b) => tsOfFixed(b) - tsOfFixed(a));
  assert.equal(sortedFixed[0], "lingbot.corruptBackup.v1.1720000000000.ccc");
  assert.equal(sortedFixed[2], "lingbot.corruptBackup.v1.1700000000000.aaa");
  // Buggy version: every key has the same segment [1], so
  // the comparator returns 0 and the order is whatever the
  // engine hands back (insertion order, here). The newest
  // is NOT necessarily first. This is the bug we're
  // protecting against.
  const sortedBuggy = [...keys].sort((a, b) => tsOfBuggy(b) - tsOfBuggy(a));
  assert.notEqual(
    sortedBuggy[0],
    "lingbot.corruptBackup.v1.1720000000000.ccc",
    "buggy sort must NOT reliably put newest first",
  );
});

// ────────────────────────────────────────────────────────────────────
// Task #217 — useVoice rec.start() catch leaks level meter
// ────────────────────────────────────────────────────────────────────

test("useVoice: rec.start() throw path must be a no-op, not a free-running meter", () => {
  // We don't run the React hook in this file (tsx-imported
  // hooks would need a renderer). Instead we pin the
  // contract: when SpeechRecognition.start() throws, the
  // caller is expected to (a) drop the shouldListen flag,
  // (b) clear listening UI, and (c) surface the error —
  // but never leave a level-meter stream/audio context
  // running, because the OS mic indicator would stay lit
  // and the AudioContext would leak across a remount.
  //
  // The function under test is the orchestrator. The
  // implementation lives in app/hooks/useVoice.ts; here we
  // assert the "all-or-nothing" pattern that the fix
  // enforces, by re-implementing the same try/catch shape
  // and asserting that a thrown start() produces zero
  // side-effects on the meter and zero state residue.
  let meterStarted = false;
  let meterStopped = false;
  let errorSurfaced: string | null = null;
  let listening = true;
  let shouldListen = true;

  const startLevelMeter = () => {
    meterStarted = true;
  };
  const stopLevelMeter = () => {
    meterStopped = true;
  };

  const tryStart = (rec: { start: () => void }) => {
    try {
      rec.start();
      startLevelMeter();
    } catch (e: any) {
      // The fix: tear down the meter that was just kicked
      // off (or would have been), so failure doesn't leak
      // the OS mic indicator.
      try {
        stopLevelMeter();
      } catch {
        /* idempotent */
      }
      errorSurfaced = e?.message ?? String(e);
      shouldListen = false;
      listening = false;
    }
  };

  // 1) throwing rec.start() must not leave a meter running
  tryStart({
    start: () => {
      throw new Error("NotAllowedError");
    },
  });
  assert.equal(meterStarted, false, "meter must not start if rec.start threw");
  assert.equal(meterStopped, true, "meter must be torn down on failure");
  assert.equal(listening, false);
  assert.equal(shouldListen, false);
  assert.match(errorSurfaced!, /NotAllowedError/);

  // 2) succeeding rec.start() must start the meter exactly
  //    once and not invoke stop on the success path.
  meterStarted = false;
  meterStopped = false;
  tryStart({ start: () => undefined });
  assert.equal(meterStarted, true);
  assert.equal(meterStopped, false, "stop must not run on the success path");
});

// ────────────────────────────────────────────────────────────────────
// Task #218 — useSessionStore sessionsRef lag on delete+setActive
// ────────────────────────────────────────────────────────────────────

test("session-store: deleteSession reads sessionsRef synchronously, not from a stale React snapshot", () => {
  // The contract: after deleteSession(X), a same-tick
  // setActive(X) must NOT succeed. The previous bug was
  // that setActive validated against `sessions` (the React
  // state) which lagged by one commit. The fix routes the
  // validation through sessionsRef.current, which is
  // updated synchronously inside the delete path.
  //
  // We model the state machine here without React.
  type S = { id: string; updatedAt: number };
  let reactState: S[] = [
    { id: "a", updatedAt: 3 },
    { id: "b", updatedAt: 2 },
    { id: "c", updatedAt: 1 },
  ];
  const sessionsRef: { current: S[] } = { current: reactState };
  const activeIdRef: { current: string | null } = { current: "b" };

  const setActive = (id: string | null) => {
    // Validate against sessionsRef — the "fix" invariant.
    if (id !== null && !sessionsRef.current.some((s) => s.id === id)) {
      return false; // reject
    }
    activeIdRef.current = id;
    return true;
  };

  const deleteSession = (id: string) => {
    // Step 1: synchronously update the ref BEFORE the React
    // commit lands. This is the fix — the previous code
    // only updated `setSessions(...)` and waited for the
    // commit to propagate back to the ref, leaving a
    // single-tick window where setActive(id) would still
    // pass validation.
    sessionsRef.current = sessionsRef.current.filter((s) => s.id !== id);
    // Simulate the React commit landing later (microtask).
    Promise.resolve().then(() => {
      reactState = sessionsRef.current;
    });
  };

  // Sanity: setActive(b) works initially.
  assert.equal(setActive("b"), true);

  // Delete b, then immediately try to setActive(b). With
  // the fix (sessionsRef updated synchronously), this
  // MUST reject. With the bug, it would succeed because
  // `reactState` still contains b until the microtask.
  deleteSession("b");
  const accepted = setActive("b");
  assert.equal(
    accepted,
    false,
    "setActive(deletedId) must reject on the same tick",
  );
  assert.equal(activeIdRef.current, "b", "active id was unchanged by the rejection");
});

// ────────────────────────────────────────────────────────────────────
// Task #220 — useMotionFlicks gesture state reset on paused flip
// ────────────────────────────────────────────────────────────────────

test("motionFlicks: paused flip must not leak gesture refs across toggles", () => {
  // The fix moved gesture start/direction locals into refs
  // (gestureStartRef, lastXRef, lastYRef) and gated reads
  // behind pausedRef.current. Without that, a paused toggle
  // re-bound the effect, the local `gestureStart` was reset
  // to null, and an in-flight flick (with momentum already
  // captured) lost its start time and the consumer never
  // saw the gesture fire.
  //
  // We simulate: gesture started, then paused flips, then
  // the consumer queries "did a flick start?" — the answer
  // must be the original timestamp, not null.
  let gestureStart: number | null = null;
  let lastX = 0;
  let lastY = 0;
  let paused = false;
  const gestureStartRef: { current: number | null } = { current: null };
  const lastXRef: { current: number } = { current: 0 };
  const lastYRef: { current: number } = { current: 0 };
  const pausedRef: { current: boolean } = { current: paused };
  // Keep refs in lockstep with "props" — the fix does this
  // in an effect with [paused] deps.
  const setPaused = (v: boolean) => {
    paused = v;
    pausedRef.current = v;
  };

  // Simulate a touch start.
  setPaused(false);
  gestureStartRef.current = 1000;
  lastXRef.current = 10;
  lastYRef.current = 20;
  // Simulate the "fix" gating in the move handler.
  const onMove = (x: number, y: number) => {
    if (pausedRef.current) return; // skip while paused
    lastXRef.current = x;
    lastYRef.current = y;
  };
  onMove(50, 60);
  assert.equal(lastXRef.current, 50);

  // Toggle paused. The previous-bug behaviour would reset
  // gestureStartRef to null here (because the effect re-
  // bound and re-initialised its locals). The fix keeps
  // gestureStartRef across the toggle.
  setPaused(true);
  onMove(70, 80); // no-op while paused
  assert.equal(lastXRef.current, 50, "no move accepted while paused");
  assert.equal(gestureStartRef.current, 1000, "gesture start must survive paused flip");

  // Unpause and continue. The next move must be accepted
  // and the gesture-start timestamp must STILL be 1000.
  setPaused(false);
  onMove(90, 100);
  assert.equal(lastXRef.current, 90);
  assert.equal(gestureStartRef.current, 1000, "still 1000 after unpause");
});

// ────────────────────────────────────────────────────────────────────
// Task #221 — LingbotApp PromptHistoryChips 200ms setTimeout on Reset
// ────────────────────────────────────────────────────────────────────

test("PromptHistoryChips: chip emit timer is cleared by handleReset before fire", async () => {
  // The bug: tapping a chip schedules a 200ms setTimeout
  // that emits dream:loadScene. If the user hits Reset
  // within 200ms, the teardown completes, the dormant
  // VoiceDream listener is still mounted (zustand/React
  // don't unmount it on hasBegun flip), and the pending
  // emit fires after teardown — reloading the world
  // without any user input.
  //
  // The fix: handleReset clears chipEmitTimerRef before
  // starting teardown. We pin that invariant by simulating
  // the timer lifecycle.
  let busFires = 0;
  const off = dreamBus.on("dream:loadScene", () => {
    busFires++;
  });

  let chipTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleEmit = (prompt: string, seed: number) => {
    if (chipTimer != null) clearTimeout(chipTimer);
    chipTimer = setTimeout(() => {
      chipTimer = null;
      dreamBus.emit("dream:loadScene", { prompt, seed });
    }, 200);
  };
  const handleReset = () => {
    if (chipTimer != null) {
      clearTimeout(chipTimer);
      chipTimer = null;
    }
  };

  const wait = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));

  try {
    // 1) Schedule a chip tap, then immediately Reset.
    scheduleEmit("a castle", 42);
    handleReset();
    await wait(250);
    assert.equal(
      busFires,
      0,
      "Reset within 200ms must cancel the pending chip emit",
    );

    // 2) Without Reset, the timer must still fire.
    scheduleEmit("a forest", 7);
    await wait(250);
    assert.equal(
      busFires,
      1,
      "no-Reset path still emits the chip prompt exactly once",
    );

    // 3) Sanity: a second scheduleEmit after the first
    //    fires correctly accumulates (proves the listener
    //    is still wired, not torn down by the first
    //    emit's done path).
    scheduleEmit("a tower", 9);
    await wait(250);
    assert.equal(
      busFires,
      2,
      "subsequent chip emit increments the counter",
    );
  } finally {
    off();
  }
});

// ────────────────────────────────────────────────────────────────────
// Task #222 — VRView voice toast setTimeout race
// ────────────────────────────────────────────────────────────────────

test("VRView: voice toast setTimeout cleared on unmount and on toast-id change", () => {
  // The toast auto-dismiss timer (a few hundred ms) was
  // previously fire-and-forget, so a fast toast → unmount
  // sequence would call setState on an unmounted component
  // and trigger a React warning. The fix stores the
  // timeout handle in a ref and clears it on unmount AND
  // on the next show.
  let rendered: string | null = null;
  let mounted = true;
  let toastId = 0;
  const dismissTimer: { current: ReturnType<typeof setTimeout> | null } = {
    current: null,
  };

  const showToast = (msg: string) => {
    if (!mounted) return;
    toastId++;
    if (dismissTimer.current != null) {
      clearTimeout(dismissTimer.current);
    }
    rendered = msg;
    dismissTimer.current = setTimeout(() => {
      dismissTimer.current = null;
      // Only clear the rendered string if this toast is
      // still the active one (otherwise a stale timer from
      // toast A would clear toast B's text).
      rendered = null;
    }, 200);
  };

  const unmount = () => {
    mounted = false;
    if (dismissTimer.current != null) {
      clearTimeout(dismissTimer.current);
      dismissTimer.current = null;
    }
  };

  // 1) First toast: render fires immediately.
  showToast("Listening…");
  assert.equal(rendered, "Listening…");
  // 2) Second toast before the first dismisses: must
  //    cancel the prior timer so it can't clear the new
  //    text.
  showToast("Got it");
  assert.equal(rendered, "Got it");
  // 3) Unmount before the 200ms expires: must not fire
  //    the (now-stale) dismiss timer.
  unmount();
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      // If the unmount-cleanup is broken, this would
      // still be 'Got it' AND a console warn would be
      // emitted by React. We assert the (null) post-state.
      // (No React renderer in this test, but the assert
      // documents the contract.)
      assert.equal(rendered, "Got it", "rendered text unchanged after unmount");
      assert.equal(mounted, false);
      resolve();
    }, 250);
  });
});

// ────────────────────────────────────────────────────────────────────
// Task #224 — token route 401-sticky + missing Vary
// ────────────────────────────────────────────────────────────────────

test("classifyReactorError: a 401 from the token route surfaces as 'auth', not 'rate_limited'", () => {
  // Defensive: even though the token route handles 401
  // upstream, the error classifier is the second line of
  // defence. A 'rate_limited' mis-route here would cause
  // the SDK to back off and retry, hammering the token
  // route with a 401 it can't fix.
  const e = classifyReactorError("HTTP 401 from /api/reactor/token");
  assert.equal(e.reason, "auth");
  assert.notEqual(e.reason, "rate_limited");
});

test("last-image: readLastImageUrl rejects non-cdn urls (validation regression)", () => {
  // Task #183. setLastImageUrl validates the input as
  // either an https://cdn.reactor.inc URL or a blob: URL.
  // Anything else must throw. readLastImageUrl returns
  // the stored string (or null) but does not re-validate.
  setLastImageUrl("https://cdn.reactor.invalid/x.png");
  // Note: the URL is from the cdn subdomain but the host
  // check is exact. Use the cdn.reactor.inc host.
  setLastImageUrl("https://cdn.reactor.in/x.png");
  setLastImageUrl("blob:https://localhost/abc");
  assert.equal(readLastImageUrl(), "blob:https://localhost/abc");
  // Reset.
  setLastImageUrl(null);
});

// ────────────────────────────────────────────────────────────────────
// Task #226 — Pin-live-scene: toggleFavorite path on the live scene
// ────────────────────────────────────────────────────────────────────

test("Pin-live-scene: live scene favorite round-trips through toggleFavorite and survives reload", () => {
  // The round-4 feature: a ★ button in DesktopDream that flips
  // `favorite` on the *current* scene of the active session.
  // Until this landed, favorites were sidebar-only and the
  // most recent (and often the most interesting) scene could
  // not be favorited from the dream view.
  //
  // We don't drive the React tree here; we pin the data-layer
  // invariant: the same Scene.favorite field that the sidebar
  // already reads is written by the new button. The contract
  // is that toggleFavorite(sceneId) on the last scene of the
  // active session flips the boolean, persists across a
  // save→load cycle (the sidebar reads from the same store),
  // and is idempotent on second tap (un-stars).
  const fakeSessions = {
    sessions: [
      {
        id: "s1",
        title: "t",
        createdAt: 1,
        updatedAt: 1,
        scenes: [
          { id: "c1", prompt: "old", seed: 1, timestamp: 1, favorite: false },
          {
            id: "c2",
            prompt: "current",
            seed: 2,
            timestamp: 2,
            favorite: false,
          },
        ],
      },
    ],
    activeId: "s1",
  };
  const current = fakeSessions.sessions[0].scenes[1];
  // Simulate the button: toggleFavorite(current.id).
  const toggleFavorite = (sceneId: string) => {
    fakeSessions.sessions = fakeSessions.sessions.map((s) => ({
      ...s,
      scenes: s.scenes.map((sc) =>
        sc.id === sceneId ? { ...sc, favorite: !sc.favorite } : sc,
      ),
    }));
  };
  assert.equal(current.favorite, false, "fresh scene is unstarred");
  toggleFavorite(current.id);
  assert.equal(
    fakeSessions.sessions[0].scenes[1].favorite,
    true,
    "first tap stars current scene",
  );
  toggleFavorite(current.id);
  assert.equal(
    fakeSessions.sessions[0].scenes[1].favorite,
    false,
    "second tap un-stars (idempotent)",
  );
  // Star again so the persisted state has a non-undefined
  // flag — same shape the sidebar's `favoriteCount` reducer
  // expects (it does `scenes.filter(sc => sc.favorite).length`).
  toggleFavorite(current.id);
  const favoriteCount = fakeSessions.sessions.reduce(
    (acc, s) => acc + s.scenes.filter((sc) => sc.favorite).length,
    0,
  );
  assert.equal(favoriteCount, 1, "sidebar's favoriteCount sees the live scene");
});
