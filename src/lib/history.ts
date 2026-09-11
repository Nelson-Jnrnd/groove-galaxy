/**
 * Reconstructing an account's listening history from Last.fm's weekly charts.
 *
 * `user.getTopArtists` only knows rolling windows — "last 3 months" — so it
 * cannot answer "what did 2019 sound like". The weekly chart API can: it
 * hands back one artist chart per week, all the way back to the account's
 * first scrobble. This module turns that stream of weeks into the calendar
 * frames the timeline moves through, and nothing here knows anything about
 * canvases, layouts or animation (§51).
 *
 * The one honesty problem is that weeks straddle calendar boundaries, and a
 * weekly total cannot truthfully be split across the days inside it. So each
 * week is attributed whole, to the calendar period containing its midpoint
 * (TE-REQ-1). It is deterministic, it is symmetric — a week gives away as
 * often as it takes — and it is disclosed in the method note (TE-REQ-2).
 */
import * as api from "./lastfm.ts";
import type { ChartWeek, TopArtist } from "./lastfm.ts";

export type Resolution = "year" | "month";

export interface TemporalFrame {
  /** "2024", or "2024-08" once monthly resolution ships (TE-REQ-4). */
  id: string;
  label: string;
  /** Unix seconds spanned by the weeks actually attributed here. */
  from: number;
  to: number;
  totalPlays: number;
  /** Artist name → plays attributed to this frame. */
  artists: Map<string, number>;
  /** Artist name → their Last.fm page, so the detail panel can still link. */
  urls: Map<string, string>;
  /** Every week attributed here was fetched successfully (TE-REQ-36). */
  complete: boolean;
  weeks: number;
  /** Weeks belonging to this frame whose chart could not be read. */
  missing: number;
}

/** The midpoint of a chart interval, in unix seconds. */
export const midpoint = (week: ChartWeek): number =>
  Math.floor((week.from + week.to) / 2);

/**
 * Which calendar frame a week belongs to: the one containing its midpoint.
 *
 * A chart covering 29 Dec 2024 → 5 Jan 2025 has its midpoint on 1 Jan, so
 * the whole week counts as 2025.
 */
export function frameIdOf(week: ChartWeek, resolution: Resolution): string {
  const at = new Date(midpoint(week) * 1000);
  const year = at.getUTCFullYear();
  if (resolution === "year") return String(year);
  return `${year}-${String(at.getUTCMonth() + 1).padStart(2, "0")}`;
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function frameLabel(id: string): string {
  const [year, month] = id.split("-");
  return month ? `${MONTHS[Number(month) - 1]} ${year}` : year;
}

/** Group the account's weeks into frames, oldest frame first. */
export function groupWeeks(
  weeks: ChartWeek[],
  resolution: Resolution,
): Map<string, ChartWeek[]> {
  const byFrame = new Map<string, ChartWeek[]>();
  for (const week of [...weeks].sort((a, b) => a.from - b.from)) {
    const id = frameIdOf(week, resolution);
    const bucket = byFrame.get(id);
    if (bucket) bucket.push(week);
    else byFrame.set(id, [week]);
  }
  return new Map([...byFrame].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
}

/** A week that was fetched, or one that failed and left a hole. */
export interface WeekChart {
  week: ChartWeek;
  artists: TopArtist[] | null;
}

/**
 * Fold a frame's weeks into one artist → plays table.
 *
 * Repeated appearances of an artist across the weeks add up, which is the
 * whole point: a year is a sum of its weeks. A week whose chart is missing
 * leaves the frame marked incomplete rather than silently short (TE-REQ-35 /
 * TE-REQ-36) — the numbers stay truthful about being partial.
 */
export function aggregateFrame(id: string, charts: WeekChart[]): TemporalFrame {
  const artists = new Map<string, number>();
  const urls = new Map<string, string>();
  let totalPlays = 0;
  let missing = 0;
  let from = Infinity;
  let to = -Infinity;

  for (const { week, artists: list } of charts) {
    from = Math.min(from, week.from);
    to = Math.max(to, week.to);
    if (!list) {
      missing++;
      continue;
    }
    for (const a of list) {
      if (!a.name || a.plays <= 0) continue;
      artists.set(a.name, (artists.get(a.name) || 0) + a.plays);
      if (a.url && !urls.has(a.name)) urls.set(a.name, a.url);
      totalPlays += a.plays;
    }
  }

  return {
    id,
    label: frameLabel(id),
    from: Number.isFinite(from) ? from : 0,
    to: Number.isFinite(to) ? to : 0,
    totalPlays,
    artists,
    urls,
    complete: missing === 0,
    weeks: charts.length,
    missing,
  };
}

/* ─── fetching, progressively ────────────────────────────────────────── */

export interface HistoryEvents {
  /** The account's frames are known — draw the timeline shell (§34.3). */
  onFrames?: (ids: string[]) => void;
  /** One frame's weekly charts have all been read (or failed). */
  onFrame?: (frame: TemporalFrame, loaded: number, total: number) => void;
}

/**
 * The order frames are fetched in: the one being looked at, then outwards
 * from it, so the visitor can read the selected year while the rest of the
 * decade is still arriving (§34).
 */
export function loadOrder(ids: string[], selected: string): string[] {
  const start = Math.max(ids.indexOf(selected), 0);
  const order: string[] = [];
  for (let d = 0; d < ids.length; d++) {
    if (d === 0) order.push(ids[start]);
    else {
      if (ids[start + d]) order.push(ids[start + d]);
      if (ids[start - d]) order.push(ids[start - d]);
    }
  }
  return order;
}

/**
 * Read an account's whole history at the given resolution.
 *
 * Only ever called once the visitor has explicitly entered temporal mode
 * (TE-REQ-20): this is a request per week of the account's life, and no
 * ordinary map load has any business spending that.
 */
export async function loadHistory(
  user: string,
  {
    resolution = "year" as Resolution,
    selected,
    events = {} as HistoryEvents,
    cancelled = () => false,
  }: {
    resolution?: Resolution;
    selected?: string;
    events?: HistoryEvents;
    cancelled?: () => boolean;
  } = {},
): Promise<Map<string, TemporalFrame>> {
  const weeks = await api.weeklyChartList(user);
  const grouped = groupWeeks(weeks, resolution);
  const ids = [...grouped.keys()];
  events.onFrames?.(ids);

  const frames = new Map<string, TemporalFrame>();
  const order = loadOrder(ids, selected && grouped.has(selected) ? selected : ids[ids.length - 1]);
  let loaded = 0;

  for (const id of order) {
    if (cancelled()) break;
    const charts = await Promise.all(
      grouped.get(id)!.map(async (week) => ({
        week,
        artists: await api
          .weeklyArtistChart(user, week)
          // One missing week is a hole in one frame, not the end of the
          // timeline (TE-REQ-35).
          .catch(() => null),
      })),
    );
    const frame = aggregateFrame(id, charts);
    frames.set(id, frame);
    loaded++;
    events.onFrame?.(frame, loaded, order.length);
  }

  return new Map([...frames].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
}
