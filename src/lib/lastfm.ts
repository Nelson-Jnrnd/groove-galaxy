/**
 * Last.fm, from the browser.
 *
 * Every read goes through the cache first, so a second visit — or a second
 * account that happens to share artists with the first — costs no network at
 * all. Requests run through one shared pool so that the background work
 * (tags, cover art) can never starve the thing the map is waiting on.
 */
import * as cache from "./cache.ts";

const ENDPOINT = "https://ws.audioscrobbler.com/2.0/";

/** Last.fm serves this image hash when there is no real art. */
export const PLACEHOLDER = "2a96cbd8b46e442fc41c2b86b821562f";

/**
 * The same public, read-only key the personal site's /music page ships. It
 * only ever sees public scrobble data, which is why it can live in the page
 * source at all.
 */
const API_KEY = "130e996340687500f9e282660628d30f";

/**
 * Measured against the API rather than guessed: it served 110 requests a
 * second without a single rate-limit response. This is deliberately well
 * under that — the map is built in about four seconds at this rate, and
 * there is nothing to buy by leaning harder on someone else's service.
 */
const CONCURRENCY = 20;

export interface TopArtist {
  name: string;
  plays: number;
  url: string;
}

export interface SimilarArtist {
  name: string;
  match: number;
}

/* ─── request pool ───────────────────────────────────────────────────── */

type Job = () => Promise<void>;
const pending: { job: Job; background: boolean }[] = [];
let active = 0;

function schedule<T>(run: () => Promise<T>, background: boolean): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    pending.push({
      background,
      job: () => run().then(resolve, reject),
    });
    pump();
  });
}

function pump() {
  while (active < CONCURRENCY && pending.length) {
    // Foreground work first: the map is not usable until similarity lands,
    // whereas tags and artwork only enrich a map that already works.
    let index = pending.findIndex((p) => !p.background);
    if (index === -1) index = 0;
    const { job } = pending.splice(index, 1)[0];
    active++;
    job().finally(() => {
      active--;
      pump();
    });
  }
}

/* ─── one API call ───────────────────────────────────────────────────── */

export class LastFmError extends Error {
  /** Last.fm's own error number, or the HTTP status when it didn't give one. */
  readonly code: number;

  constructor(message: string, code: number) {
    super(message);
    this.code = code;
  }
}

