/**
 * The exploration algorithms (EXP §24).
 *
 * Everything the feature claims about *why* an artist is on screen comes
 * from these functions, so they are pinned here: which artists count as
 * beyond the Galaxy, how their support is counted, the order they come out
 * in, what a System is allowed to contain, and where travelling leaves the
 * trail. The rendering is free to change; these answers are not.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { Artist } from "../src/lib/build.ts";
import type { SimilarArtist } from "../src/lib/lastfm.ts";
import {
  aggregateFrontier,
  back,
  deadEnd,
  beginExploration,
  buildSystem,
  collapseTrail,
  currentAnchor,
  describeSystem,
  galaxyIndex,
  layoutSystem,
  placeFrontier,
  previousAnchor,
  travel,
  type ExploreState,
} from "../src/lib/explore.ts";

/* ─── fixtures ───────────────────────────────────────────────────────── */

let nextId = 0;
function artist(name: string, extra: Partial<Artist> = {}): Artist {
  return {
    id: nextId++,
    name,
    plays: 100,
    url: `https://www.last.fm/music/${name}`,
    image: "",
    tags: [],
    r: 20,
    cluster: 0,
    similar: [],
    x: 0,
    y: 0,
    ...extra,
  };
}

const like = (pairs: [string, number][]): SimilarArtist[] =>
  pairs.map(([name, match]) => ({ name, match }));

/* ─── Frontier aggregation (EXP-REQ-4) ───────────────────────────────── */

test("artists already in the Galaxy are territory, not frontier", () => {
  const daft = artist("Daft Punk");
  const justice = artist("Justice");
  const elsewhere = artist("Aphex Twin", { cluster: 1 });
  const galaxy = galaxyIndex([daft, justice, elsewhere]);

  const frontier = aggregateFrontier(
    [daft, justice],
    new Map([
      // Members point at each other, at an artist in another part of the
      // same Galaxy, and at one genuinely outside it.
      [daft.id, like([["Justice", 0.9], ["Aphex Twin", 0.4], ["Breakbot", 0.7]])],
      [justice.id, like([["Daft Punk", 0.9], ["Breakbot", 0.8]])],
    ]),
    galaxy,
  );

  assert.deepEqual(
    frontier.map((c) => c.name),
    ["Breakbot"],
    "only artists outside the whole Galaxy are candidates",
  );
});

test("the same artist under different spellings is one candidate", () => {
  const a = artist("Justice");
  const b = artist("SebastiAn");
  const galaxy = galaxyIndex([a, b]);

  const [breakbot] = aggregateFrontier(
    [a, b],
    new Map([
      // Casing, accents and a repeat from the same member.
      [a.id, like([["Breakbot", 0.6], ["BREAKBOT", 0.81], ["Séb", 0.3]])],
      [b.id, like([["breakbot", 0.5]])],
    ]),
    galaxy,
  );

  assert.equal(breakbot.name, "Breakbot");
  assert.equal(breakbot.supportCount, 2, "one member counts once, at its best");
  assert.equal(breakbot.links.length, 2);
  assert.equal(Math.round(breakbot.sumMatch * 100), 131);
  assert.equal(breakbot.maxMatch, 0.81);
});

test("support is counted, summed and maxed across the region", () => {
  const one = artist("One");
  const two = artist("Two");
  const three = artist("Three");
  const galaxy = galaxyIndex([one, two, three]);

  const found = aggregateFrontier(
    [one, two, three],
    new Map([
      [one.id, like([["Wide", 0.3], ["Deep", 0.95]])],
      [two.id, like([["Wide", 0.35]])],
      [three.id, like([["Wide", 0.25]])],
    ]),
    galaxy,
  );

  const wide = found.find((c) => c.name === "Wide")!;
  const deep = found.find((c) => c.name === "Deep")!;
  assert.equal(wide.supportCount, 3);
  assert.equal(Math.round(wide.sumMatch * 100), 90);
  assert.equal(wide.maxMatch, 0.35);
  assert.equal(deep.supportCount, 1);
  assert.equal(deep.maxMatch, 0.95);

  // EXP-REQ-4 — several members pointing the same way beats one strong tie:
  // that is what "just beyond *this region*" means.
  assert.deepEqual(found.map((c) => c.name), ["Wide", "Deep"]);
  assert.deepEqual(
    wide.links.map((l) => l.artistId),
    [two.id, one.id, three.id],
    "supporting artists come out strongest first",
  );
});

