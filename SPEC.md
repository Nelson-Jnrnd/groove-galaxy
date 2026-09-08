# Groove Galaxy — Product Specification

Status: **Draft v1** — not yet built.
Owner: Nelson Jeanrenaud (site owner / sole data subject).
Related: `nelson-jnrnd/nelson-jnrnd.github.io`, specifically its `/music`
page (`src/pages/music.astro`) — the existing now-playing + recently-played
Last.fm page on Nelson's personal site. Groove Galaxy is a separate
implementation (this repo) that the personal site links to / embeds; see
§5.7 and OQ-5.

## 1. Summary

A personal, explorable map of the artists in Nelson's Last.fm listening
history: one bubble per artist, sized by how much he's actually listened to
them, positioned so that artists he listens to in similar ways end up near
each other. The visitor can pan and zoom freely, the way you'd explore a
regular map or a mind-map tool — there is no fixed "correct" viewport.

It answers a different question than `/music`. `/music` says *what's
playing right now*. Groove Galaxy says *what does the whole shape of my
listening look like, and how does it hang together*.

This spec defines **what** the product must do and the constraints it must
satisfy. It deliberately does not choose a rendering technology, a layout
algorithm, a similarity formula, or a hosting/embedding mechanism — those
are implementation decisions for whoever builds it, made against the
requirements below.

## 2. Goals

- **G1.** Visualize the artists in Nelson's Last.fm history as a spatial
  map: one visual unit ("bubble") per artist.
- **G2.** Bubble size reflects Nelson's own listening volume for that
  artist (more plays → bigger bubble), not the artist's general popularity.
- **G3.** Bubble *position* reflects listening-behavior-derived similarity:
  artists that end up close together on the map should be ones that are
  actually similar by some data-derived measure, not by a human-assigned
  genre label.
- **G4.** Clusters (visually denser regions) must emerge from the data,
  not be pre-defined or manually curated. Nobody hand-assigns an artist to
  a "cluster" or "genre bucket" before the map is built.
- **G5.** The map is freely pannable and zoomable, at a level of
  responsiveness comparable to a normal interactive map/graph tool (not a
  static image).
- **G6.** Selecting/clicking a bubble surfaces more detail about that
  artist (see §5.4).
- **G7.** The two spatial dimensions of the map carry **no independently
  meaningful, labeled axis** (no "x = energy", "y = tempo", etc.). Only
  relative distance and clustering are meaningful. The product must not
  present or imply axis meaning it can't actually justify.
- **G8.** The experience is presentable as a distinct destination (its own
  URL/page), separate from the rest of the personal site's static,
  document-style pages, and linkable/embeddable from `/music`.

## 3. Non-goals (v1)

