# Groove Galaxy — Temporal Exploration Specification

Status: Draft v1

Scope: two related extensions to the existing Groove Galaxy application:

1. **Period Selector** — inspect the galaxy over different recent listening
   windows.
2. **Taste Evolution / Time Travel** — explore how the user's listening
   history has changed through historical time.

This specification assumes the existing Groove Galaxy implementation remains
the baseline: live browser-side Last.fm fetching, artist similarity graph,
force-directed spatial layout, Louvain clustering, Canvas rendering,
IndexedDB caching, arbitrary public Last.fm accounts, search, detail panels,
and shareable `?user=` URLs.

---

## 1. Summary

The existing Groove Galaxy answers: *what does this person's overall
listening history look like?*

Temporal exploration extends that into *what does their listening look like
recently?* and *how did their listening develop over time?*

These are related but are deliberately treated as two distinct features. The
Period Selector changes the dataset used to build the current galaxy — a
normal map of a different rolling Last.fm period. The Taste Evolution view
reconstructs historical listening from Last.fm's weekly charts and lets the
visitor move through actual historical periods. They must not be presented as
equivalent.

---

## 2. Product principles

**TP-PRINCIPLE-1 — Listening changes; musical similarity does not.** The
temporal signal belongs to whether an artist is being listened to, how much,
and the relative importance of regions of taste. The similarity between two
artists is not a measurement of the user's changing behaviour. Taste
Evolution should therefore animate appearance/disappearance, bubble size,
emphasis, cluster listening weight and aggregate statistics — not move
artists around and imply their musical relationship changed. Minor positional
adjustment to prevent collisions is acceptable.

**TP-PRINCIPLE-2 — Preserve spatial memory.** The visitor should be able to
learn "this part of my galaxy is where my electronic music lives" and watch
that region grow, disappear and return. A new layout every frame would
destroy that. Temporal evolution requires a stable reference layout across
the selected historical range.

**TP-PRINCIPLE-3 — Temporal data must mean what the UI says it means.** "Last
12 months" is a rolling Last.fm period; "2024" is reconstructed listening
during calendar year 2024. Those must not be mixed, and reconstructed data
must be identified as such.

---

## Feature A — Period Selector

### 3. Purpose

Rebuild the normal Groove Galaxy from one of Last.fm's supported rolling
periods, answering questions like "what have I actually been listening to
this month", "is my recent taste narrower than my all-time taste", "which
artists dominate the last year but not my whole history". This is not an
animation feature: each period produces a normal Groove Galaxy.

### 4. Period options

| UI label  | Internal value |
| --------- | -------------- |
| 7 days    | `7day`         |
| 1 month   | `1month`       |
| 3 months  | `3month`       |
| 6 months  | `6month`       |
| 12 months | `12month`      |
| All time  | `overall`      |

- **TP-REQ-1.** "All time" remains the default, preserving current behaviour
  and existing URLs.
- **TP-REQ-2.** Period labels shown to users must be human-readable; internal
  names such as `7day` must not appear in the interface.

### 5. Period selector UI

- **TP-REQ-3.** The selected period must be visible without opening a
  settings panel. Recommended desktop form: `7D · 1M · 3M · 6M · 1Y · ALL`. A
  select or horizontally scrollable segmented control is acceptable on narrow
  screens.
- **TP-REQ-4.** The control must visually identify the active period.
- **TP-REQ-5.** Changing period must not require re-entering the username.
- **TP-REQ-6.** Period selection should feel like changing the current map
  rather than navigating to an unrelated page.

### 6. Period URL state

Canonical form: `?user=NestorDHCP&period=3month`.

- **TP-REQ-7.** Missing `period` means `overall`.
- **TP-REQ-8.** Valid values: `7day`, `1month`, `3month`, `6month`,
  `12month`, `overall`.
- **TP-REQ-9.** Unknown or malformed periods fall back to `overall`.
- **TP-REQ-10.** Changing period must update the browser URL.
- **TP-REQ-11.** A copied URL must reopen the same account and period.
- **TP-REQ-12.** Back/Forward must restore previous period selections
  correctly ("All time → 12 months → 3 months → Back" restores 12 months).

