/**
 * What the cache gives up first when it runs out of room.
 *
 * The policy matters because the kinds are not interchangeable: a browser
 * that has drawn one timeline holds ~1,100 weekly charts next to ~300
 * similarity entries, and losing the wrong 300 costs three hundred requests
 * on the next map rather than one.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { evictionOrder, type Entry, type Kind } from "../src/lib/cache.ts";

let clock = 1_000;
const entry = (kind: Kind, key: string, bytes = 1024): Entry<unknown> => ({
  key,
  kind,
  value: null,
  storedAt: clock,
  usedAt: clock++,
  bytes,
});

test("nothing is dropped while the store is inside both budgets", () => {
  const entries = [entry("similar", "a"), entry("chart", "b")];
  assert.deepEqual(evictionOrder(entries, { maxEntries: 10, maxBytes: 1e6 }), []);
});

test("weekly charts are spent before the similarity data every map needs", () => {
  const entries = [
    entry("similar", "similar:justice"),
    entry("tags", "tags:justice"),
    entry("chart", "chart:week-1"),
    entry("chart", "chart:week-2"),
    entry("chartLive", "chartLive:this-week"),
  ];
  const doomed = evictionOrder(entries, { maxEntries: 2, maxBytes: 1e9 });
  assert.equal(doomed.length, 3);
  assert.deepEqual(doomed, [
    "chartLive:this-week",
    "chart:week-1",
    "chart:week-2",
  ]);
  assert.ok(!doomed.includes("similar:justice"));
});

test("the aggregated year outlives the weeks it was made of", () => {
  const entries = [
    entry("frame", "frame:2024"),
    entry("chart", "chart:w1"),
    entry("chart", "chart:w2"),
  ];
  assert.deepEqual(evictionOrder(entries, { maxEntries: 1, maxBytes: 1e9 }), [
    "chart:w1",
    "chart:w2",
  ]);
});

test("within one kind the least recently used goes first", () => {
  const old = entry("chart", "chart:old");
  const recent = entry("chart", "chart:recent");
  const doomed = evictionOrder([recent, old], { maxEntries: 1, maxBytes: 1e9 });
  assert.deepEqual(doomed, ["chart:old"]);
});

test("a byte budget is enforced even when the entry count is fine", () => {
  const entries = [
    entry("similar", "similar:big", 5_000),
    entry("chart", "chart:huge", 900_000),
  ];
  const doomed = evictionOrder(entries, { maxEntries: 1000, maxBytes: 100_000 });
  assert.deepEqual(doomed, ["chart:huge"]);
});

test("entries written before sizes were recorded are still accounted for", () => {
  const legacy: Entry<unknown> = {
    key: "chart:legacy",
    kind: "chart",
    value: null,
    storedAt: 1,
    usedAt: 1,
  };
  assert.deepEqual(evictionOrder([legacy], { maxEntries: 10, maxBytes: 100 }), [
    "chart:legacy",
  ]);
});
