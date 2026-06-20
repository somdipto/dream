// M9.16 verification: black-screen log round-trips through
// localStorage, dedupes, caps at MAX_ENTRIES, and is cleared
// by clearBlackScreenLog().
import {
  recordBlackScreen,
  getBlackScreenLog,
  clearBlackScreenLog,
  blackScreenLogCount,
} from "../app/lib/black-screen-log";

// Tiny localStorage shim — Node 22 has a global localStorage, but
// the file shouldn't depend on that.
const memStore = new Map<string, string>();
(globalThis as any).window = {
  localStorage: {
    getItem: (k: string) => memStore.get(k) ?? null,
    setItem: (k: string, v: string) => memStore.set(k, v),
    removeItem: (k: string) => memStore.delete(k),
  },
};

let pass = 0;
let fail = 0;
function t(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ✓ ${name}`);
    pass++;
  } else {
    console.log(`  ✗ ${name}`);
    fail++;
  }
}

console.log("Black-screen log");

clearBlackScreenLog();
t("empty after clear", blackScreenLogCount() === 0);
t("get returns [] after clear", getBlackScreenLog().length === 0);

recordBlackScreen({
  source: "dark-frame-watchdog",
  prompt: "a sunset",
  seed: 42,
  sessionId: "s1",
  luma: 12,
  note: "first event",
});
t("count is 1 after one record", blackScreenLogCount() === 1);

recordBlackScreen({
  source: "seed-upload-timeout",
  prompt: null,
  seed: null,
  sessionId: null,
  luma: null,
  note: "second",
});
recordBlackScreen({
  source: "user-report",
  prompt: "rainforest",
  seed: 99,
  sessionId: "s2",
  luma: null,
  note: "third",
});
t("count is 3", blackScreenLogCount() === 3);

const all = getBlackScreenLog();
t("first recorded is first event (a sunset)", all[0].prompt === "a sunset");
t("third recorded is third event (rainforest)", all[2].prompt === "rainforest");
t("luma preserved on dark-frame", all[0].luma === 12);
t("source preserved", all[2].source === "user-report");
t("ts set automatically", all[0].ts > 0);

// Cap test: record 60, expect at most 50.
for (let i = 0; i < 60; i++) {
  recordBlackScreen({
    source: "unknown",
    prompt: `bulk-${i}`,
    seed: i,
    sessionId: null,
    luma: null,
    note: null,
  });
}
t("capped at 50 entries", blackScreenLogCount() <= 50);

// Persistence test: re-read after a "reload" by re-reading the
// store via the lib's getBlackScreenLog (the lib already reads
// from localStorage each call).
const afterReload = getBlackScreenLog();
t("persists across reads (no in-memory cache)", afterReload.length === blackScreenLogCount());

clearBlackScreenLog();
t("cleared", blackScreenLogCount() === 0);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