### 7. Period dataset

Maximum 300 artists; exclude extremely low-play noise; bubble size based on
plays in the selected period. The all-time minimum of 25 plays must not
blindly apply to every period.

- **TP-REQ-13.** Artist inclusion thresholds must adapt to the period.
  Recommended: 7 days → 2, 1 month → 3, 3 months → 5, 6 months → 8, 12 months
  → 10, all time → 25. These are implementation defaults and may be tuned.
- **TP-REQ-14.** The maximum node count remains 300.
- **TP-REQ-15.** Bubble size must represent play count within the selected
  period, not lifetime play count.

### 8. Period map rebuilding

The similarity cache remains reusable because similarity is independent of
the selected listening period; only artists not already cached require new
similarity requests.

- **TP-REQ-16.** Cached similarities, tags and artwork must remain reusable
  across periods.
- **TP-REQ-17.** Top-artist responses must be cached separately by
  `user + period + limit`.

### 9. Period transition behaviour

The existing map dims, new data arrives, the new galaxy is initialised and
settles; the old map disappears only then.

- **TP-REQ-18.** A visible loading/progress indication must exist during a
  period change.
- **TP-REQ-19.** If the new period fails to load, the previously working map
  should remain usable where practical.
- **TP-REQ-20.** A failed period request must not reset the account
  selection.

### 10–11. Description and detail panel

The caption must reflect the active period ("186 artists from NestorDHCP's
last 12 months on Last.fm").

- **TP-REQ-21.** No selected-period map may retain wording suggesting its play
  counts are lifetime counts.

The play-count label in the detail panel becomes period-specific — "47 plays
· last 3 months" rather than "842 plays". Link, artwork, tags and
similar-artist explanation are unchanged.

### 12. Period accessibility

- **TP-REQ-22.** The selector must be keyboard-operable.
- **TP-REQ-23.** Its selected state must be exposed semantically.
- **TP-REQ-24.** A map rebuild must not unexpectedly move keyboard focus away
  from the period control.
- **TP-REQ-25.** Loading status should be surfaced through the existing status
  mechanism without repeatedly announcing every incremental graph update.

### 13. Period performance targets

New artist set visible in ~1 second under normal conditions; cached maps
effectively immediate; UI interactive during layout; no full page reload to
change period. Targets, not correctness requirements.

### 14. Period Selector acceptance criteria

All six periods selectable; `overall` default; counts and sizes match the
active period; short periods use suitable thresholds; changing period
rebuilds the map; caches reused; period in the URL; refresh and copied URLs
preserve it; Back/Forward works; loading and failure states exist; mobile and
keyboard interaction work; caption and detail panel identify the period.

---

## Feature B — Taste Evolution / Time Travel

### 15. Purpose

Inspect the development of an account across historical time (2019 → 2026),
so the visitor can see a new region of taste appearing, an artist becoming
dominant, an old favourite disappearing, a quiet cluster becoming important,
temporary obsessions, long-lived core artists, and diversification or
concentration over time.

### 16–17. Historical data source and reconstruction

`user.getTopArtists` cannot provide arbitrary historical calendar periods, so
Taste Evolution uses Last.fm's weekly chart facilities: weekly charts →
normalized historical events → monthly/yearly frames. Three levels: a raw
chart interval (one Last.fm week), an aggregated period (a month or year),
and an animation frame (one visual state of the galaxy).

### 18. Calendar-boundary honesty

- **TE-REQ-1.** Historical charts must use a deterministic
  interval-attribution rule. Recommended: assign each weekly chart to the
  calendar period containing the interval's midpoint. (29 Dec 2024 → 5 Jan
  2025 has its midpoint in January 2025 and is attributed to 2025.)
- **TE-REQ-2.** The methodology panel must disclose that historical values are
  reconstructed from weekly charts and that calendar boundaries therefore
  follow Last.fm's chart granularity. No prominent warning during normal use.

### 19. Timeline resolutions

- **TE-REQ-3.** Yearly mode is required for the first release.
- **TE-REQ-4.** Monthly mode is the preferred second iteration; the internal
  data model must not prevent it.

