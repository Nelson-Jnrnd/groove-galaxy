/**
 * The temporal model: one galaxy, many years.
 *
 * The premise of Taste Evolution is that **listening changes and similarity
 * does not** (TP-PRINCIPLE-1). So there is exactly one artist universe, one
 * similarity graph, one clustering and one layout for the whole selected
 * range; a frame changes only how much each artist was played, which drives
 * bubble size, opacity and every aggregate on the page. Nothing here moves
 * an artist, because nothing here learns anything about who they sound like.
 *
 * Kept clear of the renderer on purpose (§51): everything below is a pure
 * function of frames in, numbers out, which is what makes the temporal
 * arithmetic testable without a canvas.
 */
import { radiusFor, RADIUS, type Artist, type Cluster } from "./build.ts";
import type { TemporalFrame } from "./history.ts";
import type { Point } from "./layout.ts";

export interface TemporalArtistState {
  plays: number;
  active: boolean;
  /** 1-based rank within the frame, counting only mapped artists. */
  rank?: number;
  /** Share of the frame's mapped listening, 0–1. */
  share?: number;
}

export interface TemporalArtist {
  artistId: number;
  name: string;
  states: Map<string, TemporalArtistState>;
  /** First and last frame this artist was played in, over the whole range. */
  firstSeen: string | null;
  lastSeen: string | null;
  /** Total plays across the selected range — the tie-break for ranking. */
  total: number;
}

/* ─── who gets on the map ────────────────────────────────────────────── */

export interface UniverseOptions {
  /** Artists guaranteed a look from every single frame. */
  perFrame?: number;
  /** TE-REQ-6 — the cap on visible temporal nodes. */
  max?: number;
}

/**
 * Choose the artists the timeline will show.
 *
 * Taking the 300 biggest totals would hand the map to whoever has been
 * around longest and erase every short, intense phase — the six months
 * somebody played nothing but UK garage. So every frame nominates its own
 * top few first (TE-REQ-5), and only once those are in does raw volume fill
 * whatever room is left.
 *
 * When the nominations alone overflow the cap, candidates are ranked on the
 * best share of listening they ever reached in a single frame *and* their
 * total across the range — a permanent mid-sized presence and a one-year
 * obsession both have a route in.
 */
export function buildUniverse(
  frames: TemporalFrame[],
  { perFrame = 50, max = 300 }: UniverseOptions = {},
): string[] {
  const totals = new Map<string, number>();
  const bestShare = new Map<string, number>();
  const nominated = new Set<string>();

  for (const frame of frames) {
    const ranked = [...frame.artists].sort((a, b) => b[1] - a[1]);
    ranked.forEach(([name, plays], i) => {
      totals.set(name, (totals.get(name) || 0) + plays);
      const share = frame.totalPlays ? plays / frame.totalPlays : 0;
      if (share > (bestShare.get(name) || 0)) bestShare.set(name, share);
      if (i < perFrame) nominated.add(name);
    });
  }

  if (nominated.size <= max) {
    // Room to spare: fill up with the biggest totals across the range.
    const rest = [...totals.keys()]
      .filter((name) => !nominated.has(name))
      .sort((a, b) => (totals.get(b) || 0) - (totals.get(a) || 0))
      .slice(0, max - nominated.size);
    return [...nominated, ...rest].sort(
      (a, b) => (totals.get(b) || 0) - (totals.get(a) || 0),
    );
  }

  const maxTotal = Math.max(...totals.values(), 1);
  const score = (name: string) =>
    // Peak share and lifetime volume, each on its own 0–1 scale. Share is
    // weighted a little heavier so that defining one year beats being
    // background noise for ten.
    (bestShare.get(name) || 0) * 0.6 +
    ((totals.get(name) || 0) / maxTotal) * 0.4;

  return [...nominated]
    .sort((a, b) => score(b) - score(a) || (totals.get(b) || 0) - (totals.get(a) || 0))
    .slice(0, max);
}

/* ─── what each artist did in each frame ─────────────────────────────── */

