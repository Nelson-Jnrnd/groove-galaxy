#!/usr/bin/env node
/**
 * Groove Galaxy — snapshot builder.
 *
 * Reads Nelson's Last.fm history, works out which artists are on the map,
 * how similar they are to each other, where that puts them in 2D, and which
 * emergent groups they fall into — then writes one static JSON file that the
 * page renders. Nothing here runs per visitor (SPEC REQ-31): the map is a
 * periodically-refreshed snapshot (§10 "Snapshot", REQ-32).
 *
 *   node scripts/build-snapshot.mjs [--limit 300] [--min-plays 25]
 *                                   [--period overall] [--offline]
 *                                   [--out public/data/snapshot.json]
 *
 * --offline rebuilds layout/clusters from the on-disk API cache only, which
 * is what you want while tuning the layout.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { LastFm, pickImage } from "./lib/lastfm.mjs";
import {
  adjacency,
  forceLayout,
  labelPropagation,
  mdsSeed,
} from "./lib/layout.mjs";

/* ─── Configuration ──────────────────────────────────────────────────── */

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const has = (name) => argv.includes(`--${name}`);

const USERNAME = process.env.LASTFM_USERNAME || "NestorDHCP";
// The same read-only, public-data-only key the personal site's /music page
// ships (see that repo's README, "Music page"). No new credential surface.
const API_KEY =
  process.env.LASTFM_API_KEY || "130e996340687500f9e282660628d30f";

/**
 * REQ-2 — the inclusion rule, decided here and stated in the snapshot so the
 * page can show it verbatim (REQ-3).
 *
 * All-time top artists, capped at 300, and only artists with at least 25
 * scrobbles. The cap keeps the map explorable and the build inside Last.fm's
 * rate limits; the floor drops the one-play tail that would otherwise be
 * noise with no similarity structure to place it by.
 */
const CONFIG = {
  period: flag("period", "overall"),
  limit: Number(flag("limit", 300)),
  minPlays: Number(flag("min-plays", 25)),
  /** Similarity edges kept per artist (strongest first). */
  edgesPerArtist: 10,
  /** Below this Last.fm match score an edge is too weak to mean anything. */
  minMatch: 0.05,
  /** Bubble radius range, in layout units. */
  radius: { min: 11, max: 58 },
  /**
   * Pull toward the map's centre. This is what sets the map's overall
   * density: too low and artists with no in-set similarity drift thousands
   * of units into empty space, too high and the clusters crush together.
   */
  gravity: Number(flag("gravity", 0.6)),
  out: flag("out", "public/data/snapshot.json"),
  offline: has("offline"),
};

/** Cluster colours (OQ-8). Deliberately muted, tuned for the site's
 *  off-black background, and assigned by cluster size — the colour carries a
 *  derived cluster identity and nothing else. No colour means a genre, and
 *  no axis meaning is smuggled in through it (REQ-11). */
const PALETTE = [
  "#e3b23c", // site gold
  "#5fa877", // site green
  "#6f9fd8",
  "#c98a9b",
  "#9b8bd0",
  "#d98b5f",
  "#6fb3a8",
  "#b6a98c",
  "#8fae62",
  "#cf7f7f",
  "#7f9ec9",
  "#c0a5d3",
];

const log = (...args) => console.log("·", ...args);

/* ─── 1. Which artists are on the map ────────────────────────────────── */

async function fetchArtists(api) {
  const perPage = 500;
  const pages = Math.ceil(CONFIG.limit / perPage) || 1;
  const collected = [];
  let total = 0;

  for (let page = 1; page <= pages; page++) {
    const data = await api.call(
      {
        method: "user.gettopartists",
        user: USERNAME,
        period: CONFIG.period,
        limit: String(perPage),
        page: String(page),
      },
      { offline: CONFIG.offline },
    );
    const block = data && data.topartists;
    if (!block) break;
    total = Number(block["@attr"] && block["@attr"].total) || total;
    const list = Array.isArray(block.artist)
      ? block.artist
      : block.artist
        ? [block.artist]
        : [];
    collected.push(...list);
    if (list.length < perPage) break;
  }

  const artists = collected
    .map((a) => ({
      name: (a.name || "").trim(),
      plays: Number(a.playcount) || 0,
      url: a.url || "",
    }))
    .filter((a) => a.name && a.plays >= CONFIG.minPlays)
    .slice(0, CONFIG.limit);

  return { artists, totalScrobbledArtists: total };
}

