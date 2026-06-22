// The user's text is the prompt. That's it.
//
// Earlier this file wrapped the user's transcript in a stable camera/motion
// grammar (~420 chars of "Strict centred third-person rear view..." boilerplate)
// on the assumption that the model needed framing cues to be coherent. In
// practice that wrapper did three things the user never asked for:
//
//   1. Prepended "This is a third-person-view video of X." or "The scene now
//      shifts: X." — both sentences the user never wrote.
//   2. Appended CAMERA_GRAMMAR (~290 chars), which the model already enforces
//      natively for navigable worlds (arrow keys, WASD, etc.). Sending it in
//      the prompt was double-tagging the same instruction.
//   3. Appended MOTION_HINT (~130 chars), which again the model already does.
//
// Net effect: "a misty pine forest" reached Reactor as
//   "This is a third-person-view video of a misty pine forest. Strict centred
//    third-person rear view: … The subject moves forward at a steady, natural
//    pace through the scene, with believable weight and breathing motion."
// — five words of user intent buried in 420 chars of boilerplate. The model
// would frequently produce a black frame or a generic empty world because the
// framing/motion grammar overrode the user's scene description.
//
// The user's explicit request: "the system prompt should be exactly what the
// user is giving you." That is what this file does now. `composeScenePrompt`
// is a thin passthrough that runs the user's text through `sanitizeUserText`
// (control-char strip + 500-char cap) and returns it unchanged.

export interface ScenePromptOptions {
  /** The user's raw transcript. May be a single word. */
  text: string;
  /** Reserved for future use. The wrapper used to add an opener for the first
   *  paint; that wrapper is gone. */
  isFirst?: boolean;
}

// QA4: hard cap on user input. Reactor/Lingbot can choke on
// very long prompts (10k+ chars) and produce a black frame
// instead of an error. 500 chars is enough for any plausible
// scene description and well within the model's comfort zone.
export const MAX_PROMPT_CHARS = 500;

/**
 * Compose a full Lingbot prompt from a user phrase. The output is the user's
 * text exactly as they wrote/spoke it, with control characters stripped and
 * capped at MAX_PROMPT_CHARS.
 */
export function composeScenePrompt({ text }: ScenePromptOptions): string {
  return sanitizeUserText(text);
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