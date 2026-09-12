/**
 * Exploration — the space beyond the map.
 *
 * The Galaxy is the mapped territory: one bubble per artist this account has
 * actually played. Similarity data reaches further than that, and this
 * module is the part that reasons about the difference between the two.
 *
 * Everything here is pure. It takes an already-built Galaxy plus whatever
 * Last.fm similarity lists have been handed to it, and answers three
 * questions:
 *
 *   1. which artists sit immediately outside a region of the Galaxy, and
 *      which Galaxy artists are responsible for them (the Frontier);
 *   2. which artists make up one artist's local neighbourhood, and which of
 *      those are known territory (a System);
 *   3. where to put all of that on screen, deterministically.
 *
 * No fetching, no DOM, no canvas — so the ranking and selection rules can be
 * pinned by tests rather than inferred from a screenshot (§24).
 *
 * The domain distinction is deliberate and load-bearing (§23): a Frontier
 * artist is *not* an `Artist`. It has no play count, no radius and no
 * cluster, because this account may never have played it and it never went
 * through the Galaxy's clustering. Pretending otherwise would let
 * "0 plays" — a thing this app cannot know — onto the screen.
 */
import { norm, type Artist } from "./build.ts";
import type { SimilarArtist } from "./lastfm.ts";

/* ─── the model ──────────────────────────────────────────────────────── */

/**
 * One node in an exploration view.
 *
 * `status` is the whole point: it says whether this artist is inside the
 * Galaxy the exploration started from, outside it, or outside it and
 * already visited on this trail (EXP-REQ-17).
 */
export interface ExploreNode {
  name: string;
  image: string;
  status: "galaxy" | "frontier" | "explored";
  /** Set only for `galaxy` nodes — the artist's id on the live map. */
  galaxyArtistId?: number;
  /** …and its group there, so known territory keeps its colour. */
  clusterId?: number;
  /** Similarity to whatever this view is centred on, 0–1, when known. */
  match?: number;
}

/** A link from one Galaxy artist out to a candidate beyond the Galaxy. */
export interface FrontierLink {
  artistId: number;
  match: number;
}

/**
 * An artist outside the Galaxy, with the evidence for why it is being
 * shown at all (EXP-PRINCIPLE-2).
 */
export interface FrontierCandidate {
  name: string;
  /** How many members of the region link to it. */
  supportCount: number;
  /** Sum of those members' similarity scores. */
  sumMatch: number;
  /** The strongest single relationship. */
  maxMatch: number;
  /** Who is responsible, strongest first. */
  links: FrontierLink[];
}

export interface Point {
  x: number;
  y: number;
}

/* ─── tuning ─────────────────────────────────────────────────────────── */

/** Below this a similarity score is noise, same bar as the map's edges. */
export const MIN_MATCH = 0.05;
/** EXP-REQ-5 — enough to show the region has exits, few enough to read. */
export const FRONTIER_LIMIT = 10;
/** EXP-REQ-9 — a System's neighbour cap. */
export const SYSTEM_LIMIT = 16;
/**
 * …of which this many are held for artists outside the Galaxy whenever
 * that many suitable ones exist. Without a reserve a well-mapped region
 * fills every slot with artists the visitor already has, and exploration
 * stops being exploration.
 */
export const SYSTEM_FRONTIER_RESERVE = 5;

/* ─── who is in the Galaxy ───────────────────────────────────────────── */

/**
 * The Galaxy's artists, by normalised name.
 *
 * "In the Galaxy" means "in the artist set currently on screen" — which
 * depends on the period the exploration was opened from (§18). It is not a
 * claim about what the account has never listened to.
 */
export function galaxyIndex(artists: Artist[]): Map<string, Artist> {
  const index = new Map<string, Artist>();
  for (const a of artists) {
    const key = norm(a.name);
    // First wins: the list arrives most-played first, so the artist a
    // visitor means by an ambiguous name is the one they play.
    if (!index.has(key)) index.set(key, a);
  }
  return index;
}

