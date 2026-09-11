/**
 * The temporal model: who is on the map, what they were worth in each year,
 * and the promise that none of it moves the map around (§52).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { aggregateFrame, type WeekChart } from "../src/lib/history.ts";
import type { TemporalFrame } from "../src/lib/history.ts";
import type { ChartWeek } from "../src/lib/lastfm.ts";
import {
  buildStates,
  buildUniverse,
  clusterStats,
  frameCeiling,
  frameMax,
  playScale,
  radiusIn,
  relax,
  summarise,
} from "../src/lib/temporal.ts";
import { group, type Artist, type Cluster } from "../src/lib/build.ts";
import { adjacency, type Edge } from "../src/lib/layout.ts";

/* ─── fixtures ───────────────────────────────────────────────────────── */

const week = (fromIso: string, toIso: string): ChartWeek => ({
  from: Math.floor(Date.parse(fromIso) / 1000),
  to: Math.floor(Date.parse(toIso) / 1000),
});

/** A frame built the way the app builds one: out of a week's chart. */
function frameOf(id: string, entries: [string, number][]): TemporalFrame {
  const w = week(`${id}-06-03T00:00:00Z`, `${id}-06-10T00:00:00Z`);
  const chart: WeekChart = {
    week: w,
    artists: entries.map(([name, plays]) => ({ name, plays, url: "" })),
  };
  return aggregateFrame(id, [chart]);
}

function artistsOf(names: string[]): Artist[] {
  return names.map((name, id) => ({
    id,
    name,
    plays: 0,
    url: "",
    image: "",
    tags: [],
    r: 10,
    cluster: -1,
    similar: [],
    x: 0,
    y: 0,
  }));
}

/* ─── the universe ───────────────────────────────────────────────────── */

test("an artist who defines one year alone still gets on the map", () => {
  // Ten years of the same three artists, plus one year where somebody else
  // owned the account entirely. Their lifetime total is small; their year is
  // not (TE-REQ-5).
  const frames: TemporalFrame[] = [];
  for (let year = 2014; year < 2024; year++) {
    frames.push(
      frameOf(String(year), [
        ["Muse", 400],
        ["Daft Punk", 300],
        ["Parcels", 200],
      ]),
    );
  }
  frames.push(frameOf("2024", [["Gesaffelstein", 120], ["Muse", 10]]));

  const universe = buildUniverse(frames, { perFrame: 2, max: 4 });
  assert.ok(universe.includes("Gesaffelstein"));
});

test("the universe is capped", () => {
  const frames = [
    frameOf(
      "2024",
      Array.from({ length: 400 }, (_, i) => [`Artist ${i}`, 400 - i] as [string, number]),
    ),
  ];
  assert.equal(buildUniverse(frames, { perFrame: 50, max: 300 }).length, 300);
});

/* ─── per-frame state ────────────────────────────────────────────────── */

test("an artist can appear, disappear and return", () => {
  const frames = [
    frameOf("2020", [["Justice", 90], ["Muse", 40]]),
    frameOf("2021", [["Muse", 40]]),
    frameOf("2022", [["Muse", 40]]),
    frameOf("2023", [["Muse", 40]]),
    frameOf("2024", [["Justice", 300], ["Muse", 40]]),
  ];
  const artists = artistsOf(["Justice", "Muse"]);
  const table = buildStates(artists, frames);
  const justice = table.get(0)!;

  assert.equal(justice.states.get("2020")!.active, true);
  assert.equal(justice.states.get("2022")!.active, false);
  assert.equal(justice.states.get("2022")!.plays, 0);
  assert.equal(justice.states.get("2024")!.active, true);
  assert.equal(justice.firstSeen, "2020");
  assert.equal(justice.lastSeen, "2024");
  assert.equal(justice.total, 390);

  // Rank and share are counted among mapped artists only.
  assert.equal(justice.states.get("2024")!.rank, 1);
  assert.ok(Math.abs(justice.states.get("2024")!.share! - 300 / 340) < 1e-9);
});