### 20–22. Stable temporal galaxy

Selecting a historical range creates one temporal artist universe and one
reference similarity graph, which defines stable positions; frames then
change only the listening values applied to those nodes.

Universe selection: compute artist totals per frame, take each frame's top
50, union them, fill remaining places by total plays, and when there are more
than 300 candidates rank on both best position/share in any single frame and
total plays across the range.

- **TE-REQ-5.** An artist that strongly defines a single historical period
  must have a realistic chance of appearing even if its lifetime total is
  comparatively low.
- **TE-REQ-6.** Maximum visible temporal nodes remains approximately 300.
- **TE-REQ-7.** Musical similarity must not be fetched separately for every
  year.
- **TE-REQ-8.** A temporal frame changes listening data, not the underlying
  artist-similarity signal.

### 23–27. Bubble state through time

Minimum state per artist per frame: `{ plays, active }`, with derived values
such as share, rank, radius, change, first/last seen.

- **TE-REQ-9.** Bubble size represents plays during the active frame, on a
  scale comparable across adjacent frames — not independently normalised per
  year, with safeguards so low-volume years remain readable.
- **TE-REQ-10.** Zero-play artists must not remain visually prominent simply
  because they belong to the temporal universe.

An appearing artist fades/scales into its already-existing stable location; a
disappearing artist shrinks, fades and becomes non-interactive; a returning
artist reappears at the same approximate location.

### 28. Cluster evolution

Cluster identity comes from the stable reference graph; per frame, compute
active artists, total plays, share of frame listening, strongest artist and
change from the previous frame.

- **TE-REQ-11.** Cluster colour identity should remain stable across the
  timeline.

### 29–32. Controls, timing, reduced motion, autoplay policy

- **TE-REQ-12.** The visitor can directly select a frame.
- **TE-REQ-13.** Previous/next controls are provided.
- **TE-REQ-14.** Automatic playback is provided.
- **TE-REQ-15.** Playback can be paused at any time.
- **TE-REQ-16.** Interacting directly with an artist should pause playback
  rather than moving the target away while the visitor is reading it.
- **TE-REQ-17.** Animation timing must not be tied to network completion; the
  next frame's data should already be available before playback advances.
- **TE-REQ-18.** With `prefers-reduced-motion`, autoplay must not start
  automatically, node states change with little or no spatial interpolation,
  frame selection remains fully functional, and no information may depend on
  animation itself.

Recommended cadence: ~600–900 ms transition, ~900–1500 ms hold. Taste
Evolution must not begin automatically when the page opens; the visitor
enters temporal mode explicitly and presses Play explicitly.

### 33. Temporal mode entry

A control near the period selector ("Explore over time →"), visually
distinguished from the rolling-period control, so that "12 months" and "2025"
never appear to be equivalent options in one selector.

### 34–36. Loading, cache and API budget

Historical data loads progressively: chart list → available years → timeline
shell → selected year → neighbours → the rest → universe → similarity →
playback. Completed weekly charts are effectively immutable and cached
indefinitely or with a very long TTL; the current chart gets a short TTL; the
chart list a moderate one (~24 h).

- **TE-REQ-19.** Opening Taste Evolution a second time should not re-download
  years of immutable historical charts.
- **TE-REQ-20.** Historical loading is opt-in through user interaction.
- **TE-REQ-21.** Requests must use the same pooled/backoff architecture as the
  existing Last.fm client.
- **TE-REQ-22.** Historical responses must be cached aggressively.
- **TE-REQ-23.** Similarity requests must be shared with existing map caches.

### 37–39. Detail panel, insights, first-listen semantics

- **TE-REQ-24.** The detail panel must clearly identify the active historical
  period.
- **TE-REQ-25.** Temporal comparison values should be omitted when no
  meaningful previous frame exists.

The data model should support biggest riser/faller, new this year, returning
artist, most-played artist, dominant cluster, cluster gaining most share and
artists retained — all calculated from data, never generated as arbitrary
prose. Because weekly availability may be incomplete, first-listen labels
prefer "First chart appearance: 2024" over "Discovered in 2024".

### 40–41. URL state and interaction with the period selector

