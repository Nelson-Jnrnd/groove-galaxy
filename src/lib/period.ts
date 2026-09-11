/**
 * The rolling listening windows Last.fm's `user.getTopArtists` supports.
 *
 * One place decides three things that must never drift apart: what the API
 * is asked for, what the visitor is told they are looking at, and how thin a
 * play count may be before an artist is left off the map. Twenty-five plays
 * is a sensible floor across a whole history and an absurd one across seven
 * days, so the floor travels with the period (TP-REQ-13).
 */

export type Period =
  | "7day"
  | "1month"
  | "3month"
  | "6month"
  | "12month"
  | "overall";

export interface PeriodInfo {
  value: Period;
  /** What the control shows: "3M". Never the API's own name (TP-REQ-2). */
  short: string;
  /** What a settings-style list would show: "3 months". */
  label: string;
  /** How a sentence refers to the window: "the last 3 months". */
  phrase: string;
  /** Trailing qualifier for a play count: "47 plays · last 3 months". */
  suffix: string;
  /** Minimum plays for an artist to earn a bubble in this window. */
  minPlays: number;
}

/** Ordered as the control renders them, shortest window first. */
export const PERIODS: PeriodInfo[] = [
  {
    value: "7day",
    short: "7D",
    label: "7 days",
    phrase: "the last 7 days",
    suffix: "last 7 days",
    minPlays: 2,
  },
  {
    value: "1month",
    short: "1M",
    label: "1 month",
    phrase: "the last month",
    suffix: "last month",
    minPlays: 3,
  },
  {
    value: "3month",
    short: "3M",
    label: "3 months",
    phrase: "the last 3 months",
    suffix: "last 3 months",
    minPlays: 5,
  },
  {
    value: "6month",
    short: "6M",
    label: "6 months",
    phrase: "the last 6 months",
    suffix: "last 6 months",
    minPlays: 8,
  },
  {
    value: "12month",
    short: "1Y",
    label: "12 months",
    phrase: "the last 12 months",
    suffix: "last 12 months",
    minPlays: 10,
  },
  {
    value: "overall",
    short: "ALL",
    label: "All time",
    phrase: "their whole history",
    suffix: "all time",
    minPlays: 25,
  },
];

/** TP-REQ-1 / TP-REQ-7 — the shape of the map every existing URL opens. */
export const DEFAULT_PERIOD: Period = "overall";

const BY_VALUE = new Map(PERIODS.map((p) => [p.value, p]));

export function isPeriod(value: unknown): value is Period {
  return typeof value === "string" && BY_VALUE.has(value as Period);
}

/** TP-REQ-9 — anything unknown or malformed is simply "all time". */
export function parsePeriod(raw: string | null | undefined): Period {
  const value = (raw || "").trim().toLowerCase();
  return isPeriod(value) ? value : DEFAULT_PERIOD;
}

export function periodInfo(period: Period): PeriodInfo {
  return BY_VALUE.get(period) || BY_VALUE.get(DEFAULT_PERIOD)!;
}

/**
 * TP-REQ-21 — the caption for a map of this window. Never worded so that a
 * windowed play count could be read as a lifetime one.
 */
export function describePeriod(
  period: Period,
  user: string,
  shown: number,
  totalScrobbledArtists: number,
): string {
  const info = periodInfo(period);
  const count = shown.toLocaleString("en-US");
  if (period === "overall") {
    return (
      `The ${count} artists ${user} has played most on Last.fm ` +
      `(minimum ${info.minPlays} plays), out of ` +
      `${totalScrobbledArtists.toLocaleString("en-US")} ever scrobbled.`
    );
  }
  return (
    `${count} artists ${user} played during ${info.phrase} on Last.fm ` +
    `(minimum ${info.minPlays} plays in that window). Bubble size is plays ` +
    `in ${info.phrase}, not lifetime plays.`
  );
}