/** True when this artist is outside the currently displayed Galaxy. */
export function isFrontier(name: string, galaxy: Map<string, Artist>): boolean {
  return !galaxy.has(norm(name));
}

/* ─── the cluster Frontier (EXP-REQ-4) ───────────────────────────────── */

/**
 * Fold a region's similarity lists into candidates that sit outside the
 * Galaxy.
 *
 * `lists` is keyed by artist id and holds whatever the similarity cache
 * already knows — the Galaxy build asked for every one of these, so this is
 * normally free (EXP-REQ-21).
 *
 * Artists already anywhere in the Galaxy are dropped: they are territory,
 * not frontier. Names are merged case- and accent-insensitively, and one
 * member linking to the same name twice (Last.fm's autocorrect can do this)
 * counts once, at its strongest.
 */
export function aggregateFrontier(
  members: Artist[],
  lists: Map<number, SimilarArtist[]>,
  galaxy: Map<string, Artist>,
): FrontierCandidate[] {
  /** normalised name → candidate under construction */
  const found = new Map<
    string,
    { name: string; best: Map<number, number> }
  >();

  for (const member of members) {
    const list = lists.get(member.id);
    if (!list) continue;
    for (const other of list) {
      const name = other.name.trim();
      if (!name) continue;
      const match = other.match;
      if (!Number.isFinite(match) || match < MIN_MATCH) continue;
      const key = norm(name);
      if (!key || galaxy.has(key)) continue;
      let entry = found.get(key);
      if (!entry) {
        entry = { name, best: new Map() };
        found.set(key, entry);
      }
      const held = entry.best.get(member.id);
      if (held === undefined || match > held) entry.best.set(member.id, match);
    }
  }

  const candidates: FrontierCandidate[] = [];
  for (const { name, best } of found.values()) {
    const links = [...best]
      .map(([artistId, match]) => ({ artistId, match }))
      .sort((a, b) => b.match - a.match || a.artistId - b.artistId);
    candidates.push({
      name,
      supportCount: links.length,
      sumMatch: links.reduce((s, l) => s + l.match, 0),
      maxMatch: links.length ? links[0].match : 0,
      links,
    });
  }
  return rankFrontier(candidates);
}

/**
 * The ordering, stated once so it can be argued with.
 *
 * An artist several members of the region point at is more genuinely "just
 * beyond this region" than one hanging off a single artist, however
 * strongly — so multiply-supported candidates come first, ranked by the
 * total weight of their support. The rest follow on their single strongest
 * link. Ties break on name, so the same region always produces the same
 * frontier (EXP-REQ-4).
 */
export function rankFrontier(
  candidates: FrontierCandidate[],
): FrontierCandidate[] {
  return [...candidates].sort((a, b) => {
    const at = a.supportCount >= 2 ? 0 : 1;
    const bt = b.supportCount >= 2 ? 0 : 1;
    if (at !== bt) return at - bt;
    if (at === 0) {
      if (b.sumMatch !== a.sumMatch) return b.sumMatch - a.sumMatch;
      if (b.supportCount !== a.supportCount) {
        return b.supportCount - a.supportCount;
      }
    } else if (b.maxMatch !== a.maxMatch) {
      return b.maxMatch - a.maxMatch;
    }
    return a.name.localeCompare(b.name);
  });
}

/* ─── a System (EXP-REQ-9) ───────────────────────────────────────────── */

export interface SystemInput {
  /** The artist at the centre. */
  anchor: string;
  /** Its `artist.getSimilar` list. */
  similar: SimilarArtist[];
  galaxy: Map<string, Artist>;
  /** Normalised names already used as an anchor on this trail. */
  explored?: Set<string>;
  /** Where the visitor arrived from, kept whatever its match (EXP-REQ-14). */
  previous?: string | null;
  limit?: number;
  /** How many outside artists to hold slots for, when they exist. */
  reserve?: number;
}