Recommended syntax `?user=NestorDHCP&view=timeline&year=2024`, with a future
`&month=2024-08`.

- **TE-REQ-26.** A shared timeline URL must reproduce account, timeline mode
  and selected frame.
- **TE-REQ-27.** Playback state should not be encoded in the URL; opening
  someone's "2024" link shows 2024 paused.

The rolling-period selector and the historical timeline are mutually
exclusive views. Entering the timeline preserves the account; leaving it
returns to the previous rolling period where practical.

### 42. Empty historical frames

A year with almost no listening must not break the timeline ("Very little
listening recorded in 2017"), and years before the account's first available
chart should not appear as selectable normal frames.

### 43–45. Performance, collisions, labels

Expensive work (aggregation, graph, clustering, reference layout) happens
before playback; frame advancement is radius and opacity interpolation,
labels, cluster summaries and limited collision correction.

- **TE-REQ-28.** Louvain clustering and the full force layout must not restart
  from scratch for every animation frame.
- **TE-REQ-29.** Collision movement must be bounded; artists remain
  recognisably in the same neighbourhood. The goal is "stable semantic
  geography + changing listening weight".

Reference clusters keep one stable label across the timeline; frames may
additionally show the cluster's most-important artists for that frame.

### 46. Accessibility

- **TE-REQ-30.** Timeline controls must be keyboard accessible.
- **TE-REQ-31.** The active frame must be available to assistive technology.
- **TE-REQ-32.** Playback changes must not cause hundreds of screen-reader
  announcements.
- **TE-REQ-33.** Selecting a year should produce one concise status update
  ("2024 selected. 126 active artists.").
- **TE-REQ-34.** Artist nodes must remain reachable through the existing
  non-canvas accessibility route; only artists active in the selected frame
  need be offered as normal interactive nodes.

### 47. Failure handling

- **TE-REQ-35.** One missing historical interval should not necessarily
  invalidate the entire timeline.
- **TE-REQ-36.** Incomplete frames must be marked internally and must not
  produce exact-looking aggregate statistics without qualification.
- **TE-REQ-37.** The normal Groove Galaxy must continue working even when
  temporal history cannot be built.

### 48. Taste Evolution acceptance criteria

Explicit entry into historical mode; chart intervals retrieved; weekly charts
aggregated into yearly frames; available years on a timeline; a stable
temporal artist universe; one reference graph/layout across frames; sizes
representing the selected year; inactive artists visually negligible;
appearance, disappearance and return at stable locations; stable cluster
colours and identities; previous/next and direct selection; play/pause;
artist selection pauses playback; historical data cached and existing
similarity cache reused; no historical loading before temporal mode is
requested; shareable active year; reduced motion respected; methodology
explains the weekly-chart reconstruction; partial-data and failure states do
not break the normal application.

### 49–51. Implementation sequence, data model, architecture

Phase 1 rolling periods, phase 2 historical data foundation, phase 3 stable
temporal graph, phase 4 animation, phase 5 temporal insights. The suggested
model is a `Period` union, `HistoricalInterval`, `TemporalFrame`,
`TemporalArtist` and `TemporalArtistState`, with the temporal data layer kept
separate from Canvas rendering: the renderer receives a frame/state and
displays it rather than reconstructing history. `map.ts` must not absorb
historical fetching, aggregation, timeline state and animation; the required
separation is **data retrieval → temporal model → graph/layout →
rendering/UI**.

### 52. Testing requirements

Automated tests should cover at least: weekly interval assigned to the
correct year; cross-year midpoint attribution; aggregation of repeated artist
entries; temporal candidate selection; an artist appearing in one year only;
an artist disappearing and returning; stable cluster IDs; stable coordinates
across frame changes; a zero-listening frame; incomplete chart handling; URL
parsing for rolling periods; URL parsing for historical frames. Temporal
correctness matters more than animation polish.

### 53. Final intended experience

Normal Groove Galaxy: *what does my musical universe look like?* Period
Selector: *what does my musical universe look like right now?* Taste
Evolution: *how did this universe become what it is?* The three views should
feel like progressively deeper ways of examining the same model rather than
three unrelated visualization features.
