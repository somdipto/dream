// Maps raw Reactor SDK error messages to typed user-facing reasons.
//
// Today the SDK just surfaces whatever fetch rejected with — a
// stringified JSON blob like:
//   "Failed to create session: 402 {\"error\":\"credits_depleted\",
//    \"message\":\"Your credits have been depleted...\"}"
// Showing that raw to the user is hostile (they can't act on it).
// This module classifies it into a small enum + a short message so
// the UI can render a friendly screen with the right CTA.

export type ReactorErrorReason =
  | "credits_depleted"
  | "rate_limited"
  | "network"
  | "auth"
  | "service_unavailable"
  | "unknown";

export interface ClassifiedReactorError {
  reason: ReactorErrorReason;
  /** Short headline shown in the error screen. */
  title: string;
  /** One-sentence body explaining what happened. */
  body: string;
  /** CTA label, if there's a recoverable action. */
  ctaLabel?: string;
  /** CTA href, if there's a recoverable action. */
  ctaHref?: string;
}

const KNOWN: Record<Exclude<ReactorErrorReason, "unknown">, ClassifiedReactorError> = {
  credits_depleted: {
    reason: "credits_depleted",
    title: "You're out of credits",
    body: "Reactor ran out of credits on this account. Add credits and we'll pick up where you left off — your saved dreams are still here.",
    ctaLabel: "Add credits",
    ctaHref: "https://reactor.inc/dashboard",
  },
  rate_limited: {
    reason: "rate_limited",
    title: "Too many requests",
    body: "We're rate-limited at the moment. Wait a few seconds and try again.",
    ctaLabel: "Try again",
  },
  network: {
    reason: "network",
    title: "Can't reach Reactor",
    body: "Your network connection seems flaky. Check Wi-Fi or cellular and try again.",
    ctaLabel: "Try again",
  },
  auth: {
    reason: "auth",
    title: "API key rejected",
    body: "The server didn't accept the API key. This is a configuration issue, not something you can fix from here — but retrying sometimes clears it.",
    ctaLabel: "Try again",
  },
  service_unavailable: {
    reason: "service_unavailable",
    title: "Reactor is temporarily unavailable",
    body: "The Reactor service is having a moment. Try again in a minute — your saved dreams are safe.",
    ctaLabel: "Try again",
  },
};

export function classifyReactorError(message: string | null | undefined): ClassifiedReactorError {
  if (!message) {
    return { ...KNOWN.service_unavailable };
  }
  const m = message.toLowerCase();
  // Order matters: most specific to least.
  if (m.includes("credits_depleted") || m.includes("credits have been depleted")) {
    return { ...KNOWN.credits_depleted };
  }
  if (
    m.includes("rate limit") ||
    m.includes("too many requests") ||
    // QA16: was `m.includes("429")` — matched the substring anywhere
    // (a $429 charge, a 1429-line error). Word boundary alone is
    // not enough because `$429.00` has a boundary between `$` and
    // `4` and between `9` and `.` — the literal "429" still matches.
    // Match the canonical HTTP status-code prefixes that the SDK /
    // fetch layer actually emit: "429 too many requests",
    // "status: 429", "http 429", "code 429", etc. Plain "429" alone
    // (e.g. a billing line) doesn't carry the standard prefix and
    // should NOT route to rate-limited.
    /\b(?:http|status|code)\s*[:=]?\s*429\b/.test(m) ||
    /\b429\s+too many requests\b/.test(m)
  ) {
    return { ...KNOWN.rate_limited };
  }
  if (m.includes("failed to fetch") || m.includes("networkerror") || m.includes("econn")) {
    return { ...KNOWN.network };
  }
  // M9.7: the server's key-pool returns 503 with these exact messages
  // when every configured key is parked. Check BEFORE the auth
  // branch — the message contains the substring "api keys" which
  // would otherwise match the auth check below and misroute a
  // pool-exhaustion to "API key rejected" (audit bug: classifier
  // substring match was too greedy).
  if (m.includes("all api keys are temporarily exhausted") || m.includes("all api keys failed")) {
    return { ...KNOWN.service_unavailable };
  }
  // QA16: same canonical-prefix fix — `m.includes("401")` matched
  // the substring anywhere (a 401-line message, a $401 invoice).
  // Match the canonical HTTP status-code prefixes that the SDK /
  // fetch layer actually emit.
  //
  // QA16/R3: the previous `m.includes("api key")` branch matched
  // any error message that mentioned "api key" as a substring,
  // including billing / usage messages that the upstream service
  // prepends with "api key quota" and a generic 4xx whose body
  // contains the words "api key required". Those are NOT auth
  // failures — they are quota or 4xx-class errors. We now require
  // a stronger signal: the canonical "rejected / invalid / not
  // authorized / unauthorized" form, which is what the SDK and
  // the Reactor service actually emit on a real key rejection.
  if (
    /\b(?:http|status|code)\s*[:=]?\s*401\b/.test(m) ||
    /\b(?:http|status|code)\s*[:=]?\s*403\b/.test(m) ||
    m.includes("unauthorized") ||
    m.includes("not authorized") ||
    m.includes("api key rejected") ||
    m.includes("api_key_rejected") ||
    m.includes("api key invalid") ||
    m.includes("api_key_invalid") ||
    m.includes("invalid api key")
  ) {
    return { ...KNOWN.auth };
  }
  if (
    /\b(?:http|status|code)\s*[:=]?\s*503\b/.test(m) ||
    m.includes("service unavailable") ||
    m.includes("temporarily unavailable")
  ) {
    return { ...KNOWN.service_unavailable };
  }
  return {
    reason: "unknown",
    title: "Something went wrong",
    body: "Couldn't reach Reactor. Try again in a moment — if it keeps failing, share the time of the failure so we can investigate.",
    ctaLabel: "Try again",
  };
}

/**
 * QA15: identifies errors that the user must resolve
 * themselves (typically via a CTA on the error screen).
 * Auto-retry should be SKIPPED for these — a silent retry
 * would burn another attempt without the user doing
 * anything to fix the underlying problem.
 */
export function isClassifiedTerminal(
  reason: ReactorErrorReason,
): boolean {
  return (
    reason === "credits_depleted" ||
    reason === "auth" ||
    reason === "rate_limited" ||
    reason === "service_unavailable"
  );
}