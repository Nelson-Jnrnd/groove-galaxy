/**
 * What a URL means — for rolling periods and for historical frames alike.
 *
 * These are the two parsers a shared link depends on, so they are pinned
 * here rather than trusted to the browser (§52).
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_PERIOD,
  describePeriod,
  parsePeriod,
  periodInfo,
  PERIODS,
} from "../src/lib/period.ts";
import { parseView, sameView, toSearch } from "../src/lib/viewstate.ts";

/* ─── rolling periods ────────────────────────────────────────────────── */

test("every period Last.fm supports is offered, and none of its names leak", () => {
  assert.deepEqual(
    PERIODS.map((p) => p.value),
    ["7day", "1month", "3month", "6month", "12month", "overall"],
  );
  // TP-REQ-2 — nothing a visitor reads is an API token.
  for (const p of PERIODS) {
    assert.doesNotMatch(p.short, /day|month|overall/);
    assert.doesNotMatch(p.label, /^\d+(day|month)$/);
  }
});

test("thresholds adapt to the window and never exceed the all-time one", () => {
  const floors = PERIODS.map((p) => p.minPlays);
  assert.deepEqual(floors, [2, 3, 5, 8, 10, 25]);
  // Shorter windows always ask for less (TP-REQ-13).
  for (let i = 1; i < floors.length; i++) assert.ok(floors[i] > floors[i - 1]);
});

test("a missing, unknown or malformed period is all time", () => {
  assert.equal(parsePeriod(null), "overall");
  assert.equal(parsePeriod(""), "overall");
  assert.equal(parsePeriod("last-tuesday"), "overall");
  assert.equal(parsePeriod("9month"), "overall");
  assert.equal(parsePeriod("<script>"), "overall");
  assert.equal(DEFAULT_PERIOD, "overall");
});

test("valid periods survive the round trip, whatever their casing", () => {
  for (const p of PERIODS) {
    assert.equal(parsePeriod(p.value), p.value);
    assert.equal(parsePeriod(p.value.toUpperCase()), p.value);
    assert.equal(parsePeriod(` ${p.value} `), p.value);
  }
});

test("a windowed caption never implies lifetime plays (TP-REQ-21)", () => {
  const windowed = describePeriod("3month", "NestorDHCP", 74, 4200);
  assert.match(windowed, /last 3 months/);
  assert.doesNotMatch(windowed, /ever scrobbled/);
  assert.match(describePeriod("overall", "NestorDHCP", 300, 4200), /ever scrobbled/);
  assert.equal(periodInfo("3month").suffix, "last 3 months");
});

/* ─── view state ─────────────────────────────────────────────────────── */

const DEFAULT_USER = "NestorDHCP";

test("a bare URL is the account's all-time map", () => {
  const state = parseView("", DEFAULT_USER);
  assert.deepEqual(state, {
    user: DEFAULT_USER,
    period: "overall",
    mode: "map",
    frame: null,
  });
  assert.equal(toSearch(state), "?user=NestorDHCP");
});

test("a period URL reopens the same account and window (TP-REQ-11)", () => {
  const state = parseView("?user=someone&period=3month", DEFAULT_USER);
  assert.equal(state.user, "someone");
  assert.equal(state.period, "3month");
  assert.equal(state.mode, "map");
  assert.equal(toSearch(state), "?user=someone&period=3month");
  assert.deepEqual(parseView(toSearch(state), DEFAULT_USER), state);
});

test("an unknown period in a URL falls back rather than failing", () => {
  const state = parseView("?user=someone&period=forever", DEFAULT_USER);
  assert.equal(state.period, "overall");
  assert.equal(state.mode, "map");
});

test("a timeline URL reproduces account, mode and frame (TE-REQ-26)", () => {
  const state = parseView("?user=someone&view=timeline&year=2024", DEFAULT_USER);
  assert.equal(state.mode, "timeline");
  assert.equal(state.frame, "2024");
  assert.equal(toSearch(state), "?user=someone&view=timeline&year=2024");
  // TE-REQ-27 — nothing about playback is in the URL, so a shared 2024 link
  // opens on 2024 and stays there.
  assert.doesNotMatch(toSearch(state), /play/);
});

test("the monthly form parses ahead of monthly resolution shipping", () => {
  const state = parseView("?user=someone&view=timeline&month=2024-08", DEFAULT_USER);
  assert.equal(state.frame, "2024-08");
  assert.equal(toSearch(state), "?user=someone&view=timeline&month=2024-08");
});

test("a malformed frame is dropped, not obeyed", () => {
  assert.equal(parseView("?view=timeline&year=99", DEFAULT_USER).frame, null);
  assert.equal(parseView("?view=timeline&year=abcd", DEFAULT_USER).frame, null);
  assert.equal(parseView("?view=timeline&month=2024-13", DEFAULT_USER).frame, null);
  assert.equal(parseView("?view=timeline", DEFAULT_USER).mode, "timeline");
});

test("the timeline carries the rolling period so leaving can restore it (§41)", () => {
  const map = parseView("?user=someone&period=12month", DEFAULT_USER);
  const timeline = { ...map, mode: "timeline" as const, frame: "2024" };
  const url = toSearch(timeline);
  assert.match(url, /period=12month/);
  const reopened = parseView(url, DEFAULT_USER);
  assert.equal(reopened.mode, "timeline");
  assert.equal(reopened.period, "12month");
  assert.deepEqual(
    { ...reopened, mode: "map", frame: null },
    map,
    "exiting returns to the 12-month map, not to all time",
  );
});

test("sameView knows what counts as the same map", () => {
  const a = parseView("?user=someone&period=3month", DEFAULT_USER);
  assert.ok(sameView(a, parseView("?user=SOMEONE&period=3month", DEFAULT_USER)));
  assert.ok(!sameView(a, parseView("?user=someone&period=6month", DEFAULT_USER)));
  assert.ok(!sameView(a, parseView("?user=someone&view=timeline", DEFAULT_USER)));

  const y2024 = parseView("?user=someone&view=timeline&year=2024", DEFAULT_USER);
  const y2025 = parseView("?user=someone&view=timeline&year=2025", DEFAULT_USER);
  assert.ok(!sameView(y2024, y2025));
  // In timeline mode the rolling period is baggage, not identity.
  assert.ok(
    sameView(y2024, parseView("?user=someone&view=timeline&year=2024&period=6month", DEFAULT_USER)),
  );
});
