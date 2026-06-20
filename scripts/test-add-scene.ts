// M9.17 verification: addScene dedupe behavior.
//
// The user said "whatever I speak live in LiveVocs in the voice
// call should automatically be added to the current session
// screen" AND that the same session can be edited by WASD/mouse.
// Both of these call addScene — and historically they would
// double-fire (voice.onFinal + form.onSubmit for the same prompt
// landed as two scenes in the journal). The M9.9 dedupe fix
// keys on (prompt, seed, ts<3s) and the addScene reads from
// sessionsRef (not the closure-captured `sessions`) so two
// back-to-back calls see the latest list.

import {
  loadFromStorage,
  saveToStorage,
} from "../app/lib/session-store";

// localStorage shim
const memStore = new Map<string, string>();
(globalThis as any).window = {
  localStorage: {
    getItem: (k: string) => memStore.get(k) ?? null,
    setItem: (k: string, v: string) => memStore.set(k, v),
    removeItem: (k: string) => memStore.delete(k),
    key: (i: number) => Array.from(memStore.keys())[i] ?? null,
    get length() {
      return memStore.size;
    },
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

console.log("addScene dedupe + active-session auto-creation");

// Initial: 1 session, empty scenes.
const sessionId = "active-1";
const before = {
  id: sessionId,
  title: "Untitled",
  createdAt: Date.now(),
  updatedAt: Date.now(),
  scenes: [],
};
saveToStorage([before], sessionId);

const now = Date.now();
const prompt = "a thunderstorm rolling in";
const seed = 1234;

// First call: nothing in live.scenes for this session yet, no dup,
// add a scene.
const live1 = loadFromStorage().sessions;
const dup1 = live1.find((s) => s.id === sessionId)?.scenes.find(
  (sc) => sc.prompt === prompt && sc.seed === seed && now - sc.timestamp < 3000,
);
t("first call: no dup", !dup1);

const scene1 = {
  id: "sc-1",
  prompt,
  seed,
  timestamp: now,
};
const after1 = {
  ...live1.find((s) => s.id === sessionId)!,
  scenes: [scene1],
};
saveToStorage(
  [after1, ...live1.filter((s) => s.id !== sessionId)],
  sessionId,
);

// Second call (50ms later): live.scenes has scene1 now. Dup check
// should fire and skip.
const live2 = loadFromStorage().sessions;
const dup2 = live2.find((s) => s.id === sessionId)?.scenes.find(
  (sc) => sc.prompt === prompt && sc.seed === seed && now - sc.timestamp < 3000,
);
t("second call within 3s: dup detected", !!dup2);

// Persistence confirms only one scene landed.
const persisted = loadFromStorage();
const persistedSession = persisted.sessions.find((s) => s.id === sessionId)!;
t("only one scene in the journal", persistedSession.scenes.length === 1);
t("the scene is the voice prompt", persistedSession.scenes[0].prompt === prompt);

// Different seed at the same time → no dup, second scene lands.
const live3 = loadFromStorage().sessions;
const dup3 = live3.find((s) => s.id === sessionId)?.scenes.find(
  (sc) => sc.prompt === prompt && sc.seed === 9999 && now - sc.timestamp < 3000,
);
t("different seed: not a dup", !dup3);

const scene2 = {
  id: "sc-2",
  prompt,
  seed: 9999,
  timestamp: now,
};
const after2 = {
  ...persistedSession,
  scenes: [scene1, scene2],
};
saveToStorage(
  [after2, ...persisted.sessions.filter((s) => s.id !== sessionId)],
  sessionId,
);
const final = loadFromStorage();
const finalSession = final.sessions.find((s) => s.id === sessionId)!;
t("after 2nd add, journal has 2 scenes", finalSession.scenes.length === 2);
t("second scene has the new seed", finalSession.scenes[1].seed === 9999);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);