/* ─── 2. Similarity, tags and artwork ────────────────────────────────── */

const normalise = (name) => name.toLowerCase().normalize("NFKD").trim();

async function fetchSimilarity(api, artists) {
  const index = new Map(artists.map((a, i) => [normalise(a.name), i]));
  /** pair key "i:j" (i<j) → strongest match score seen in either direction */
  const pairs = new Map();

  for (const [i, artist] of artists.entries()) {
    const data = await api
      .call(
        {
          method: "artist.getsimilar",
          artist: artist.name,
          autocorrect: "1",
          limit: "100",
        },
        { offline: CONFIG.offline },
      )
      .catch(() => null);

    const raw = data && data.similarartists && data.similarartists.artist;
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    for (const other of list) {
      const j = index.get(normalise(other.name || ""));
      if (j === undefined || j === i) continue;
      const score = Number(other.match);
      if (!Number.isFinite(score) || score < CONFIG.minMatch) continue;
      const key = i < j ? `${i}:${j}` : `${j}:${i}`;
      pairs.set(key, Math.max(pairs.get(key) || 0, score));
    }
    if ((i + 1) % 50 === 0) log(`similarity ${i + 1}/${artists.length}`);
  }

  // Keep only each artist's strongest edges, so one hub artist with a
  // hundred in-set matches can't drag the whole map into its lap.
  const perNode = artists.map(() => []);
  for (const [key, w] of pairs) {
    const [a, b] = key.split(":").map(Number);
    perNode[a].push({ other: b, w });
    perNode[b].push({ other: a, w });
  }
  const kept = new Map();
  for (const [i, list] of perNode.entries()) {
    list.sort((x, y) => y.w - x.w);
    for (const { other, w } of list.slice(0, CONFIG.edgesPerArtist)) {
      const key = i < other ? `${i}:${other}` : `${other}:${i}`;
      kept.set(key, w);
    }
  }

  const edges = [...kept].map(([key, w]) => {
    const [a, b] = key.split(":").map(Number);
    return { a, b, w };
  });

  // Full (unpruned) neighbour lists, for the detail panel's "closest on this
  // map" list (REQ-13/REQ-15).
  const neighbours = perNode.map((list) =>
    list.sort((x, y) => y.w - x.w).slice(0, 6),
  );

  return { edges, neighbours };
}

async function fetchTags(api, artists) {
  const out = [];
  for (const [i, artist] of artists.entries()) {
    const data = await api
      .call(
        {
          method: "artist.gettoptags",
          artist: artist.name,
          autocorrect: "1",
        },
        { offline: CONFIG.offline },
      )
      .catch(() => null);
    const raw = data && data.toptags && data.toptags.tag;
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    out.push(
      list
        .filter((t) => Number(t.count) >= 15)
        .map((t) => (t.name || "").trim().toLowerCase())
        .filter(Boolean)
        .slice(0, 8),
    );
    if ((i + 1) % 50 === 0) log(`tags ${i + 1}/${artists.length}`);
  }
  return out;
}

/**
 * Artist artwork (REQ-7).
 *
 * Last.fm stopped serving real artist portraits — `artist.getInfo` returns
 * the known placeholder hash for everyone — so the artist's most-played
 * album cover stands in as their visual identity. Still Last.fm data, still
 * the same key, and the placeholder check is the same one /music uses.
 * Artists whose covers are all placeholders simply get the clean fallback.
 */