/** Last.fm's own code for "you are asking too fast". */
export const RATE_LIMITED = 29;
/** …and for "no such user", which is a normal thing for a visitor to hit. */
export const USER_NOT_FOUND = 6;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function call(
  params: Record<string, string>,
  background: boolean,
): Promise<Record<string, unknown>> {
  return schedule(async () => {
    const query = new URLSearchParams({
      ...params,
      api_key: API_KEY,
      format: "json",
    });

    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${ENDPOINT}?${query}`);

      // Last.fm reports application errors in the body, sometimes alongside
      // HTTP 200 and sometimes not, so the body is the authority and the
      // status is only the fallback.
      let body: Record<string, unknown> | null = null;
      try {
        body = (await res.json()) as Record<string, unknown>;
      } catch {
        body = null;
      }

      if (body && typeof body.error === "number") {
        // Being throttled is not a failure, it is a request to slow down.
        // Backing off beats failing a map the visitor is watching build.
        if (body.error === RATE_LIMITED && attempt < 4) {
          await sleep(700 * Math.pow(2, attempt));
          continue;
        }
        throw new LastFmError(String(body.message), body.error);
      }

      if (!res.ok) {
        if (res.status >= 500 && attempt < 3) {
          await sleep(500 * Math.pow(2, attempt));
          continue;
        }
        throw new LastFmError(`HTTP ${res.status}`, res.status);
      }
      if (!body) throw new LastFmError("Malformed response", 0);
      return body;
    }
  }, background);
}

/** Last.fm returns a bare object rather than an array for single results. */
function list<T>(raw: unknown): T[] {
  return Array.isArray(raw) ? (raw as T[]) : raw ? [raw as T] : [];
}

/** Read through the cache, falling back to the API and storing the result. */
async function cached<T>(
  kind: cache.Kind,
  id: string,
  fetcher: () => Promise<T>,
): Promise<T> {
  const hit = await cache.get<T>(kind, id);
  if (hit !== null) return hit;
  const value = await fetcher();
  void cache.set(kind, id, value);
  return value;
}

/* ─── the calls the map needs ────────────────────────────────────────── */

/** Someone's most-played artists. Works for any public account, no auth. */
export async function topArtists(
  user: string,
  period: string,
  limit: number,
): Promise<{ artists: TopArtist[]; total: number }> {
  return cached("top", `${user}|${period}|${limit}`, async () => {
    const data = await call(
      {
        method: "user.gettopartists",
        user,
        period,
        limit: String(Math.min(limit, 500)),
      },
      false,
    );
    const block = data.topartists as
      | { artist?: unknown; "@attr"?: { total?: string } }
      | undefined;
    if (!block) throw new LastFmError("Malformed response", 0);
    return {
      total: Number(block["@attr"]?.total) || 0,
      artists: list<{ name?: string; playcount?: string; url?: string }>(
        block.artist,
      )
        .map((a) => ({
          name: (a.name || "").trim(),
          plays: Number(a.playcount) || 0,
          url: a.url || "",
        }))
        .filter((a) => a.name),
    };
  });
}

/**
 * Artists Last.fm's listening data says are alike. Cached for a month and
 * shared across every map drawn in this browser — this is the same answer
 * whoever is asking, which is what makes the cache worth having.
 */
export async function similar(artist: string): Promise<SimilarArtist[]> {
  return cached("similar", artist, async () => {
    const data = await call(
      { method: "artist.getsimilar", artist, autocorrect: "1", limit: "100" },
      false,
    ).catch(() => null);
    if (!data) return [];
    const block = data.similarartists as { artist?: unknown } | undefined;
    return list<{ name?: string; match?: string }>(block?.artist)
      .map((a) => ({ name: (a.name || "").trim(), match: Number(a.match) }))
      .filter((a) => a.name && Number.isFinite(a.match))
      // Only the head is ever consulted, and storing a hundred names per
      // artist would bloat the cache for nothing.
      .slice(0, 40);
  });
}

/** Top tags, used only to name the emergent groups. Background work. */
export async function tags(artist: string): Promise<string[]> {
  return cached("tags", artist, async () => {
    const data = await call(
      { method: "artist.gettoptags", artist, autocorrect: "1" },
      true,
    ).catch(() => null);
    if (!data) return [];
    const block = data.toptags as { tag?: unknown } | undefined;
    return list<{ name?: string; count?: string }>(block?.tag)
      .filter((t) => Number(t.count) >= 15)
      .map((t) => (t.name || "").trim().toLowerCase())
      .filter(Boolean)
      .slice(0, 8);
  });
}

/**
 * An artist's visual identity. Last.fm stopped serving real artist portraits
 * — every one of them is now the placeholder hash — so their most-played
 * album cover stands in. Background work: the map is fine without it.
 */
export async function artwork(artist: string): Promise<string> {
  return cached("art", artist, async () => {
    const data = await call(
      {
        method: "artist.gettopalbums",
        artist,
        autocorrect: "1",
        limit: "6",
      },
      true,
    ).catch(() => null);
    if (!data) return "";
    const block = data.topalbums as { album?: unknown } | undefined;
    for (const album of list<{ image?: { "#text"?: string }[] }>(block?.album)) {
      const images = album.image;
      if (!Array.isArray(images)) continue;
      for (let i = images.length - 1; i >= 0; i--) {
        const url = images[i]?.["#text"];
        if (url && !url.includes(PLACEHOLDER)) return url;
      }
    }
    return "";
  });
}

/* ─── the historical calls (Taste Evolution) ─────────────────────────── */

export interface ChartWeek {
  /** Unix seconds, inclusive start of the week Last.fm charted. */
  from: number;
  /** Unix seconds, exclusive-ish end of that week. */
  to: number;
}

/**
 * Every week Last.fm has a chart for, oldest first. One call, and it changes
 * only when a week ends — so it is cached for a day (TE-REQ-19) and is the
 * cheapest possible way to learn how far back an account goes.
 */
export async function weeklyChartList(user: string): Promise<ChartWeek[]> {
  return cached("charts", user, async () => {
    const data = await call(
      { method: "user.getweeklychartlist", user },
      false,
    );
    const block = data.weeklychartlist as { chart?: unknown } | undefined;
    return list<{ from?: string; to?: string }>(block?.chart)
      .map((c) => ({ from: Number(c.from), to: Number(c.to) }))
      .filter((c) => Number.isFinite(c.from) && Number.isFinite(c.to) && c.to > c.from)
      .sort((a, b) => a.from - b.from);
  });
}

/**
 * When this account's history actually begins, in unix seconds — or 0 when
 * that can't be established.
 *
 * `user.getWeeklyChartList` answers with every week since the account was
 * *created*, which for a long-dormant registration can be two decades of
 * weeks that provably contain nothing: one measured account lists 1,125
 * weeks and started scrobbling in week 843. Fetching those charts costs a
 * request each to be told "nothing", which is most of what makes a first
 * timeline slow.
 *
 * The recent-tracks feed is paginated newest-first and reports its own page
 * count, so the oldest scrobble is exactly two requests away: one for the
 * total, one for the last page. Exact, not a heuristic — no week that could
 * contain listening is skipped.
 */
export async function firstScrobble(user: string): Promise<number> {
  return cached("first", user, async () => {
    const head = await call(
      { method: "user.getrecenttracks", user, limit: "1" },
      false,
    ).catch(() => null);
    const attr = (
      head?.recenttracks as { "@attr"?: { totalPages?: string } } | undefined
    )?.["@attr"];
    const pages = Number(attr?.totalPages) || 0;
    if (pages < 1) return 0;

    const tail = await call(
      {
        method: "user.getrecenttracks",
        user,
        limit: "1",
        page: String(pages),
      },
      false,
    ).catch(() => null);
    const track = list<{ date?: { uts?: string } }>(
      (tail?.recenttracks as { track?: unknown } | undefined)?.track,
    )[0];
    // A track with no date is the one playing right now, which cannot be the
    // oldest unless it is also the only one — either way, 0 means "don't
    // trim", and a whole history is read rather than risking losing any of it.
    return Number(track?.date?.uts) || 0;
  });
}

/** The weeks that could contain listening, given a known first scrobble. */
export function weeksSince(weeks: ChartWeek[], first: number): ChartWeek[] {
  if (!(first > 0)) return weeks;
  return weeks.filter((w) => w.to >= first);
}

/**
 * What an account played during one historical week.
 *
 * A week that has already ended can never change, so it is filed under a
 * cache kind that keeps it effectively forever; the week currently in
 * progress gets a short life instead. Background priority: the normal map is
 * never waiting on history, and a decade of weeks must not be allowed to
 * starve it.
 */
export async function weeklyArtistChart(
  user: string,
  week: ChartWeek,
  { complete = week.to * 1000 < Date.now() }: { complete?: boolean } = {},
): Promise<TopArtist[]> {
  return cached(
    complete ? "chart" : "chartLive",
    `${user}|${week.from}|${week.to}`,
    async () => {
      const data = await call(
        {
          method: "user.getweeklyartistchart",
          user,
          from: String(week.from),
          to: String(week.to),
        },
        true,
      );
      const block = data.weeklyartistchart as { artist?: unknown } | undefined;
      return list<{ name?: string; playcount?: string; url?: string }>(
        block?.artist,
      )
        .map((a) => ({
          name: (a.name || "").trim(),
          plays: Number(a.playcount) || 0,
          url: a.url || "",
        }))
        .filter((a) => a.name && a.plays > 0);
    },
  );
}

export const profileUrl = (user: string) =>
  `https://www.last.fm/user/${encodeURIComponent(user)}`;
