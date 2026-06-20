// Surprise prompts for the "🎲 Surprise me" button.
//
// Each prompt is hand-tuned to push LingBot into an interesting
// corner of its output space: a submarine view, a clock striking
// midnight, a forgotten cassette. Bias toward visual specificity
// over generic adjectives — "a thunderstorm viewed from a glass
// submarine" is better than "a cool storm" because it gives the
// model concrete geometry, lighting, and subject matter.
//
// Re-roll: the user can keep tapping the button until something
// catches their eye. The list is shuffled client-side per session.

export const SURPRISE_PROMPTS: string[] = [
  "a glass submarine drifting through a bioluminescent deep-sea trench, soft cyan glow, jellyfish drifting past the porthole",
  "a Victorian reading room at the exact moment a grandfather clock strikes midnight, candlelight flickering, dust suspended in the air",
  "a forgotten cassette tape on a shag-carpet floor in 1987, late-afternoon sun through venetian blinds, dust motes, warm amber tones",
  "a Tokyo rooftop garden at 3am after the rain, neon reflecting in puddles, a single cat sleeping on a wet bench",
  "an abandoned space station observation deck, Earthrise through a cracked window, emergency lighting pulsing red, plants growing wild through the floor grates",
  "a beach bonfire at low tide, bioluminescent plankton glowing in the receding waves, the Milky Way directly overhead",
  "a Kyoto temple corridor during a sudden summer rain, wooden floors dark with water, paper lanterns swinging, a single monk running for cover",
  "a derelict ballroom with one spotlight still working, a single white shoe on the dance floor, moths circling the bulb",
  "a 1970s science classroom at night, chalk equations still on the board, a half-eaten apple on the desk, the skeleton model in the corner lit by a streetlight through the window",
  "an Alpine cable car suspended in a cloud, the operator asleep at the controls, frozen fog on the glass, the lights of a village far below",
  "a sandstorm rolling through a half-buried retro-futurist city, glass pyramids jutting from the dunes, one antenna still blinking",
  "a child's bedroom on the night before the first day of school, packed backpack by the door, glow-in-the-dark stars on the ceiling, the hallway light under the door",
  "a coral reef at the exact moment a sea turtle surfaces for air, refracted sunbeams through the waves overhead, parrotfish scattering",
  "a Parisian café terrace at 7am, the waiter setting out chairs, a single espresso on a marble table, the Eiffel Tower in soft mist",
  "an underground mushroom forest glowing in iridescent blues and greens, water droplets on every surface, the sound of dripping echoing",
  "the cockpit of a paper airplane mid-glide, patchwork of maps and stamps on the wings, a city skyline in the distance",
  "a 1980s arcade at 2am, every cabinet still glowing, an unfinished Pac-Man game on screen, no one there",
  "a glacier cave at the moment the sun hits the ice, electric blues and teals refracting through the crystal, meltwater dripping in slow motion",
  "a New Orleans jazz funeral procession crossing a foggy bridge, second-line dancers in white suits, purple and gold streamers",
  "a desert observatory dome opening at dawn, the telescope's first alignment, the sky still full of stars fading into amber",
  "a stilt house over a flooded mangrove forest at high tide, a child reading by lantern light on the porch, reflections of fireflies in the water",
  "a laundromat at midnight, every dryer tumbling in different rhythms, fluorescent lights humming, one person asleep on a bench",
  "a Roman aqueduct at the moment a small bird lands on the highest arch, sunset behind, the valley below in long shadow",
  "a 1960s drive-in theater with one car remaining, the film flickering on the screen, moths between the projector and the audience",
  "a greenhouse at the moment a hummingbird enters, dozens of tropical plants in soft mist, a single red flower in focus",
  "an Antarctic research station during the long night, aurora australis filling the sky, a snowcat parked outside, warm yellow light from every window",
  "a forgotten lighthouse in the fog, the lamp still rotating, the keeper's chair empty, the logbook open to today's date",
  "a Berlin U-Bahn station at 4am, a single cello player in the tunnel, tile mosaics overhead, the last train approaching",
  "a single-cup coffee machine mid-brew, the kitchen dim, the view through the window: a city at dawn",
  "a grandmother's attic during a thunderstorm, an open trunk of old letters, lightning flashing through a round window, the scent of cedar",
  "a flower shop at 5am before opening, the owner arranging tulips in a copper bucket, delivery van backing up outside",
  "an art deco hotel rooftop pool in Havana at sunset, the city spread out below, a mojito sweating on the pool edge",
  "a high-altitude research balloon gondola at 30,000 feet, the curvature of the earth visible, the pilot's notebook open to a sketch of the horizon",
  "a 1990s internet café in Seoul at midnight, rows of beige CRT monitors, a kid playing StarCraft, the hum of every PC",
  "a kitchen at the moment bread comes out of the oven, morning light, steam rising, a child's drawing on the fridge",
];

// Per-call randomized pick. Uses a small seeded LCG so the
// SAME call site (e.g. the reroll button) always gets the
// same next pick within a session — surprising for the user
// but deterministic enough for tests to pin.
let __lcg = 0x12345678;
function lcg(): number {
  __lcg = (Math.imul(__lcg, 1664525) + 1013904223) >>> 0;
  return __lcg / 0xffffffff;
}
export function pickSurprisePrompt(): string {
  const i = Math.floor(lcg() * SURPRISE_PROMPTS.length);
  return SURPRISE_PROMPTS[i];
}

// Test helper: reset the RNG so test runs are deterministic.
export function _resetSurpriseRng(seed = 0x12345678): void {
  __lcg = seed >>> 0;
}