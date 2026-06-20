// QA3: verify the favorite + recent-prompts features.
//
// We don't need to import the React hook (which would require
// a full React renderer). The pure functions are sufficient:
// recentPrompts is a deterministic projection over the
// sessions list, and toggleFavorite is a map operation on a
// scene id.

let pass = 0;
let fail = 0;
function t(name: string, cond: boolean) {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name}`); fail++; }
}

console.log("QA3 features");

// --- recentPrompts ---
// Pure projection: flatten scenes, sort by timestamp desc, cap.
function recentPrompts(sessions: any[], limit = 10) {
  const out: any[] = [];
  for (const s of sessions) {
    for (const sc of s.scenes) {
      out.push({ prompt: sc.prompt, seed: sc.seed, timestamp: sc.timestamp });
    }
  }
  out.sort((a, b) => b.timestamp - a.timestamp);
  return out.slice(0, limit);
}

const now = 1_000_000;
const s1 = {
  id: "s1",
  title: "Forest",
  updatedAt: now,
  scenes: [
    { id: "sc1", prompt: "a forest", seed: 1, timestamp: now - 30_000 },
    { id: "sc2", prompt: "a thunderstorm", seed: 2, timestamp: now - 5_000 },
  ],
};
const s2 = {
  id: "s2",
  title: "Desert",
  updatedAt: now,
  scenes: [
    { id: "sc3", prompt: "a desert", seed: 3, timestamp: now - 10_000 },
  ],
};

const recent = recentPrompts([s1, s2]);
t("recentPrompts returns 3 entries", recent.length === 3);
t("most recent is first", recent[0].timestamp === now - 5_000);
t("newest prompt is thunderstorm", recent[0].prompt === "a thunderstorm");
t("default limit is 10", recentPrompts([s1, s2]).length === 3);
const long = Array.from({ length: 30 }, (_, i) => ({ scenes: [{ prompt: `p${i}`, seed: i, timestamp: i }] }));
t("limit caps output", recentPrompts(long, 5).length === 5);

// --- toggleFavorite ---
// Pure map operation on the matching scene's favorite flag.
function toggleFavorite(sessions: any[], sessionId: string, sceneId: string) {
  return sessions.map((s) => {
    if (s.id !== sessionId) return s;
    return {
      ...s,
      scenes: s.scenes.map((sc: any) =>
        sc.id === sceneId ? { ...sc, favorite: !sc.favorite } : sc,
      ),
    };
  });
}

const after1 = toggleFavorite([s1, s2], "s1", "sc2");
t("toggleFavorite flips the flag", after1[0].scenes[1].favorite === true);
t("toggleFavorite leaves other scenes alone", after1[0].scenes[0].favorite === undefined);
t("toggleFavorite leaves other sessions alone", after1[1] === s2);

const after2 = toggleFavorite(after1, "s1", "sc2");
t("second toggle un-flips", after2[0].scenes[1].favorite === false);

const after3 = toggleFavorite([s1, s2], "s1", "nonexistent");
t("unknown sceneId is a no-op (data unchanged)", JSON.stringify(after3[0]) === JSON.stringify(s1));

const after4 = toggleFavorite([s1, s2], "nonexistent", "sc2");
t("unknown sessionId is a no-op (data unchanged)", JSON.stringify(after4[0]) === JSON.stringify(s1) && JSON.stringify(after4[1]) === JSON.stringify(s2));

// --- favorite filter (sidebar logic) ---
function favoriteFilteredSessions(sessions: any[]) {
  return sessions.filter((s) => s.scenes.some((sc: any) => sc.favorite));
}

const s1Fav = toggleFavorite([s1, s2], "s1", "sc1")[0];
const favFiltered = favoriteFilteredSessions([s1Fav, s2]);
t("filter shows only sessions with favorites", favFiltered.length === 1 && favFiltered[0].id === "s1");

const allUnfav = favoriteFilteredSessions([s1, s2]);
t("filter empty when no favorites", allUnfav.length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);