/**
 * The per-frame state table: for every artist in the universe, what they
 * were worth in every frame. Ranks and shares count only mapped artists, so
 * "#2 artist this year" means #2 of the ones actually on screen — which is
 * what the panel says.
 */
export function buildStates(
  artists: { id: number; name: string }[],
  frames: TemporalFrame[],
): Map<number, TemporalArtist> {
  const table = new Map<number, TemporalArtist>();
  for (const a of artists) {
    table.set(a.id, {
      artistId: a.id,
      name: a.name,
      states: new Map(),
      firstSeen: null,
      lastSeen: null,
      total: 0,
    });
  }

  for (const frame of frames) {
    const mapped = artists
      .map((a) => ({ id: a.id, plays: frame.artists.get(a.name) || 0 }))
      .filter((entry) => entry.plays > 0)
      .sort((x, y) => y.plays - x.plays);
    const mappedTotal = mapped.reduce((s, e) => s + e.plays, 0);
    const rankById = new Map(mapped.map((e, i) => [e.id, i + 1]));

    for (const a of artists) {
      const plays = frame.artists.get(a.name) || 0;
      const entry = table.get(a.id)!;
      entry.states.set(frame.id, {
        plays,
        active: plays > 0,
        rank: plays > 0 ? rankById.get(a.id) : undefined,
        share: plays > 0 && mappedTotal ? plays / mappedTotal : undefined,
      });
      if (plays > 0) {
        entry.total += plays;
        if (!entry.firstSeen) entry.firstSeen = frame.id;
        entry.lastSeen = frame.id;
      }
    }
  }

  return table;
}

/* ─── how big a bubble is, in a given year ───────────────────────────── */

export interface TemporalScale {
  /** Plays at which a bubble is at its smallest, across the whole range. */
  min: number;
  /** …and at its largest. */
  max: number;
}

/**
 * One scale for the whole selected range (TE-REQ-9).
 *
 * Normalising each year on its own would make a 50-play year look exactly
 * like a 500-play one, which is a lie about the shape of a listening
 * history. The scale is therefore computed once across every frame; the only
 * concession to quiet years is in `radiusIn` below.
 */
export function playScale(
  table: Map<number, TemporalArtist>,
  frames: TemporalFrame[],
): TemporalScale {
  let max = 1;
  let min = Infinity;
  for (const artist of table.values()) {
    for (const frame of frames) {
      const plays = artist.states.get(frame.id)?.plays || 0;
      if (plays <= 0) continue;
      if (plays > max) max = plays;
      if (plays < min) min = plays;
    }
  }
  return { min: Number.isFinite(min) ? min : 1, max };
}

/**
 * The safeguard a purely global scale needs: a frame whose biggest artist is
 * far below the range's biggest would otherwise be drawn entirely as dust.
 * The top of the scale is mostly the range's, nudged a quarter of the way
 * (in log space) toward this frame's own — enough to keep a quiet year
 * legible, not enough to make it look like a loud one.
 */
export function frameCeiling(scale: TemporalScale, frameMax: number): number {
  if (frameMax <= 0) return scale.max;
  const blended = Math.exp(
    0.75 * Math.log(scale.max) + 0.25 * Math.log(Math.max(frameMax, 1)),
  );
  return Math.max(blended, scale.min * 1.5);
}

/** Bubble radius for one artist in one frame. Zero plays means no bubble. */
export function radiusIn(
  plays: number,
  scale: TemporalScale,
  ceiling: number,
): number {
  if (plays <= 0) return 0;
  return radiusFor(Math.max(plays, scale.min), scale.min, ceiling);
}

/** The largest play count any mapped artist reached in this frame. */
export function frameMax(
  table: Map<number, TemporalArtist>,
  frameId: string,
): number {
  let max = 0;
  for (const artist of table.values()) {
    const plays = artist.states.get(frameId)?.plays || 0;
    if (plays > max) max = plays;
  }
  return max;
}

/* ─── clusters through time ──────────────────────────────────────────── */