export interface System {
  anchor: ExploreNode;
  neighbours: ExploreNode[];
}

/**
 * One artist's local neighbourhood.
 *
 * Both kinds of artist are wanted here: the Galaxy artists are what make
 * the place recognisable, the Frontier artists are what make it worth
 * travelling to. Left to raw similarity order a dense region of the Galaxy
 * would take every slot, so a few are reserved for outside artists
 * whenever enough exist.
 */
export function buildSystem(input: SystemInput): System {
  const {
    anchor,
    similar,
    galaxy,
    explored = new Set<string>(),
    previous = null,
    limit = SYSTEM_LIMIT,
    reserve = SYSTEM_FRONTIER_RESERVE,
  } = input;

  const anchorKey = norm(anchor);
  const seen = new Set<string>([anchorKey]);
  const ranked: ExploreNode[] = [];

  for (const entry of similar) {
    const name = entry.name.trim();
    const key = norm(name);
    if (!name || !key || seen.has(key)) continue;
    const match = Number.isFinite(entry.match) ? entry.match : 0;
    if (match < MIN_MATCH) continue;
    seen.add(key);
    ranked.push(describe(name, galaxy, explored, match));
  }
  ranked.sort((a, b) => (b.match ?? 0) - (a.match ?? 0) || a.name.localeCompare(b.name));

  const chosen = ranked.slice(0, limit);
  const rest = ranked.slice(limit);

  // Swap the weakest known artists out for the strongest unseen ones until
  // the reserve is met — never the other way round, so a region with no
  // outside artists simply shows what it has.
  const outside = (n: ExploreNode) => n.status !== "galaxy";
  let held = chosen.filter(outside).length;
  const waiting = rest.filter(outside);
  while (held < reserve && waiting.length) {
    let weakest = -1;
    for (let i = chosen.length - 1; i >= 0; i--) {
      if (!outside(chosen[i])) {
        weakest = i;
        break;
      }
    }
    if (weakest === -1) break;
    chosen[weakest] = waiting.shift()!;
    held++;
  }
  chosen.sort((a, b) => (b.match ?? 0) - (a.match ?? 0) || a.name.localeCompare(b.name));

  // EXP-REQ-14 — the way back stays on screen even when the similarity
  // between the two artists is one-directional or weak.
  if (previous) {
    const prevKey = norm(previous);
    if (prevKey && prevKey !== anchorKey) {
      const at = chosen.findIndex((n) => norm(n.name) === prevKey);
      if (at === -1) {
        const known = ranked.find((n) => norm(n.name) === prevKey);
        const node = known || describe(previous, galaxy, explored, undefined);
        if (chosen.length >= limit) chosen.pop();
        chosen.push(node);
      }
    }
  }

  return {
    anchor: describe(anchor, galaxy, explored, undefined),
    neighbours: chosen,
  };
}

function describe(
  name: string,
  galaxy: Map<string, Artist>,
  explored: Set<string>,
  match: number | undefined,
): ExploreNode {
  const key = norm(name);
  const known = galaxy.get(key);
  if (known) {
    return {
      name: known.name,
      image: known.image,
      status: "galaxy",
      galaxyArtistId: known.id,
      clusterId: known.cluster >= 0 ? known.cluster : undefined,
      match,
    };
  }
  return {
    name,
    image: "",
    status: explored.has(key) ? "explored" : "frontier",
    match,
  };
}

/* ─── the trail (§11) ────────────────────────────────────────────────── */

export interface TrailEntry {
  name: string;
  status: ExploreNode["status"];
}

/** Where an exploration started, so `Return to Galaxy` knows where to go. */
export type ExploreOrigin =
  | { kind: "galaxy" }
  | { kind: "cluster"; clusterId: number; label: string };

export interface ExploreState {
  origin: ExploreOrigin;
  /** Systems visited, oldest first. The last one is where you are. */
  trail: TrailEntry[];
  /** Normalised names of every outside artist used as an anchor (§3). */
  explored: Set<string>;
}