async function fetchArtwork(api, artists) {
  const out = [];
  for (const [i, artist] of artists.entries()) {
    let image = "";
    const info = await api
      .call(
        {
          method: "artist.gettopalbums",
          artist: artist.name,
          autocorrect: "1",
          limit: "6",
        },
        { offline: CONFIG.offline },
      )
      .catch(() => null);
    const raw = info && info.topalbums && info.topalbums.album;
    const albums = Array.isArray(raw) ? raw : raw ? [raw] : [];
    for (const album of albums) {
      image = pickImage(album.image);
      if (image) break;
    }
    out.push(image);
    if ((i + 1) % 50 === 0) log(`artwork ${i + 1}/${artists.length}`);
  }
  return out;
}

/* ─── 3. Sizing, clustering, layout ──────────────────────────────────── */

/**
 * REQ-5 / OQ-7 — radius from play count.
 *
 * Play counts are heavily skewed (thousands at the top, tens in the tail),
 * so this is logarithmic: strictly monotonic in plays, but the tail still
 * renders as bubbles rather than dust.
 */
function radiusFor(plays, minPlays, maxPlays) {
  const { min, max } = CONFIG.radius;
  if (maxPlays <= minPlays) return (min + max) / 2;
  const t =
    (Math.log(plays) - Math.log(minPlays)) /
    (Math.log(maxPlays) - Math.log(minPlays));
  return min + (max - min) * Math.pow(t, 0.85);
}

/**
 * OQ-4 — a cluster's label, derived rather than authored.
 *
 * Among the cluster's members' Last.fm tags, pick the one that is both
 * common *inside* the cluster and comparatively rare outside it (a small
 * tf-idf), so clusters don't all end up called "electronic". This names a
 * region after what the data says its members share; it is not a genre
 * assignment, and no artist was placed by it.
 */
function labelCluster(memberIds, tagsByArtist, globalTagCounts, artists) {
  const local = new Map();
  for (const id of memberIds) {
    for (const tag of tagsByArtist[id] || []) {
      local.set(tag, (local.get(tag) || 0) + 1);
    }
  }
  let best = "";
  let bestScore = 0;
  for (const [tag, count] of local) {
    if (count < 2) continue;
    const share = count / memberIds.length;
    const distinctiveness = count / (globalTagCounts.get(tag) || count);
    const score = share * Math.pow(distinctiveness, 1.5);
    if (score > bestScore) {
      bestScore = score;
      best = tag;
    }
  }
  if (best) return best;
  // No shared tags at all — fall back to the cluster's heaviest artist.
  const top = [...memberIds].sort(
    (a, b) => artists[b].plays - artists[a].plays,
  )[0];
  return artists[top] ? `around ${artists[top].name}` : "unlabelled";
}

/* ─── Main ───────────────────────────────────────────────────────────── */