test("ordering is deterministic, whatever order the answers arrived in", () => {
  const one = artist("One");
  const two = artist("Two");
  const galaxy = galaxyIndex([one, two]);
  const lists = new Map([
    [one.id, like([["Beta", 0.4], ["Alpha", 0.4], ["Solo", 0.9]])],
    [two.id, like([["Alpha", 0.4], ["Beta", 0.4]])],
  ]);

  const first = aggregateFrontier([one, two], lists, galaxy);
  const again = aggregateFrontier([two, one], lists, galaxy);
  assert.deepEqual(first.map((c) => c.name), again.map((c) => c.name));
  // Equal support and equal weight: the name breaks the tie rather than
  // insertion order, so the frontier does not reshuffle between visits.
  assert.deepEqual(first.map((c) => c.name), ["Alpha", "Beta", "Solo"]);
});

test("noise below the similarity floor never reaches the frontier", () => {
  const one = artist("One");
  const galaxy = galaxyIndex([one]);
  const found = aggregateFrontier(
    [one],
    new Map([[one.id, like([["Faint", 0.01], ["Real", 0.4], ["", 0.9]])]]),
    galaxy,
  );
  assert.deepEqual(found.map((c) => c.name), ["Real"]);
});

/* ─── System neighbour selection (EXP-REQ-9/14) ──────────────────────── */

const GALAXY = [
  artist("Daft Punk"),
  artist("Justice"),
  artist("SebastiAn", { cluster: 1 }),
  artist("Kavinsky"),
];
const INDEX = galaxyIndex(GALAXY);

test("a System respects its cap and keeps room for what lies beyond", () => {
  const similar = like([
    ["Daft Punk", 0.99],
    ["Justice", 0.98],
    ["SebastiAn", 0.97],
    ["Kavinsky", 0.96],
    ["Breakbot", 0.5],
    ["Boys Noize", 0.45],
    ["Gesaffelstein", 0.4],
    ["Mr. Oizo", 0.35],
    ["Soulwax", 0.3],
  ]);

  const system = buildSystem({
    anchor: "Anchor",
    similar,
    galaxy: INDEX,
    limit: 5,
    reserve: 3,
  });

  assert.equal(system.neighbours.length, 5);
  const beyond = system.neighbours.filter((n) => n.status === "frontier");
  assert.equal(beyond.length, 3, "outside artists keep their reserved slots");
  assert.deepEqual(
    beyond.map((n) => n.name),
    ["Breakbot", "Boys Noize", "Gesaffelstein"],
    "and they are the strongest outside artists, not just any three",
  );
  // The Galaxy artists that survived are the closest ones.
  assert.deepEqual(
    system.neighbours.filter((n) => n.status === "galaxy").map((n) => n.name),
    ["Daft Punk", "Justice"],
  );
});

test("Galaxy artists are identified, coloured by their own group, and sized by nothing", () => {
  const system = buildSystem({
    anchor: "Anchor",
    similar: like([["SebastiAn", 0.8], ["Breakbot", 0.7]]),
    galaxy: INDEX,
  });
  const known = system.neighbours.find((n) => n.name === "SebastiAn")!;
  const beyond = system.neighbours.find((n) => n.name === "Breakbot")!;

  assert.equal(known.status, "galaxy");
  assert.equal(known.clusterId, 1, "known territory keeps its group identity");
  assert.equal(known.galaxyArtistId, INDEX.get("sebastian")!.id);
  assert.equal(beyond.status, "frontier");
  assert.equal(beyond.clusterId, undefined, "an outside artist has no cluster");
  // §23 — nothing here carries a play count or a radius to misread.
  assert.ok(!("plays" in beyond));
  assert.ok(!("r" in beyond));
});

test("an artist visited on this trail reads as explored, not as new", () => {
  const system = buildSystem({
    anchor: "Anchor",
    similar: like([["Breakbot", 0.7], ["Boys Noize", 0.6]]),
    galaxy: INDEX,
    explored: new Set(["breakbot"]),
  });
  assert.equal(system.neighbours.find((n) => n.name === "Breakbot")!.status, "explored");
  assert.equal(system.neighbours.find((n) => n.name === "Boys Noize")!.status, "frontier");
});

test("the way back stays on screen even past the cutoff (EXP-REQ-14)", () => {
  const similar = like([
    ["Breakbot", 0.9],
    ["Boys Noize", 0.8],
    ["Gesaffelstein", 0.7],
  ]);

  const kept = buildSystem({
    anchor: "Anchor",
    similar,
    galaxy: INDEX,
    limit: 2,
    reserve: 0,
    previous: "Gesaffelstein",
  });
  assert.ok(kept.neighbours.some((n) => n.name === "Gesaffelstein"));
  assert.equal(kept.neighbours.length, 2, "it takes a slot rather than adding one");

  // …even when the artist travelled from is not in this artist's list at all.
  const unlisted = buildSystem({
    anchor: "Anchor",
    similar,
    galaxy: INDEX,
    limit: 3,
    previous: "L'Impératrice",
  });
  assert.ok(unlisted.neighbours.some((n) => n.name === "L'Impératrice"));
});