export function beginExploration(
  origin: ExploreOrigin,
  anchor: TrailEntry,
): ExploreState {
  return markExplored({ origin, trail: [anchor], explored: new Set() });
}

/**
 * Travel to another artist.
 *
 * Stepping onto the artist one hop back is a retreat rather than a new hop,
 * so the trail shortens instead of growing `A → B → A`; that keeps the
 * breadcrumb a route rather than a log.
 */
export function travel(state: ExploreState, to: TrailEntry): ExploreState {
  const key = norm(to.name);
  const trail = state.trail;
  if (trail.length && norm(trail[trail.length - 1].name) === key) return state;

  const at = trail.findIndex((e) => norm(e.name) === key);
  const next =
    at >= 0 ? trail.slice(0, at + 1) : [...trail, to];
  return markExplored({ ...state, trail: next });
}

/** One step back, or null when the trail's start has been reached. */
export function back(state: ExploreState): ExploreState | null {
  if (state.trail.length <= 1) return null;
  return { ...state, trail: state.trail.slice(0, -1) };
}

/** The artist whose System is on screen. */
export function currentAnchor(state: ExploreState): TrailEntry {
  return state.trail[state.trail.length - 1];
}

/** The one before it — what EXP-REQ-14 keeps visible. */
export function previousAnchor(state: ExploreState): TrailEntry | null {
  return state.trail.length >= 2 ? state.trail[state.trail.length - 2] : null;
}

function markExplored(state: ExploreState): ExploreState {
  const explored = new Set(state.explored);
  for (const entry of state.trail) {
    if (entry.status !== "galaxy") explored.add(norm(entry.name));
  }
  return { ...state, explored };
}

/**
 * EXP-REQ-16 — a long trail collapses in the middle rather than pushing the
 * controls off the page. `null` marks the elided run.
 */
export function collapseTrail(
  trail: TrailEntry[],
  max = 3,
): (TrailEntry | null)[] {
  if (trail.length <= max) return [...trail];
  return [trail[0], null, ...trail.slice(-(max - 1))];
}

/* ─── placing things (EXP-REQ-6, EXP-REQ-10) ─────────────────────────── */

/** The golden angle — the same even spread the Galaxy's first frame uses. */
const GOLDEN = Math.PI * (3 - Math.sqrt(5));

export interface FrontierPlacement extends Point {
  name: string;
}

/**
 * Put Frontier artists around the rim of a focused region, each one out
 * beyond the part of the region responsible for it.
 *
 * The direction comes from the weighted centroid of its supporting members,
 * so a candidate three artists on the left-hand edge all point at appears
 * off the left-hand edge — the region visibly has a border, and these sit
 * just past it. Galaxy members are never moved (EXP-REQ-3/6).
 */
export function placeFrontier(
  candidates: FrontierCandidate[],
  members: Map<number, Point>,
  options: { centre: Point; radius: number; gap?: number; spacing?: number },
): FrontierPlacement[] {
  const { centre, radius } = options;
  const gap = options.gap ?? radius * 0.22;
  const spacing = options.spacing ?? radius * 0.2;

  const placed: FrontierPlacement[] = candidates.map((candidate, i) => {
    let wx = 0;
    let wy = 0;
    let weight = 0;
    for (const link of candidate.links) {
      const p = members.get(link.artistId);
      if (!p) continue;
      wx += p.x * link.match;
      wy += p.y * link.match;
      weight += link.match;
    }
    // No supporting position to work from — fall back to an even spread, so
    // the node still lands somewhere sensible instead of on the centre.
    let dx = weight > 0 ? wx / weight - centre.x : Math.cos(i * GOLDEN);
    let dy = weight > 0 ? wy / weight - centre.y : Math.sin(i * GOLDEN);
    let len = Math.hypot(dx, dy);
    if (len < 1e-6) {
      dx = Math.cos(i * GOLDEN);
      dy = Math.sin(i * GOLDEN);
      len = 1;
    }
    const out = radius + gap;
    return {
      name: candidate.name,
      x: centre.x + (dx / len) * out,
      y: centre.y + (dy / len) * out,
    };
  });

  return separateOnRing(placed, centre, spacing);
}

