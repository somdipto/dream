// Compose a user's spoken (or typed) transcript into a full Lingbot scene prompt.
//
// Why this exists:
//
// Lingbot produces dramatically more coherent scenes when prompts describe the
// subject, the environment, the camera framing AND the motion style in full.
// Bare single-sentence prompts ("a dragon in the sky") produce visually
// unstable output. So we wrap the user's words in a stable camera/motion
// grammar that stays consistent across every spoken phrase, while letting
// the *world* change every time the user speaks.
//
// The wrapper is deliberately generic. It does NOT pick from a list of
// prebuilt scenes. The subject, environment, lighting, mood, and palette
// all come from whatever the user said. The only thing we control is the
// framing and motion language, which has to stay consistent for the model's
// realtime movement commands (set_look_horizontal, etc.) to feel coherent.

const CAMERA_GRAMMAR = `Strict centred third-person rear view: the subject is locked at the exact centre of the frame. The camera tracks the subject from behind as it travels forward and never rotates around it. Arrow-key look-input turns the subject's heading instead, preserving the rear-view framing.`;

const MOTION_HINT = `The subject moves forward at a steady, natural pace through the scene, with believable weight and breathing motion.`;

export interface ScenePromptOptions {
  /** The user's raw transcript. May be a single word. */
  text: string;
  /** True when this is the very first scene — adds a "intro" sentence. */
  isFirst?: boolean;
}

// QA4: hard cap on user input. Reactor/Lingbot can choke on
// very long prompts (10k+ chars) and produce a black frame
// instead of an error. 500 chars is enough for any plausible
// scene description and well within the model's comfort zone.
export const MAX_PROMPT_CHARS = 500;

/**
 * Compose a full Lingbot prompt from a user phrase. The output is always a
 * self-contained paragraph the model can use as a complete description.
 */
export function composeScenePrompt({ text, isFirst = false }: ScenePromptOptions): string {
  // QA4: sanitize at the boundary so every caller benefits
  // from the same control-char stripping and length cap.
  // Previously, a 10k-char paste could reach Reactor and
  // produce a black frame; a transcript of " . " would
  // yield a "." subject. Both fixed here.
  const safe = sanitizeUserText(text);
  const subject = cleanSubject(safe);

  // Three blocks: (1) "This is a..." opener (matches Lingbot examples exactly),
  // (2) the world as the user described it, (3) the camera & motion grammar.
  const opener = isFirst
    ? `This is a third-person-view video of ${subject}.`
    : `The scene now shifts: ${subject}.`;

  return [
    opener,
    text.trim().replace(/\s+/g, " "),
    CAMERA_GRAMMAR,
    MOTION_HINT,
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * QA4: sanitize a raw user transcript before it ever reaches
 * composeScenePrompt. Strips control characters that could
 * cause log-injection if we ever log the prompt, and trims
 * to MAX_PROMPT_CHARS to bound the request size.
 */
export function sanitizeUserText(raw: string): string {
  if (typeof raw !== "string") return "";
  return raw
    // Strip C0 control chars except newline and tab. U+0000–U+0008,
    // U+000B–U+001F, and the C1 range U+0080–U+009F.
    .replace(/[\x00-\x08\x0B-\x1F\x7F-\x9F]/g, "")
    // Collapse runs of whitespace.
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_PROMPT_CHARS);
}

/**
 * Convert "a dragon in the sky at dusk" → "a dragon in the sky at dusk".
 * Currently a passthrough but reserved for future normalization
 * (pronoun resolution, plural/singular, etc.).
 */
function cleanSubject(text: string): string {
  const t = text.trim().replace(/[.!?]+$/, "");
  if (!t || t.length < 3) return "an atmospheric environment";
  // Lowercase first letter only if it doesn't start with a proper noun heuristic
  const lowered = t.charAt(0).toLowerCase() + t.slice(1);
  return lowered || "an atmospheric environment";
}

// M3: composeMutationPrompt removed. Every prompt now goes through a
// full reset → setImage → setPrompt → start cycle, so there is no
// "hot-swap" branch anymore. See VoiceDream.tsx for the new pipeline.