- **NG1.** Not a multi-user product. It shows exactly one person's
  (Nelson's) listening data. No accounts, no "map your own library" flow
  for visitors.
- NG2. Not a real-time/live view. It does not need to reflect a scrobble
  that happened 2 minutes ago; it's fine to look at a nightly/weekly
  snapshot.
- NG3. Not a recommendation engine. It doesn't have to suggest new
  artists to listen to, though it may be pleasant if browsing it leads to
  discovery (see §8 future ideas for anything closer to explicit
  recommendations).
- NG4. Not a genre encyclopedia. It does not need artist-supplied or
  editorially-curated genre metadata, canonical genre names, or genre
  hierarchies.
- NG5. Not required to cross-reference non-Last.fm data sources in v1
  (weather, GitHub activity, Discogs, etc. — see §8, out of scope for v1).
- NG6. Not required to work identically on every historical artist ever
  scrobbled — see §6 (data scope) for what "in scope" means.

## 4. Users & context

- **Primary/only audience:** visitors to Nelson's personal site
  (nelson-jnrnd.github.io), most of whom are strangers evaluating him
  professionally, plus Nelson himself.
- **Data subject:** Nelson only. The Last.fm account and API key are the
  same publicly-readable, non-secret setup already used by `/music`
  (see the personal site repo's `README.md` "Music page" section) — no new
  privacy surface is introduced by reading Last.fm data.
- **Device mix:** must be usable on both desktop (mouse/trackpad pan+zoom)
  and mobile/touch (pinch/drag), consistent with the personal site, which
  is responsive.
- **Tone:** matches the personal site's existing restrained, uncluttered
  aesthetic — this is a portfolio-quality piece, not a flashy demo. It
  should read as "a software engineer built a thoughtful thing," not "look
  at this effect."

## 5. Functional requirements

### 5.1 Data scope — which artists appear

- **REQ-1.** The map's artist set is derived from Nelson's actual Last.fm
  listening history (scrobbles/play counts), not from a hand-picked list.
- **REQ-2.** There must be a defined, documented rule for which artists
  are *included* on the map (e.g. a minimum play count, a top-N cutoff, a
  time window such as "all-time" vs "last 12 months") — implementers must
  choose and document this rule, but it must not be "all artists ever
  scrobbled with no cutoff" left undefined, since that has unbounded size
  and includes one-play noise.
- **REQ-3.** The rule from REQ-2 must be stated somewhere visible to the
  visitor (e.g. a caption/footnote: "showing your N most-played artists
  from Last.fm" or equivalent) so the map doesn't imply it's a complete
  picture of all music ever heard.

### 5.2 Bubble (node) representation

- **REQ-4.** Each artist appears as exactly one bubble.
- **REQ-5.** Bubble size is a monotonic function of Nelson's personal
  play count for that artist (more listening → strictly larger or equal
  bubble; never smaller for more plays).
- **REQ-6.** Each bubble is labeled with the artist name, at least when
  the bubble is large enough / zoomed in enough to read it, or on
  hover/focus if not always visible.
- **REQ-7.** Where available, the artist's image (from Last.fm) should be
  usable as part of the bubble's visual identity — consistent with how
  `/music` already surfaces cover art (`vinyl__art`) — but a clean fallback
  must exist for artists with no image, following the same
  placeholder-detection approach as `/music` (Last.fm serves a known
  placeholder image hash — see `PLACEHOLDER` in `music.astro` — which must
  not be treated as real art).

### 5.3 Positioning & clustering

- **REQ-8.** Position (proximity between two bubbles) must be derived
  from a data-driven similarity signal between artists — not from a
  human-assigned genre/category. "Data-driven" means: computed from Last.fm
  listening/co-occurrence signals (e.g. its artist-similarity data) or
  another objectively-computed signal, not authored by hand per artist.
- **REQ-9.** The specific similarity metric, its data source, and how it's
  turned into 2D coordinates are **implementation decisions**, not
  specified here. What's specified is the *outcome*: two artists placed
  near each other must be near each other *because* the underlying data
  says they're similar, and that relationship must be inspectable (see
  REQ-13) — a visitor can ask "why are these near each other?" and get a
  real (if summarized) answer, not "because that's where they landed."
- **REQ-10.** Clusters are an emergent visual property of REQ-8/REQ-9, not
  a separate manually-defined layer. No hand-drawn cluster boundaries or
  hand-assigned cluster names in v1 (an auto-derived cluster label,
  computed the same non-manual way, is acceptable — see open question in
  §7).
- **REQ-11 (axis honesty, ties to G7).** The map must not label, imply, or
  document a meaning for the horizontal or vertical axis individually
  (no "up = X, right = Y" legend). If the chosen layout technique
  incidentally produces axes with some statistical meaning, the product
  must not surface that meaning as if it were a designed, reliable
  feature.
- **REQ-12.** Isolated/low-connectivity artists (no strong similarity to
  anything else in the included set) must still render somewhere
  sensible on the map, not be dropped or crash the layout. Where an artist
  ends up (e.g. drifting to the edge) is acceptable; disappearing is not.
- **REQ-13.** Selecting a bubble must be able to show, at minimum, which
  other artists on the map it's most similar to (a short list), so the
  positioning logic is explainable at the individual-artist level even
  though there's no axis legend.

### 5.4 Detail view (on selecting a bubble)

- **REQ-14.** Clicking/tapping a bubble opens a detail view for that
  artist, in a manner consistent with the existing `/music` inspector
  pattern (`detail` panel triggered by `selectVinyl` in the personal site
  repo) — reusing that interaction shape is encouraged for consistency,
  though the exact UI is an implementation choice.
- **REQ-15.** The detail view must show at least:
  - Artist name and image (if available).
  - Nelson's personal play count / listening weight for that artist.
  - A link out to the artist's Last.fm page.
  - A short list of the most-similar other artists *that are on the map*
    (ties to REQ-13), each of which is itself selectable (clicking jumps /
    highlights that other bubble).
- **REQ-16.** Deselecting (closing the detail view) must be possible
  without losing the current pan/zoom position on the map.

### 5.5 Navigation & interaction

- **REQ-17.** The map supports pan (drag) and zoom (scroll/pinch/+−
  controls) across its full extent, at interactive frame rates — no
  visible stepping/lag under normal use for the artist-set size defined by
  REQ-2.
- **REQ-18.** There is a way to return to a sensible default/overview
  viewport (e.g. a "reset view" affordance), since a visitor can pan/zoom
  themselves into an empty or disorienting area.
- **REQ-19.** A way to find a specific artist by name (search/filter) is
  required — with an artist set potentially in the hundreds, "scroll
  around until you spot it" is not sufficient as the only way to find a
  known artist. Selecting a search result should navigate the view to
  that artist's bubble.
- **REQ-20.** Hover (desktop) or tap (touch) must give some lightweight
  feedback (e.g. highlight, name) before committing to the full detail
  view (REQ-14), so exploring doesn't require a click per artist.
- **REQ-21.** Must be usable via touch gestures on mobile (pan by drag,
  zoom by pinch) — not desktop-only.
- **REQ-22.** Keyboard/focus accessibility: bubbles must be reachable and
  selectable via keyboard navigation, consistent with the accessibility
  bar the personal site holds itself to (e.g. `/music`'s
  `aria-pressed`/`aria-label` pattern on its record buttons).

### 5.6 States

- **REQ-23.** Loading state while the map's data is being fetched/parsed
  (must not show a blank/broken canvas with no feedback).
- **REQ-24.** Empty/insufficient-data state: if there isn't enough
  listening history to build a meaningful map (e.g. very new account, or
  the Last.fm API is unreachable), show a clear, quiet message rather than
  an empty or broken map — consistent with `/music`'s existing
  `quietNow`/`quietShelf` pattern for "nothing to show" / "couldn't reach
  Last.fm."
- **REQ-25.** Stale-data indication: since this is not live (NG2), the
  page should communicate, in some form, how recent the underlying
  snapshot is (e.g. "as of [date]"), so a visitor doesn't assume it's
  real-time.

### 5.7 Placement relative to the personal site

- **REQ-26.** Groove Galaxy is reachable as its own distinct destination
  (own URL/deployment — this repo), not inlined into the personal site's
  `/music` page layout.
- **REQ-27.** The personal site's `/music` page links to (or embeds)
  Groove Galaxy, so a visitor discovering `/music` can find it.
- **REQ-28.** Groove Galaxy, wherever it's presented, is visually and
  navigationally coherent with the personal site (reads as the same
  person's work, even if the map canvas itself has its own visual
  language) — a visitor shouldn't feel like they clicked out to an
  unrelated third-party tool with no way back.
- **REQ-29.** There is a way back from Groove Galaxy to the personal site
  (to `/music` or the homepage) at all times.

## 6. Data requirements

- **REQ-30.** All data displayed is sourced from Last.fm, using the same
  account/API-key mechanism already documented in the personal site's
  `README.md` ("Music page" section) — no new credentials, scopes, or
  private data sources.
- **REQ-31.** The Last.fm API's usage terms and rate limits must be
  respected by whatever fetch/build process is chosen (this may push the
  work toward a precomputed/periodic snapshot rather than fully live
  per-visitor calls — that trade-off is an implementation decision, but
  respecting Last.fm's terms is a hard requirement either way).
- **REQ-32.** The data snapshot must be refreshable on some defined cadence
  (exact cadence is an implementation decision) so the map doesn't go
  permanently stale — REQ-25 depends on there being an actual last-updated
  timestamp to show.

## 7. Open questions (explicitly deferred to implementation)

These are flagged so an implementer knows they're undecided by this spec,
not accidentally omitted:

- **OQ-1.** Which similarity signal/algorithm computes artist-to-artist
  closeness (REQ-8/9), and which layout algorithm turns it into 2D
  coordinates.
- **OQ-2.** Rendering technology (SVG/Canvas/WebGL, which library/framework
  if any), and this repo's overall stack (framework, hosting/deploy
  target).
- **OQ-3.** Exact inclusion rule for REQ-2 (cutoff count, time window, or
  other).
- **OQ-4.** Whether/how clusters get an auto-derived label (e.g. a
  representative artist name or dominant Last.fm tag among the cluster's
  members) versus staying unlabeled regions.
- **OQ-5.** Exact mechanism for embedding/linking from `/music` (iframe
  pointed at this repo's deployment, a plain outbound link, or something
  else).
- **OQ-6.** Data pipeline mechanics for the periodic snapshot (build-time
  script, scheduled job, where the resulting dataset is stored/served
  from).
- **OQ-7.** Bubble size scale (linear vs. logarithmic vs. other) given
  play-count distributions are typically very skewed (a few heavily-played
  artists vs. a long tail) — needs a decision so the long tail doesn't
  render as invisible dust.
- **OQ-8.** Color usage, if any (color could encode a derived cluster
  identity, or the map could stay monochrome/size-and-position-only —
  undecided, but if color is used it must not silently reintroduce a fake
  "axis meaning" problem, i.e. don't let color imply a genre label that
  wasn't actually derived data-first).

## 8. Future extensions (explicitly out of scope for v1)

Captured from earlier brainstorming so they aren't lost, not because
they're planned:

- Cross-referencing artist origin/geography (e.g. via MusicBrainz) for a
  "where my music comes from" view.
- Correlating listening activity with the site owner's own GitHub commit
  activity ("coding soundtrack").
- Time-scrubbing the map (drag a slider across months/years and watch the
  map/weights change) rather than a single current snapshot.
- Comparing/overlaying against Discogs physical collection data (vinyl
  actually owned vs. actually played).

## 9. Acceptance criteria (representative flows)

- **AC-1 — First load.** Given a visitor with no prior state opens Groove
  Galaxy, when the page finishes loading, then they see a populated map
  (bubbles sized/positioned per §5) centered on a sensible default view,
  with a visible "as of [date]" snapshot indicator (REQ-25).
- **AC-2 — Explore.** Given the map is loaded, when the visitor drags to
  pan and scrolls/pinches to zoom, then the view moves/scales smoothly and
  bubble labels remain legible at an appropriate zoom level.
- **AC-3 — Select an artist.** Given the map is loaded, when the visitor
  clicks/taps a bubble, then a detail view opens per REQ-15, including at
  least one similar-artist link that, when clicked, navigates/highlights
  that other bubble.
- **AC-4 — Search.** Given the visitor knows an artist's name, when they
  use the search/filter affordance and pick a match, then the view
  navigates to that artist's bubble.
- **AC-5 — Reset.** Given the visitor has panned/zoomed away from the
  default view, when they use the reset affordance, then the view returns
  to the default overview.
- **AC-6 — No data.** Given Last.fm is unreachable or the snapshot is
  empty, when the page loads, then a quiet explanatory message is shown
  instead of a blank or broken canvas (REQ-24).
- **AC-7 — Entry/exit.** Given a visitor on the personal site's `/music`
  page, when they follow the link/embed to Groove Galaxy, then they land
  on a page that reads as part of the same person's work (REQ-28) and can
  navigate back (REQ-29).
- **AC-8 — No fake axes.** Given the finished map, an outside reviewer
  checking the UI/copy should find no claim of the form "the X axis
  represents ___" / "the Y axis represents ___" anywhere in labels,
  legends, or copy (REQ-11).

## 10. Glossary

- **Bubble / node** — the visual unit representing one artist.
- **Similarity signal** — the data-derived measure of how alike two
  artists are, used to drive position (not a manual genre tag).
- **Cluster** — a visually denser region of the map, an *emergent* result
  of many pairwise similarity relationships, not a predefined category.
- **Snapshot** — the periodically-refreshed dataset the map renders from
  (as opposed to a live per-request fetch).