/**
 * Nudge nodes apart *along* the ring they sit on, so nothing overlaps and
 * nothing loses the direction it was placed in. Deterministic: a fixed
 * number of passes, nodes visited in order.
 */
function separateOnRing<T extends Point>(
  nodes: T[],
  centre: Point,
  spacing: number,
): T[] {
  for (let pass = 0; pass < 24; pass++) {
    let moved = false;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const dx = nodes[j].x - nodes[i].x;
        const dy = nodes[j].y - nodes[i].y;
        const d = Math.hypot(dx, dy);
        if (d >= spacing) continue;
        // Rotate both a little, in opposite directions, about the centre.
        const step = ((spacing - d) / Math.max(spacing, 1e-6)) * 0.12;
        rotate(nodes[i], centre, -step);
        rotate(nodes[j], centre, +step);
        moved = true;
      }
    }
    if (!moved) break;
  }
  return nodes;
}

function rotate(p: Point, centre: Point, angle: number) {
  const dx = p.x - centre.x;
  const dy = p.y - centre.y;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  p.x = centre.x + dx * cos - dy * sin;
  p.y = centre.y + dx * sin + dy * cos;
}

/**
 * A System's layout: the anchor at the origin, everything else at a radius
 * set by how similar it is to the anchor and nothing else (EXP-REQ-10).
 *
 * Angles are the golden spread, then relaxed sideways for overlap — the
 * radius is never touched by that pass, so what the picture claims about
 * similarity stays true.
 */
export function layoutSystem(
  neighbours: ExploreNode[],
  options: { inner: number; outer: number; spacing?: number },
): Point[] {
  const { inner, outer } = options;
  const spacing = options.spacing ?? (outer - inner) * 0.34;
  const scores = neighbours.map((n) => (Number.isFinite(n.match) ? n.match! : 0));
  const top = Math.max(...scores, 0.0001);
  const low = Math.min(...scores.filter((s) => s > 0), top);
  const span = Math.max(top - low, 1e-6);

  const points: Point[] = neighbours.map((_node, i) => {
    const score = scores[i];
    // An artist with no similarity score at all — the one kept because the
    // visitor arrived through it (EXP-REQ-14) — sits at the outer edge.
    const t = score > 0 ? 1 - (score - low) / span : 1;
    const r = inner + (outer - inner) * t;
    const angle = i * GOLDEN;
    return { x: Math.cos(angle) * r, y: Math.sin(angle) * r };
  });

  return separateOnRing(points, { x: 0, y: 0 }, spacing);
}

/**
 * Whether this is the end of the road (§22).
 *
 * The artist travelled *from* is kept on screen whatever its similarity
 * (EXP-REQ-14), so "has neighbours" is not the same question as "leads
 * anywhere": a System whose only node is the way back is a dead end, and
 * saying so is more useful than pretending there is a turning here.
 */
export function deadEnd(system: System, previous?: string | null): boolean {
  const back = previous ? norm(previous) : "";
  return !system.neighbours.some((n) => norm(n.name) !== back);
}

/**
 * How a System reads out loud (§21).
 *
 * Example: "Exploring Justice. 6 related artists are in your Galaxy and 10
 * are beyond it."
 */
export function describeSystem(system: System): string {
  const known = system.neighbours.filter((n) => n.status === "galaxy").length;
  const beyond = system.neighbours.length - known;
  if (!system.neighbours.length) {
    return `Exploring ${system.anchor.name}. No further strong connections found here.`;
  }
  return (
    `Exploring ${system.anchor.name}. ` +
    `${known} related ${known === 1 ? "artist is" : "artists are"} in your Galaxy and ` +
    `${beyond} ${beyond === 1 ? "is" : "are"} beyond it.`
  );
}
