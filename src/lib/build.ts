/**
 * Building a map, live.
 *
 * Emits as it goes rather than returning once at the end, because the
 * expensive part (one similarity call per artist) is exactly the part the
 * map does not need in order to appear. The order is:
 *
 *   1. one call for the artist set → every bubble exists, correctly sized;
 *   2. similarity streams in → edges accumulate and the layout settles;
 *   3. groups are found once the graph is whole;
 *   4. tags and cover art arrive afterwards, enriching a map already in use.
 */
import * as api from "./lastfm";
import { adjacency, labelPropagation, type Edge } from "./layout";

export interface Artist {
  id: number;
  name: string;
  plays: number;
  url: string;
  image: string;
  tags: string[];
  r: number;
  cluster: number;
  similar: { id: number; score: number }[];
  /**
   * Where the layout currently has this artist. Lives here rather than
   * alongside the layout because the renderer, the hit test and the search
   * all want it, and because these objects are handed to the map once and
   * then filled in as the build progresses — copying them would strand
   * every later update in the builder.
   */
  x: number;
  y: number;
}

export interface Cluster {
  id: number;
  color: string;
  label: string;
  size: number;
  anchor: string;
  plays: number;
}

/**
 * REQ-2 — the inclusion rule, stated on the page (REQ-3).
 *
 * The cap is what keeps a live build to a few seconds; the floor drops the
 * one-play tail, which has no similarity structure to place it by.
 */
export const SELECTION = { period: "overall", limit: 300, minPlays: 25 };

/** Bubble radius range, in layout units. */
const RADIUS = { min: 11, max: 58 };
/** Similarity edges kept per artist, strongest first. */
const EDGES_PER_ARTIST = 10;
/** Below this match score an edge is too weak to mean anything. */
const MIN_MATCH = 0.05;

/** Muted, tuned for the off-black ground, assigned by group size (OQ-8). */
const PALETTE = [
  "#e3b23c", "#5fa877", "#6f9fd8", "#c98a9b", "#9b8bd0", "#d98b5f",
  "#6fb3a8", "#b6a98c", "#8fae62", "#cf7f7f", "#7f9ec9", "#c0a5d3",
];

const norm = (name: string) => name.toLowerCase().normalize("NFKD").trim();

/**
 * REQ-5 / OQ-7 — radius from play count, logarithmically. Play counts run
 * from thousands to tens, so a linear scale would render the tail as dust.
 */
function radiusFor(plays: number, min: number, max: number) {
  if (max <= min) return (RADIUS.min + RADIUS.max) / 2;
  const t = (Math.log(plays) - Math.log(min)) / (Math.log(max) - Math.log(min));
  return RADIUS.min + (RADIUS.max - RADIUS.min) * Math.pow(t, 0.85);
}

export interface BuildEvents {
  /** Every artist is known: draw them. */
  onArtists: (artists: Artist[], meta: BuildMeta) => void;
  /** More similarity has landed; `done`/`total` drive the progress line. */
  onEdges: (edges: Edge[], done: number, total: number) => void;
  /** The graph is whole and has been grouped. */
  onClusters: (clusters: Cluster[]) => void;
  /** A background detail arrived for one artist (art, or tags). */
  onEnriched: (artist: Artist) => void;
  /** Group names improved once enough tags were in. */
  onLabels: (clusters: Cluster[]) => void;
}

export interface BuildMeta {
  user: string;
  profileUrl: string;
  totalScrobbledArtists: number;
  description: string;
}

export class EmptyHistoryError extends Error {}

/**
 * Build the map for one account. Returns once the graph and groups are
 * complete; artwork and tags keep arriving through the callbacks after.
 */
export async function build(
  user: string,
  events: BuildEvents,
): Promise<Artist[]> {
  const { artists: top, total } = await api.topArtists(
    user,
    SELECTION.period,
    SELECTION.limit,
  );

  const chosen = top
    .filter((a) => a.plays >= SELECTION.minPlays)
    .slice(0, SELECTION.limit);
  if (chosen.length < 3) throw new EmptyHistoryError(user);

  const plays = chosen.map((a) => a.plays);
  const minPlays = Math.min(...plays);
  const maxPlays = Math.max(...plays);

  const artists: Artist[] = chosen.map((a, i) => ({
    id: i,
    name: a.name,
    plays: a.plays,
    url: a.url,
    image: "",
    tags: [],
    r: radiusFor(a.plays, minPlays, maxPlays),
    cluster: -1,
    similar: [],
    x: 0,
    y: 0,
  }));

  events.onArtists(artists, {
    user,
    profileUrl: api.profileUrl(user),
    totalScrobbledArtists: total,
    description:
      `The ${artists.length} artists ${user} has played most on Last.fm ` +
      `(minimum ${SELECTION.minPlays} plays), out of ` +
      `${total.toLocaleString("en-US")} ever scrobbled.`,
  });

  /* ── similarity, streamed ──────────────────────────────────────────── */

  const index = new Map(artists.map((a, i) => [norm(a.name), i]));
  /** pair key "i:j" (i<j) → strongest match seen in either direction */
  const pairs = new Map<string, number>();
  let done = 0;

  await Promise.all(
    artists.map(async (artist) => {
      const list = await api.similar(artist.name).catch(() => []);
      for (const other of list) {
        const j = index.get(norm(other.name));
        if (j === undefined || j === artist.id) continue;
        if (!(other.match >= MIN_MATCH)) continue;
        const key =
          artist.id < j ? `${artist.id}:${j}` : `${j}:${artist.id}`;
        pairs.set(key, Math.max(pairs.get(key) || 0, other.match));
      }
      done++;
      // Republish the graph periodically rather than per artist — the
      // layout only needs to know roughly as often as it can react.
      if (done % 15 === 0 || done === artists.length) {
        events.onEdges(prune(artists, pairs), done, artists.length);
      }
    }),
  );

  const edges = prune(artists, pairs);
  attachNeighbours(artists, pairs);

  /* ── groups ────────────────────────────────────────────────────────── */

  const adj = adjacency(artists.length, edges);
  const clusters = group(artists, adj);
  events.onClusters(clusters);

  /* ── enrichment, after the map is already usable ───────────────────── */

  void enrich(artists, clusters, events);

  return artists;
}

