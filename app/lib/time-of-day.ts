// Time-of-day auto-shift helper.
//
// Returns the TimeVariant id that best matches the user's
// local clock, so the Director overlay can subtly shift the
// world's mood as the day progresses without the user having
// to touch a chip.
//
// Bands (rounded to the user's local hour):
//   05:00 - 07:59  → "dawn"
//   08:00 - 16:59  → "none"  (default — no extra suffix)
//   17:00 - 19:59  → "sunset"
//   20:00 - 04:59  → "night"
//
// We intentionally do NOT auto-pick "rain" — weather is too
// disruptive to swap in without the user's consent. The user
// can still pick rain manually.
//
// The function is pure (no side effects) so it can be called
// freely from any component or test.

export type TimeBand = "dawn" | "none" | "sunset" | "night";

/**
 * Compute the time band for a given Date (defaults to
 * now). Returns the band id and a human label.
 */
export function timeBandForHour(hour: number): TimeBand {
  if (hour >= 5 && hour < 8) return "dawn";
  if (hour >= 8 && hour < 17) return "none";
  if (hour >= 17 && hour < 20) return "sunset";
  return "night";
}

export function timeBandForNow(now: Date = new Date()): TimeBand {
  return timeBandForHour(now.getHours());
}

export function labelForBand(band: TimeBand): string {
  switch (band) {
    case "dawn": return "Dawn";
    case "none": return "Day";
    case "sunset": return "Golden hour";
    case "night": return "Night";
  }
}

/**
 * Map a TimeBand to the corresponding TimeVariant id. We
 * return "none" for the default band (no extra suffix) so
 * the Director overlay is invisible during the day — the
 * user only sees the cinema filter when it has an active
 * variant.
 */
export function variantIdForBand(band: TimeBand): string {
  switch (band) {
    case "dawn": return "dawn";
    case "none": return "none";
    case "sunset": return "sunset";
    case "night": return "night";
  }
}