test("a duplicated or self-referential name cannot produce a duplicate node", () => {
  // Normalisation is the map's own: case and surrounding space are noise,
  // so "breakbot" and "Breakbot" are one artist. Accents are not folded —
  // they distinguish real and different artist names.
  const system = buildSystem({
    anchor: "Justice",
    similar: like([
      ["Justice", 0.99],
      ["JUSTICE", 0.99],
      ["Breakbot", 0.7],
      ["breakbot", 0.65],
      ["  Breakbot  ", 0.6],
    ]),
    galaxy: INDEX,
    previous: "BREAKBOT",
  });
  assert.deepEqual(system.neighbours.map((n) => n.name), ["Breakbot"]);
  assert.equal(system.anchor.name, "Justice");
});

test("a System with nothing in it is a dead end, not a failure", () => {
  const system = buildSystem({ anchor: "Obscure", similar: [], galaxy: INDEX });
  assert.deepEqual(system.neighbours, []);
  assert.match(describeSystem(system), /No further strong connections/);
});

test("a System whose only node is the way back is a dead end (§22)", () => {
  const nowhere = buildSystem({
    anchor: "Obscure",
    similar: [],
    galaxy: INDEX,
    previous: "Breakbot",
  });
  // The way back is on screen — but it is not a turning, so the System says
  // so rather than implying there is somewhere further to go.
  assert.deepEqual(nowhere.neighbours.map((n) => n.name), ["Breakbot"]);
  assert.ok(deadEnd(nowhere, "Breakbot"));

  const onwards = buildSystem({
    anchor: "Obscure",
    similar: like([["Boys Noize", 0.4]]),
    galaxy: INDEX,
    previous: "Breakbot",
  });
  assert.ok(!deadEnd(onwards, "Breakbot"));
  assert.ok(deadEnd(buildSystem({ anchor: "Obscure", similar: [], galaxy: INDEX })));
});

test("a System announces itself in terms of known and unknown (§21)", () => {
  const system = buildSystem({
    anchor: "Justice",
    similar: like([["Daft Punk", 0.9], ["Breakbot", 0.7], ["Boys Noize", 0.6]]),
    galaxy: INDEX,
  });
  assert.equal(
    describeSystem(system),
    "Exploring Justice. 1 related artist is in your Galaxy and 2 are beyond it.",
  );
});

/* ─── navigation (EXP §24) ───────────────────────────────────────────── */

const entry = (name: string, status: "galaxy" | "frontier" = "frontier") => ({
  name,
  status,
});

test("Galaxy → System starts a trail at the artist it was opened from", () => {
  const state = beginExploration({ kind: "galaxy" }, entry("Daft Punk", "galaxy"));
  assert.deepEqual(state.trail.map((e) => e.name), ["Daft Punk"]);
  assert.equal(state.origin.kind, "galaxy");
  assert.equal(currentAnchor(state).name, "Daft Punk");
  assert.equal(previousAnchor(state), null);
  assert.equal(back(state), null, "there is nowhere further back to go");
});

test("Cluster → System remembers the region to return to (EXP-REQ-19)", () => {
  const state = beginExploration(
    { kind: "cluster", clusterId: 2, label: "french touch" },
    entry("Breakbot"),
  );
  assert.deepEqual(state.origin, {
    kind: "cluster",
    clusterId: 2,
    label: "french touch",
  });
  assert.ok(state.explored.has("breakbot"), "an outside anchor counts as explored");
});

test("System → System extends the trail and remembers where it has been", () => {
  let state: ExploreState = beginExploration(
    { kind: "galaxy" },
    entry("Daft Punk", "galaxy"),
  );
  state = travel(state, entry("Justice", "galaxy"));
  state = travel(state, entry("SebastiAn"));
  state = travel(state, entry("Mr. Oizo"));

  assert.deepEqual(state.trail.map((e) => e.name), [
    "Daft Punk",
    "Justice",
    "SebastiAn",
    "Mr. Oizo",
  ]);
  assert.equal(previousAnchor(state)!.name, "SebastiAn");
  // Only artists outside the Galaxy become "explored"; a Galaxy artist was
  // already known territory.
  assert.deepEqual([...state.explored].sort(), ["mr. oizo", "sebastian"]);
});

test("travelling to where you already are changes nothing", () => {
  const state = beginExploration({ kind: "galaxy" }, entry("Justice", "galaxy"));
  assert.equal(travel(state, entry("JUSTICE", "galaxy")), state);
});

