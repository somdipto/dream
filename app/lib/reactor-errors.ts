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
  if (m.includes("rate limit") || m.includes("429") || m.includes("too many requests")) {
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
  if (m.includes("401") || m.includes("unauthorized") || m.includes("api key")) {
    return { ...KNOWN.auth };
  }
  if (m.includes("503") || m.includes("service unavailable") || m.includes("temporarily unavailable")) {
    return { ...KNOWN.service_unavailable };
  }
  return {
    reason: "unknown",
    title: "Something went wrong",
    body: "Couldn't reach Reactor. Try again in a moment — if it keeps failing, share the time of the failure so we can investigate.",
    ctaLabel: "Try again",
  };
}