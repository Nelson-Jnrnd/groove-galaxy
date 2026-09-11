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
  /**
   * The artist whose System is open, if any (EXP §17).
   *
   * An artist *name*, not an id: cluster numbers and bubble ids are
   * artefacts of one particular build of one particular map, whereas a name
   * still means the same artist after the map is rebuilt, or on somebody
   * else's Galaxy entirely. Exploration is a layer over the map named here,
   * not a separate mode — the Galaxy stays built underneath it, which is
   * what lets `Return to Galaxy` put the visitor back where they were.
   */
  explore: string | null;
}

/**
 * Long enough for any real artist name, short enough that a hand-written
 * URL can't push an essay into the page (§24: malformed exploration
 * parameters degrade to the plain Galaxy).
 */
const MAX_EXPLORE = 120;

function parseExplore(raw: string | null): string | null {
  const name = (raw || "").trim().replace(/\s+/g, " ");
  if (!name || name.length > MAX_EXPLORE) return null;
  // Control characters are never part of a name and would land in the DOM.
  if (/[\u0000-\u001f\u007f]/.test(name)) return null;
  return name;
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
  if (!timeline) {
    return {
      user,
      period,
      mode: "map",
      frame: null,
      explore: parseExplore(params.get("explore")),
    };
  }

  // `month` is accepted ahead of monthly resolution shipping, so a link made
  // later still opens the right account rather than 404-ing on a parameter.
  const raw = (params.get("year") || params.get("month") || "").trim();
  return {
    user,
    period,
    mode: "timeline",
    frame: raw && isFrameId(raw) ? raw : null,
    // §19 — exploration runs from rolling-period Galaxies only, so the
    // parameter is dropped rather than half-honoured in a historical frame.
    explore: null,
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
  } else {
    if (state.period !== DEFAULT_PERIOD) params.set("period", state.period);
    if (state.explore) params.set("explore", state.explore);
  }
  return `?${params.toString()}`;
}

/**
 * Two states describe the same map — nothing to rebuild.
 *
 * Deliberately blind to `explore`: travelling between Systems changes the
 * URL and the history entry, but the Galaxy underneath is the same one and
 * must not be torn down and refetched to show a different neighbourhood.
 */
export function sameView(a: ViewState, b: ViewState): boolean {
  return (
    a.user.toLowerCase() === b.user.toLowerCase() &&
    a.mode === b.mode &&
    (a.mode === "timeline"
      ? a.frame === b.frame
      : a.period === b.period)
  );
}