test("an artist present in only one year is inactive in every other", () => {
  const frames = [
    frameOf("2023", [["Muse", 50]]),
    frameOf("2024", [["Muse", 50], ["Wunderhorse", 80]]),
  ];
  const table = buildStates(artistsOf(["Muse", "Wunderhorse"]), frames);
  const wunderhorse = table.get(1)!;
  assert.equal(wunderhorse.states.get("2023")!.active, false);
  assert.equal(wunderhorse.states.get("2024")!.plays, 80);
  assert.equal(wunderhorse.firstSeen, "2024");
});

test("a zero-listening frame leaves everyone inactive rather than breaking", () => {
  const frames = [frameOf("2017", []), frameOf("2018", [["Muse", 20]])];
  const artists = artistsOf(["Muse"]);
  const table = buildStates(artists, frames);
  assert.equal(table.get(0)!.states.get("2017")!.active, false);

  const scale = playScale(table, frames);
  const ceiling = frameCeiling(scale, frameMax(table, "2017"));
  assert.equal(radiusIn(0, scale, ceiling), 0);
  const stats = clusterStats(artists, [], table, "2017", null);
  assert.deepEqual(stats, []);
  const summary = summarise(frames[0], table, stats, null);
  assert.equal(summary.totalPlays, 0);
  assert.equal(summary.activeArtists, 0);
});

/* ─── bubble size ────────────────────────────────────────────────────── */

test("bubble size is comparable between years, not renormalised per year", () => {
  const frames = [
    frameOf("2024", [["A", 50]]),
    frameOf("2025", [["A", 500]]),
  ];
  const table = buildStates(artistsOf(["A"]), frames);
  const scale = playScale(table, frames);

  const small = radiusIn(50, scale, frameCeiling(scale, frameMax(table, "2024")));
  const large = radiusIn(500, scale, frameCeiling(scale, frameMax(table, "2025")));
  assert.ok(large > small * 1.3, `${large} should dwarf ${small}`);
  // …and the quiet year is still a readable bubble rather than a dot.
  assert.ok(small > 0);
});

/* ─── clusters ───────────────────────────────────────────────────────── */

test("cluster identity and colour are fixed by the reference graph", () => {
  // Two triangles joined by nothing: two communities, whatever the year.
  const artists = artistsOf(["A", "B", "C", "X", "Y", "Z"]);
  const edges: Edge[] = [
    { a: 0, b: 1, w: 1 }, { a: 1, b: 2, w: 1 }, { a: 0, b: 2, w: 1 },
    { a: 3, b: 4, w: 1 }, { a: 4, b: 5, w: 1 }, { a: 3, b: 5, w: 1 },
  ];
  const clusters: Cluster[] = group(artists, adjacency(artists.length, edges));
  assert.equal(clusters.length, 2);
  const identity = artists.map((a) => a.cluster);
  const colours = clusters.map((c) => c.color);

  const frames = [
    frameOf("2023", [["A", 100], ["B", 50], ["C", 10]]),
    frameOf("2024", [["X", 200], ["Y", 30], ["A", 5]]),
  ];
  const table = buildStates(artists, frames);

  const first = clusterStats(artists, clusters, table, "2023", null);
  const second = clusterStats(artists, clusters, table, "2024", "2023");

  // Membership and colour are untouched by moving through time.
  assert.deepEqual(artists.map((a) => a.cluster), identity);
  assert.deepEqual(clusters.map((c) => c.color), colours);
  for (const stats of [first, second]) {
    for (const c of stats) {
      assert.equal(c.color, clusters[c.id].color);
      assert.equal(c.label, clusters[c.id].label);
    }
  }

  // What does change is the weight: ABC owns 2023, XY owns 2024.
  assert.equal(first[0].strongest, "A");
  assert.equal(second[0].strongest, "X");
  assert.ok(second[0].previousShare !== null);
});

/* ─── summaries ──────────────────────────────────────────────────────── */