export interface ClusterFrameStats {
  id: number;
  label: string;
  color: string;
  activeArtists: number;
  plays: number;
  /** Share of the frame's mapped listening, 0–1. */
  share: number;
  /** Share in the previous frame, or null when there isn't one. */
  previousShare: number | null;
  strongest: string | null;
  /** The frame's most-played members, for the cluster's "core this year". */
  core: string[];
}

/**
 * Cluster identity comes from the reference graph and never changes; only
 * its weight in a given year does (TE-REQ-11 / §28 / §45).
 */
export function clusterStats(
  artists: Artist[],
  clusters: Cluster[],
  table: Map<number, TemporalArtist>,
  frameId: string,
  previousFrameId: string | null,
): ClusterFrameStats[] {
  const playsIn = (id: number, frame: string) =>
    table.get(id)?.states.get(frame)?.plays || 0;

  const frameTotal = artists.reduce((s, a) => s + playsIn(a.id, frameId), 0);
  const previousTotal = previousFrameId
    ? artists.reduce((s, a) => s + playsIn(a.id, previousFrameId), 0)
    : 0;

  return clusters
    .map((cluster) => {
      const members = artists.filter((a) => a.cluster === cluster.id);
      const active = members.filter((a) => playsIn(a.id, frameId) > 0);
      const plays = active.reduce((s, a) => s + playsIn(a.id, frameId), 0);
      const byPlays = [...active].sort(
        (a, b) => playsIn(b.id, frameId) - playsIn(a.id, frameId),
      );
      const previousPlays = previousFrameId
        ? members.reduce((s, a) => s + playsIn(a.id, previousFrameId), 0)
        : 0;
      return {
        id: cluster.id,
        label: cluster.label,
        color: cluster.color,
        activeArtists: active.length,
        plays,
        share: frameTotal ? plays / frameTotal : 0,
        previousShare:
          previousFrameId && previousTotal ? previousPlays / previousTotal : null,
        strongest: byPlays[0]?.name || null,
        core: byPlays.slice(0, 2).map((a) => a.name),
      };
    })
    .sort((a, b) => b.plays - a.plays);
}

/* ─── what changed ───────────────────────────────────────────────────── */

export interface FrameSummary {
  frameId: string;
  label: string;
  totalPlays: number;
  activeArtists: number;
  complete: boolean;
  topArtist: string | null;
  biggestRiser: { name: string; from: number; to: number } | null;
  biggestFaller: { name: string; from: number; to: number } | null;
  newThisFrame: string[];
  returning: string[];
  retained: number;
  dominantCluster: ClusterFrameStats | null;
  risingCluster: ClusterFrameStats | null;
}

/**
 * The frame's own summary line (§38). Every value here is counted from the
 * play tables — none of it is phrasing invented to sound insightful.
 */