/** Keep each artist's strongest edges, so one hub can't dominate the map. */
function prune(artists: Artist[], pairs: Map<string, number>): Edge[] {
  const perNode: { other: number; w: number }[][] = artists.map(() => []);
  for (const [key, w] of pairs) {
    const [a, b] = key.split(":").map(Number);
    perNode[a].push({ other: b, w });
    perNode[b].push({ other: a, w });
  }
  const kept = new Map<string, number>();
  perNode.forEach((entries, i) => {
    entries.sort((x, y) => y.w - x.w);
    for (const { other, w } of entries.slice(0, EDGES_PER_ARTIST)) {
      kept.set(i < other ? `${i}:${other}` : `${other}:${i}`, w);
    }
  });
  return [...kept].map(([key, w]) => {
    const [a, b] = key.split(":").map(Number);
    return { a, b, w };
  });
}

/** Each artist's closest neighbours, for the detail panel (REQ-13/15). */
function attachNeighbours(artists: Artist[], pairs: Map<string, number>) {
  const perNode: { other: number; w: number }[][] = artists.map(() => []);
  for (const [key, w] of pairs) {
    const [a, b] = key.split(":").map(Number);
    perNode[a].push({ other: b, w });
    perNode[b].push({ other: a, w });
  }
  perNode.forEach((entries, i) => {
    entries.sort((x, y) => y.w - x.w);
    artists[i].similar = entries
      .slice(0, 6)
      .map(({ other, w }) => ({ id: other, score: w }));
  });
}

/** Label propagation over the similarity graph — emergent, not authored. */
function group(
  artists: Artist[],
  adj: { j: number; w: number }[][],
): Cluster[] {
  const labels = labelPropagation(artists.length, adj);
  const groups = new Map<number, number[]>();
  for (let i = 0; i < artists.length; i++) {
    const key = adj[i].length ? labels[i] : -1;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(i);
  }
  // Two artists are not a cluster.
  const real = [...groups.values()].filter((m) => m.length >= 3);
  real.sort((a, b) => b.length - a.length);

  for (const a of artists) a.cluster = -1;
  return real.map((members, id) => {
    for (const m of members) artists[m].cluster = id;
    const byPlays = [...members].sort(
      (a, b) => artists[b].plays - artists[a].plays,
    );
    return {
      id,
      color: PALETTE[id % PALETTE.length],
      // Until tags arrive, name a group after the artist at its heart.
      // Derived, honest, and free — no extra call to make the map usable.
      label: `around ${artists[byPlays[0]].name}`,
      size: members.length,
      anchor: artists[byPlays[0]].name,
      plays: members.reduce((s, m) => s + artists[m].plays, 0),
    };
  });
}

/**
 * Cover art and tags, fetched once the map is already on screen. Tags then
 * upgrade each group's name from its anchor artist to whichever tag is most
 * distinctive to its members (OQ-4) — common inside the group and rare
 * outside it, so they don't all come out called "electronic".
 */
async function enrich(
  artists: Artist[],
  clusters: Cluster[],
  events: BuildEvents,
) {
  const art = Promise.all(
    artists.map(async (artist) => {
      const url = await api.artwork(artist.name).catch(() => "");
      if (url) {
        artist.image = url;
        events.onEnriched(artist);
      }
    }),
  );

  const tagLists = await Promise.all(
    artists.map(async (artist) => {
      const list = await api.tags(artist.name).catch(() => []);
      artist.tags = list.slice(0, 4);
      if (list.length) events.onEnriched(artist);
      return list;
    }),
  );

  const globalCounts = new Map<string, number>();
  for (const list of tagLists) {
    for (const tag of list) {
      globalCounts.set(tag, (globalCounts.get(tag) || 0) + 1);
    }
  }

  let improved = false;
  for (const cluster of clusters) {
    const members = artists.filter((a) => a.cluster === cluster.id);
    const local = new Map<string, number>();
    for (const m of members) {
      for (const tag of tagLists[m.id]) {
        local.set(tag, (local.get(tag) || 0) + 1);
      }
    }
    let best = "";
    let bestScore = 0;
    for (const [tag, count] of local) {
      if (count < 2) continue;
      const share = count / members.length;
      const distinctiveness = count / (globalCounts.get(tag) || count);
      const score = share * Math.pow(distinctiveness, 1.5);
      if (score > bestScore) {
        bestScore = score;
        best = tag;
      }
    }
    if (best) {
      cluster.label = best;
      improved = true;
    }
  }
  if (improved) events.onLabels(clusters);

  await art;
}