test("risers, fallers, newcomers and returners are counted, not narrated", () => {
  const frames = [
    frameOf("2023", [["Justice", 100], ["Muse", 200], ["Parcels", 60]]),
    frameOf("2024", [["Justice", 400], ["Muse", 20], ["Wunderhorse", 30]]),
  ];
  const artists = artistsOf(["Justice", "Muse", "Parcels", "Wunderhorse"]);
  const table = buildStates(artists, frames);
  const stats = clusterStats(artists, [], table, "2024", "2023");
  const summary = summarise(frames[1], table, stats, "2023");

  assert.equal(summary.topArtist, "Justice");
  assert.equal(summary.biggestRiser!.name, "Justice");
  assert.equal(summary.biggestFaller!.name, "Muse");
  assert.deepEqual(summary.newThisFrame, ["Wunderhorse"]);
  assert.equal(summary.retained, 2);
  assert.equal(summary.activeArtists, 3);
});

test("an artist coming back is reported as returning, not as new", () => {
  const frames = [
    frameOf("2022", [["Justice", 50]]),
    frameOf("2023", [["Muse", 50]]),
    frameOf("2024", [["Justice", 90]]),
  ];
  const table = buildStates(artistsOf(["Justice", "Muse"]), frames);
  const summary = summarise(frames[2], table, [], "2023");
  assert.deepEqual(summary.returning, ["Justice"]);
  assert.deepEqual(summary.newThisFrame, []);
});

test("comparisons are absent when there is no previous frame", () => {
  const frames = [frameOf("2019", [["Muse", 30]])];
  const table = buildStates(artistsOf(["Muse"]), frames);
  const summary = summarise(frames[0], table, [], null);
  assert.equal(summary.biggestRiser, null);
  assert.equal(summary.biggestFaller, null);
  assert.equal(summary.retained, 0);
});

test("an incomplete frame is carried through to the summary", () => {
  const w = week("2024-06-03T00:00:00Z", "2024-06-10T00:00:00Z");
  const frame = aggregateFrame("2024", [
    { week: w, artists: [{ name: "Muse", plays: 10, url: "" }] },
    { week: w, artists: null },
  ]);
  const table = buildStates(artistsOf(["Muse"]), [frame]);
  assert.equal(summarise(frame, table, [], null).complete, false);
});

/* ─── geography ──────────────────────────────────────────────────────── */

test("collision relief keeps every bubble near its reference position", () => {
  const base = [
    { x: 0, y: 0 },
    { x: 5, y: 0 },
    { x: 10, y: 0 },
    { x: 200, y: 200 },
  ];
  const radii = [40, 40, 40, 5];
  const moved = relax(base, radii, { maxOffset: 20 });
  for (let i = 0; i < base.length; i++) {
    const drift = Math.hypot(moved[i].x - base[i].x, moved[i].y - base[i].y);
    assert.ok(drift <= 20 + 1e-9, `node ${i} drifted ${drift}`);
  }
});

test("the same radii give the same coordinates every time (§27)", () => {
  const base = [
    { x: 0, y: 0 },
    { x: 12, y: 3 },
    { x: -8, y: 20 },
  ];
  const active = [30, 30, 30];
  const away = [30, 0, 30];

  const inYear1 = relax(base, active, { maxOffset: 20 });
  const inYear2 = relax(base, away, { maxOffset: 20 });
  const backAgain = relax(base, active, { maxOffset: 20 });

  // An artist who leaves and comes back lands exactly where they were.
  assert.deepEqual(backAgain, inYear1);
  // …and one who never left barely notices the neighbour going quiet.
  assert.ok(
    Math.hypot(inYear2[0].x - base[0].x, inYear2[0].y - base[0].y) <= 20 + 1e-9,
  );
});

test("an artist absent from the frame is not pushed around by the living", () => {
  const base = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
  ];
  const moved = relax(base, [40, 0], { maxOffset: 20 });
  assert.deepEqual(moved[1], base[1]);
  assert.deepEqual(moved[0], base[0]);
});