export function summarise(
  frame: TemporalFrame,
  table: Map<number, TemporalArtist>,
  clusters: ClusterFrameStats[],
  previousFrameId: string | null,
): FrameSummary {
  const entries = [...table.values()];
  const playsIn = (a: TemporalArtist, id: string | null) =>
    id ? a.states.get(id)?.plays || 0 : 0;

  const active = entries.filter((a) => playsIn(a, frame.id) > 0);
  const totalPlays = active.reduce((s, a) => s + playsIn(a, frame.id), 0);
  const top = [...active].sort(
    (a, b) => playsIn(b, frame.id) - playsIn(a, frame.id),
  )[0];

  let riser: FrameSummary["biggestRiser"] = null;
  let faller: FrameSummary["biggestFaller"] = null;
  const newThisFrame: string[] = [];
  const returning: string[] = [];
  let retained = 0;

  if (previousFrameId) {
    for (const a of entries) {
      const now = playsIn(a, frame.id);
      const before = playsIn(a, previousFrameId);
      if (now > 0 && before > 0) retained++;
      if (now > 0 && before === 0) {
        // "New" only within the range on screen; whether it is the account's
        // literal first ever scrobble is a claim this data cannot support
        // (§39), so callers word it as a first chart appearance.
        if (a.firstSeen === frame.id) newThisFrame.push(a.name);
        else returning.push(a.name);
      }
      const gain = now - before;
      if (gain > 0 && (!riser || gain > riser.to - riser.from)) {
        riser = { name: a.name, from: before, to: now };
      }
      if (gain < 0 && (!faller || gain < faller.to - faller.from)) {
        faller = { name: a.name, from: before, to: now };
      }
    }
  } else {
    for (const a of active) {
      if (a.firstSeen === frame.id) newThisFrame.push(a.name);
    }
  }

  const rising = clusters
    .filter((c) => c.previousShare !== null)
    .sort(
      (a, b) => b.share - (b.previousShare || 0) - (a.share - (a.previousShare || 0)),
    )[0];

  return {
    frameId: frame.id,
    label: frame.label,
    totalPlays,
    activeArtists: active.length,
    complete: frame.complete,
    topArtist: top?.name || null,
    biggestRiser: riser,
    biggestFaller: faller,
    newThisFrame: newThisFrame.slice(0, 5),
    returning: returning.slice(0, 5),
    retained,
    dominantCluster: clusters[0] || null,
    risingCluster: rising && rising.share > (rising.previousShare || 0) ? rising : null,
  };
}

/* ─── keeping bubbles apart without moving the map ───────────────────── */

/**
 * Bounded collision relief (TE-REQ-29 / §44).
 *
 * Radii change every frame, so bubbles that fitted in 2019 may overlap in
 * 2024. This nudges them apart — but never further than `maxOffset` from
 * where the reference layout put them, and always pulling back toward it, so
 * an artist stays recognisably in the same neighbourhood and a returning
 * artist comes back to the same place (§27). It is emphatically not a fresh
 * force simulation: no similarity is consulted and no global energy is
 * minimised (TE-REQ-28).
 */
export function relax(
  base: Point[],
  radii: number[],
  {
    maxOffset = 26,
    padding = 4,
    passes = 3,
    out,
  }: { maxOffset?: number; padding?: number; passes?: number; out?: Point[] } = {},
): Point[] {
  const n = base.length;
  const pos: Point[] =
    out && out.length === n ? out : base.map((p) => ({ x: p.x, y: p.y }));
  for (let i = 0; i < n; i++) {
    pos[i].x = base[i].x;
    pos[i].y = base[i].y;
  }

  for (let pass = 0; pass < passes; pass++) {
    let moved = 0;
    for (let i = 0; i < n; i++) {
      if (radii[i] <= 0) continue;
      for (let j = i + 1; j < n; j++) {
        if (radii[j] <= 0) continue;
        const dx = pos[j].x - pos[i].x;
        const dy = pos[j].y - pos[i].y;
        const need = radii[i] + radii[j] + padding;
        const d = Math.hypot(dx, dy) || 1e-6;
        if (d >= need) continue;
        const push = (need - d) / 2;
        const ux = dx / d;
        const uy = dy / d;
        pos[i].x -= ux * push;
        pos[i].y -= uy * push;
        pos[j].x += ux * push;
        pos[j].y += uy * push;
        moved++;
      }
    }
    // Clamp back toward the reference position after every pass, so the
    // pushes can never accumulate into a drift across the map.
    for (let i = 0; i < n; i++) {
      const dx = pos[i].x - base[i].x;
      const dy = pos[i].y - base[i].y;
      const d = Math.hypot(dx, dy);
      if (d > maxOffset) {
        pos[i].x = base[i].x + (dx / d) * maxOffset;
        pos[i].y = base[i].y + (dy / d) * maxOffset;
      }
    }
    if (!moved) break;
  }
  return pos;
}

/** The radius a settled reference layout should be built from. */
export function referenceRadius(
  total: number,
  minTotal: number,
  maxTotal: number,
): number {
  if (total <= 0) return RADIUS.min;
  return radiusFor(Math.max(total, minTotal), minTotal, maxTotal);
}
