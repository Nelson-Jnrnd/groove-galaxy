/**
 * What the URL says the page is showing.
 *
 * A map's identity is its account plus either a rolling window
 * (`?user=X&period=3month`) or a historical frame
 * (`?user=X&view=timeline&year=2024`). The two are mutually exclusive views
 * of the same account (§41), so one small parser owns the whole question and
 * both the map and the timeline read the answer rather than each guessing at
 * the query string.
 */
import { DEFAULT_PERIOD, parsePeriod, type Period } from "./period.ts";

export interface ViewState {
  user: string;
  /** The rolling window; kept even in timeline mode, so leaving restores it. */
  period: Period;
  mode: "map" | "timeline";
  /** Selected historical frame, e.g. "2024". Null means "pick a sensible one". */
  frame: string | null;
}

/** Frames are years for now; the id shape leaves room for "2024-08" (TE-REQ-4). */
const YEAR = /^\d{4}$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export function isFrameId(value: string): boolean {
  return YEAR.test(value) || MONTH.test(value);
}

export function parseView(search: string, defaultUser: string): ViewState {
  const params = new URLSearchParams(search);
  const user = (params.get("user") || "").trim() || defaultUser;
  const period = parsePeriod(params.get("period"));
  const timeline = (params.get("view") || "").trim().toLowerCase() === "timeline";
  if (!timeline) return { user, period, mode: "map", frame: null };

  // `month` is accepted ahead of monthly resolution shipping, so a link made
  // later still opens the right account rather than 404-ing on a parameter.
  const raw = (params.get("year") || params.get("month") || "").trim();
  return {
    user,
    period,
    mode: "timeline",
    frame: raw && isFrameId(raw) ? raw : null,
  };
}

/**
 * The canonical query string for a state. Defaults are omitted so the
 * all-time map keeps the plain `?user=` URL it has always had, and playback
 * never appears at all (TE-REQ-27).
 */
export function toSearch(state: ViewState): string {
  const params = new URLSearchParams();
  params.set("user", state.user);
  if (state.mode === "timeline") {
    params.set("view", "timeline");
    if (state.frame) {
      params.set(state.frame.includes("-") ? "month" : "year", state.frame);
    }
    // The rolling window is remembered so that leaving the timeline returns
    // to the map the visitor came from rather than resetting to all time.
    if (state.period !== DEFAULT_PERIOD) params.set("period", state.period);
  } else if (state.period !== DEFAULT_PERIOD) {
    params.set("period", state.period);
  }
  return `?${params.toString()}`;
}

/** Two states describe the same map — nothing to rebuild. */
export function sameView(a: ViewState, b: ViewState): boolean {
  return (
    a.user.toLowerCase() === b.user.toLowerCase() &&
    a.mode === b.mode &&
    (a.mode === "timeline"
      ? a.frame === b.frame
      : a.period === b.period)
  );
}
