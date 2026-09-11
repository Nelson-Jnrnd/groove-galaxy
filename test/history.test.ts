/**
 * Weekly charts → calendar frames.
 *
 * §52 asks for the attribution rule to be pinned down by tests before any of
 * it ships, because a year that quietly counts the wrong week is a lie the
 * animation would present very persuasively.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  aggregateFrame,
  frameIdOf,
  frameLabel,
  groupWeeks,
  loadOrder,
  midpoint,
  type WeekChart,
} from "../src/lib/history.ts";
import type { ChartWeek } from "../src/lib/lastfm.ts";

/** A week, given in whole UTC days, as Last.fm reports them. */
const week = (fromIso: string, toIso: string): ChartWeek => ({
  from: Math.floor(Date.parse(fromIso) / 1000),
  to: Math.floor(Date.parse(toIso) / 1000),
});

const chart = (w: ChartWeek, entries: [string, number][]): WeekChart => ({
  week: w,
  artists: entries.map(([name, plays]) => ({
    name,
    plays,
    url: `https://www.last.fm/music/${name}`,
  })),
});

test("a week inside one year belongs to that year", () => {
  const w = week("2024-03-03T00:00:00Z", "2024-03-10T00:00:00Z");
  assert.equal(frameIdOf(w, "year"), "2024");
  assert.equal(frameIdOf(w, "month"), "2024-03");
});

test("a week straddling New Year goes where its midpoint is", () => {
  // 29 Dec 2024 → 5 Jan 2025: the middle is 1 Jan, so the week is 2025's.
  const crossing = week("2024-12-29T00:00:00Z", "2025-01-05T00:00:00Z");
  assert.equal(new Date(midpoint(crossing) * 1000).getUTCFullYear(), 2025);
  assert.equal(frameIdOf(crossing, "year"), "2025");

  // …and one three days earlier still belongs to the year it mostly covers.
  const earlier = week("2024-12-26T00:00:00Z", "2025-01-02T00:00:00Z");
  assert.equal(frameIdOf(earlier, "year"), "2024");
});

test("a week straddling a month boundary follows the same rule", () => {
  const w = week("2024-07-29T00:00:00Z", "2024-08-05T00:00:00Z");
  assert.equal(frameIdOf(w, "month"), "2024-08");
  assert.equal(frameIdOf(w, "year"), "2024");
});

test("weeks are grouped into frames, oldest first", () => {
  const weeks = [
    week("2023-06-04T00:00:00Z", "2023-06-11T00:00:00Z"),
    week("2024-01-07T00:00:00Z", "2024-01-14T00:00:00Z"),
    week("2024-02-04T00:00:00Z", "2024-02-11T00:00:00Z"),
  ];
  const grouped = groupWeeks(weeks, "year");
  assert.deepEqual([...grouped.keys()], ["2023", "2024"]);
  assert.equal(grouped.get("2024")!.length, 2);
});

test("repeated artists across weeks add up", () => {
  const a = week("2024-01-07T00:00:00Z", "2024-01-14T00:00:00Z");
  const b = week("2024-01-14T00:00:00Z", "2024-01-21T00:00:00Z");
  const frame = aggregateFrame("2024", [
    chart(a, [["Justice", 12], ["Parcels", 4]]),
    chart(b, [["Justice", 8]]),
  ]);
  assert.equal(frame.artists.get("Justice"), 20);
  assert.equal(frame.artists.get("Parcels"), 4);
  assert.equal(frame.totalPlays, 24);
  assert.equal(frame.complete, true);
  assert.equal(frame.urls.get("Justice"), "https://www.last.fm/music/Justice");
});

test("a week that could not be read leaves the frame marked incomplete", () => {
  const a = week("2024-01-07T00:00:00Z", "2024-01-14T00:00:00Z");
  const b = week("2024-01-14T00:00:00Z", "2024-01-21T00:00:00Z");
  const frame = aggregateFrame("2024", [
    chart(a, [["Justice", 12]]),
    { week: b, artists: null },
  ]);
  assert.equal(frame.complete, false);
  assert.equal(frame.missing, 1);
  // Whatever was read is still true, and still shown (TE-REQ-35).
  assert.equal(frame.artists.get("Justice"), 12);
});

test("a frame with no listening at all is still a frame", () => {
  const w = week("2017-05-07T00:00:00Z", "2017-05-14T00:00:00Z");
  const frame = aggregateFrame("2017", [chart(w, [])]);
  assert.equal(frame.totalPlays, 0);
  assert.equal(frame.artists.size, 0);
  assert.equal(frame.complete, true);
  assert.equal(frame.label, "2017");
});

test("frames are labelled the way the timeline shows them", () => {
  assert.equal(frameLabel("2024"), "2024");
  assert.equal(frameLabel("2024-08"), "August 2024");
});

test("loading starts at the selected frame and works outwards", () => {
  const ids = ["2020", "2021", "2022", "2023", "2024"];
  assert.deepEqual(loadOrder(ids, "2022"), [
    "2022",
    "2023",
    "2021",
    "2024",
    "2020",
  ]);
  assert.deepEqual(loadOrder(ids, "2024"), [
    "2024",
    "2023",
    "2022",
    "2021",
    "2020",
  ]);
});