async function main() {
  const api = new LastFm({ apiKey: API_KEY });

  log(
    `snapshot for ${USERNAME} — period=${CONFIG.period} limit=${CONFIG.limit} minPlays=${CONFIG.minPlays}${CONFIG.offline ? " (offline/cache-only)" : ""}`,
  );

  const { artists, totalScrobbledArtists } = await fetchArtists(api);
  if (!artists.length) {
    throw new Error(
      "No artists matched the inclusion rule — refusing to write an empty snapshot.",
    );
  }
  log(`${artists.length} artists in scope (of ${totalScrobbledArtists} ever scrobbled)`);

  const { edges, neighbours } = await fetchSimilarity(api, artists);
  log(`${edges.length} similarity edges`);

  const tagsByArtist = await fetchTags(api, artists);
  const artwork = await fetchArtwork(api, artists);
  log(`${artwork.filter(Boolean).length}/${artists.length} artists have usable artwork`);

  const n = artists.length;
  const adj = adjacency(n, edges);

  // Sizes first — the layout needs radii to keep bubbles from overlapping.
  const playCounts = artists.map((a) => a.plays);
  const minPlays = Math.min(...playCounts);
  const maxPlays = Math.max(...playCounts);
  const radii = playCounts.map((p) => radiusFor(p, minPlays, maxPlays));

  log("laying out (MDS seed → force simulation)…");
  const seed = mdsSeed(n, adj);
  const positions = forceLayout(seed, radii, edges, {
    gravity: CONFIG.gravity,
  });

  log("clustering (label propagation)…");
  const rawLabels = labelPropagation(n, adj);
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const key = adj[i].length ? rawLabels[i] : -1; // isolated artists group apart
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(i);
  }
  // Clusters of one or two aren't a cluster — fold them into "unclustered".
  const loose = [];
  const real = [];
  for (const [, members] of groups) {
    if (members.length >= 3) real.push(members);
    else loose.push(...members);
  }
  real.sort((a, b) => b.length - a.length);

  const globalTagCounts = new Map();
  for (const tags of tagsByArtist) {
    for (const tag of tags) {
      globalTagCounts.set(tag, (globalTagCounts.get(tag) || 0) + 1);
    }
  }

  const clusterOf = new Int32Array(n).fill(-1);
  const clusters = real.map((members, id) => {
    for (const m of members) clusterOf[m] = id;
    const byPlays = [...members].sort(
      (a, b) => artists[b].plays - artists[a].plays,
    );
    return {
      id,
      color: PALETTE[id % PALETTE.length],
      label: labelCluster(members, tagsByArtist, globalTagCounts, artists),
      size: members.length,
      anchor: artists[byPlays[0]].name,
      plays: members.reduce((s, m) => s + artists[m].plays, 0),
    };
  });
  log(
    `${clusters.length} clusters, ${loose.length} artists outside any cluster`,
  );

  const nodes = artists.map((artist, i) => ({
    id: i,
    name: artist.name,
    plays: artist.plays,
    url: artist.url,
    image: artwork[i] || "",
    tags: (tagsByArtist[i] || []).slice(0, 4),
    x: Number(positions[i].x.toFixed(2)),
    y: Number(positions[i].y.toFixed(2)),
    r: Number(radii[i].toFixed(2)),
    cluster: clusterOf[i],
    similar: neighbours[i].map(({ other, w }) => ({
      id: other,
      score: Number(w.toFixed(3)),
    })),
  }));

  const xs = nodes.map((nd) => nd.x);
  const ys = nodes.map((nd) => nd.y);
  const pad = Math.max(...radii) * 2;

  const snapshot = {
    version: 1,
    generatedAt: new Date().toISOString(),
    user: USERNAME,
    profileUrl: `https://www.last.fm/user/${encodeURIComponent(USERNAME)}`,
    source: "Last.fm",
    selection: {
      period: CONFIG.period,
      limit: CONFIG.limit,
      minPlays: CONFIG.minPlays,
      included: nodes.length,
      totalScrobbledArtists,
      // REQ-3: shown verbatim on the page.
      description: `The ${nodes.length} artists with the most all-time scrobbles on Last.fm (minimum ${CONFIG.minPlays} plays), out of ${totalScrobbledArtists.toLocaleString("en-US")} ever scrobbled.`,
    },
    method: {
      size: "Bubble area grows with play count on a logarithmic scale.",
      position:
        "Artists are pulled together by Last.fm's artist-to-artist similarity scores and pushed apart by everything else, then relaxed until no two bubbles overlap.",
      clusters:
        "Colours come from label propagation over the same similarity graph; each label is the tag most distinctive to that group's members.",
      axes:
        "Only distance between bubbles carries meaning. The horizontal and vertical directions do not.",
    },
    stats: {
      artists: nodes.length,
      edges: edges.length,
      clusters: clusters.length,
      withArtwork: artwork.filter(Boolean).length,
      apiCalls: api.calls,
    },
    bounds: {
      minX: Math.min(...xs) - pad,
      maxX: Math.max(...xs) + pad,
      minY: Math.min(...ys) - pad,
      maxY: Math.max(...ys) + pad,
    },
    clusters,
    artists: nodes,
    edges: edges.map(({ a, b, w }) => [a, b, Number(w.toFixed(3))]),
  };

  const outPath = path.resolve(CONFIG.out);
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(snapshot));
  log(
    `wrote ${path.relative(process.cwd(), outPath)} — ${api.calls} API calls, ${api.cacheHits} cache hits`,
  );
}

main().catch((err) => {
  console.error("snapshot build failed:", err.message);
  process.exit(1);
});
