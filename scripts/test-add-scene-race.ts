// QA2: verify the addScene dedupe-race fix.

(() => {
let pass = 0;
let fail = 0;
function t(name: string, cond: boolean) {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name}`); fail++; }
}

console.log("addScene race fix");

function applyAddScene(
  prev: any[],
  activeId: string | null,
  scene: { id: string; prompt: string; seed: number; timestamp: number },
) {
  const target = prev.find((s) => s.id === activeId);
  if (target) {
    const last = target.scenes[target.scenes.length - 1];
    if (
      last &&
      last.prompt === scene.prompt &&
      last.seed === scene.seed &&
      scene.timestamp - last.timestamp < 3000
    ) {
      return prev;
    }
  }
  if (!target) {
    const newS = {
      id: `s-${scene.timestamp}`,
      title: scene.prompt,
      scenes: [scene],
      updatedAt: scene.timestamp,
    };
    return [newS, ...prev];
  }
  return prev.map((s) => {
    if (s.id !== activeId) return s;
    return { ...s, scenes: [...s.scenes, scene], updatedAt: scene.timestamp };
  });
}

const t0 = 1000;
const mk = (p: string, seed: number, ts: number) => ({ id: `sc-${ts}-${Math.random()}`, prompt: p, seed, timestamp: ts });

// Test 1: no active session, first add creates one and uses the
// returned id for subsequent calls.
let s: any[] = [];
s = applyAddScene(s, "active-1", mk("hello", 1, t0));
t("first add creates session", s.length === 1 && s[0].scenes.length === 1);
// Use the id that was just created.
const id = s[0].id;

// Test 2: back-to-back race within 3s.
s = applyAddScene(s, id, mk("hello", 1, t0 + 50));
t("back-to-back same prompt+seed deduped", s[0].scenes.length === 1);

// Test 3: different seed → both land.
s = applyAddScene(s, id, mk("hello", 2, t0 + 100));
t("different seed passes through", s[0].scenes.length === 2);

// Test 4: same prompt + seed, > 3s later → passes through.
s = applyAddScene(s, id, mk("hello", 2, t0 + 5000));
t("older than 3s passes through", s[0].scenes.length === 3);

// Test 5: same prompt + different seed, immediate.
s = applyAddScene(s, id, mk("world", 1, t0 + 50));
t("different prompt passes through", s[0].scenes.length === 4);

// Test 6: against an existing empty session.
s = [{ id: "preexisting", title: "p", scenes: [], updatedAt: 0 }];
s = applyAddScene(s, "preexisting", mk("first", 1, t0 + 100));
t("existing empty session receives scene", s[0].scenes.length === 1);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
})();