test("Back walks the route rather than logging it", () => {
  let state = beginExploration({ kind: "galaxy" }, entry("Daft Punk", "galaxy"));
  state = travel(state, entry("Justice", "galaxy"));
  state = travel(state, entry("Gesaffelstein"));

  const stepped = back(state)!;
  assert.deepEqual(stepped.trail.map((e) => e.name), ["Daft Punk", "Justice"]);

  // Walking back onto an earlier system by choosing it directly shortens the
  // trail too, rather than producing Justice / Gesaffelstein / Justice.
  const returned = travel(state, entry("Justice", "galaxy"));
  assert.deepEqual(returned.trail.map((e) => e.name), ["Daft Punk", "Justice"]);
  // …but what has been explored stays explored.
  assert.ok(returned.explored.has("gesaffelstein"));
});

test("a long trail collapses in the middle, keeping both ends (EXP-REQ-16)", () => {
  const trail = ["A", "B", "C", "D", "E"].map((n) => entry(n));
  assert.deepEqual(collapseTrail(trail, 3).map((e) => e && e.name), [
    "A",
    null,
    "D",
    "E",
  ]);
  assert.deepEqual(
    collapseTrail(trail.slice(0, 2), 3).map((e) => e && e.name),
    ["A", "B"],
    "a short trail is left alone",
  );
});

/* ─── placement (EXP-REQ-6/10) ───────────────────────────────────────── */

test("a frontier artist appears beyond the part of the region that reaches it", () => {
  const left = artist("Left", { x: -100, y: 0 });
  const right = artist("Right", { x: 100, y: 0 });
  const centre = { x: 0, y: 0 };
  const members = new Map([
    [left.id, { x: left.x, y: left.y }],
    [right.id, { x: right.x, y: right.y }],
  ]);

  const [placed] = placeFrontier(
    [
      {
        name: "Leftward",
        supportCount: 2,
        sumMatch: 1.1,
        maxMatch: 0.9,
        links: [
          { artistId: left.id, match: 0.9 },
          { artistId: right.id, match: 0.2 },
        ],
      },
    ],
    members,
    { centre, radius: 120 },
  );

  assert.ok(placed.x < 0, "it sits on the side its supporters are on");
  const distance = Math.hypot(placed.x - centre.x, placed.y - centre.y);
  assert.ok(distance > 120, "and outside the region rather than inside it");
});

test("frontier nodes are pushed apart without leaving the rim", () => {
  const members = new Map([[0, { x: -100, y: 0 }]]);
  const candidates = ["A", "B", "C"].map((name) => ({
    name,
    supportCount: 1,
    sumMatch: 0.5,
    maxMatch: 0.5,
    links: [{ artistId: 0, match: 0.5 }],
  }));
  const centre = { x: 0, y: 0 };
  const placed = placeFrontier(candidates, members, {
    centre,
    radius: 100,
    gap: 20,
    spacing: 40,
  });

  for (const p of placed) {
    assert.ok(
      Math.abs(Math.hypot(p.x, p.y) - 120) < 1e-6,
      "every node stays exactly on the ring it was placed on",
    );
  }
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      assert.ok(Math.hypot(placed[i].x - placed[j].x, placed[i].y - placed[j].y) > 30);
    }
  }
});

test("a System's radius is similarity and nothing else (EXP-REQ-10)", () => {
  const system = buildSystem({
    anchor: "Justice",
    similar: like([
      ["Daft Punk", 0.95],
      ["Breakbot", 0.6],
      ["Soulwax", 0.2],
    ]),
    galaxy: INDEX,
  });
  const points = layoutSystem(system.neighbours, { inner: 100, outer: 400 });
  const radius = points.map((p) => Math.hypot(p.x, p.y));

  assert.ok(radius[0] < radius[1] && radius[1] < radius[2], "closer means more alike");
  assert.ok(radius[0] >= 99 && radius[2] <= 401);
  // Determinism: same System, same picture.
  assert.deepEqual(layoutSystem(system.neighbours, { inner: 100, outer: 400 }), points);
});

test("the artist travelled from sits at the edge rather than on the anchor", () => {
  const system = buildSystem({
    anchor: "Justice",
    similar: like([["Daft Punk", 0.95]]),
    galaxy: INDEX,
    previous: "Somewhere Else",
  });
  const points = layoutSystem(system.neighbours, { inner: 100, outer: 400 });
  const unscored = system.neighbours.findIndex((n) => n.match === undefined);
  assert.ok(unscored >= 0);
  assert.ok(Math.hypot(points[unscored].x, points[unscored].y) >= 100);
});
