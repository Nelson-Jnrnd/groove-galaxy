# Groove Galaxy

An explorable map of the artists in a Last.fm listening history. One bubble
per artist, sized by how much they have actually been played, positioned so
that artists the data says are alike end up near each other. Pan, zoom,
search, click a bubble to see why it sits where it does.

The map is **built live in the browser**. There is no precomputed dataset, no
server and no scheduled job: opening the page reads Last.fm directly, draws
every bubble within about a second, and lets the layout settle over the next
few seconds while you watch. Whatever it looks up is cached in your browser,
so coming back is close to instant.

It answers a different question than the `/music` page on
[nelson-j.ch](https://nelson-j.ch): that one says *what is playing right
now*, this one says *what does the whole shape of my listening look like*.

Two controls decide *which* listening it draws:

- a **period selector** (`7D · 1M · 3M · 6M · 1Y · ALL`) rebuilds the map
  from any of Last.fm's rolling windows, so "what have I actually been
  playing this month" is one click from "what have I ever played";
- **Explore over time** leaves the rolling windows behind and reconstructs
  the account's calendar years from Last.fm's weekly charts, so the same
  galaxy can be watched filling, emptying and refilling year by year.

The product requirements live in [`SPEC.md`](./SPEC.md), and the temporal
ones in [`docs/temporal-spec.md`](./docs/temporal-spec.md). This README covers
what was actually built and, in §"Decisions", what each of the spec's open
questions was resolved to.

## Stack

- **[Astro](https://astro.build/)** (static output) + **TypeScript**, plain
  CSS with design tokens — the same stack and the same visual language as the
  personal site.
- The map itself is a single **canvas 2D** surface (`src/scripts/map.ts`).
  No charting or graph library: at three hundred bubbles the whole frame is a
  few hundred arcs, and drawing it by hand keeps the bundle at ~6 kB gzipped
  and the pan/zoom exactly as responsive as it needs to be.
- No runtime backend and no build-time data step: the deployed site is an
  HTML file, a stylesheet and about 20 kB of JavaScript.

## Project structure

```
src/
├── lib/
│   ├── lastfm.ts          # browser Last.fm client: pooled, backing off, cached
│   ├── cache.ts           # IndexedDB store, one lifetime per kind of entry
│   ├── layout.ts          # MDS seed, force simulation (steppable), clustering
│   ├── period.ts          # the rolling windows: labels, play floors, captions
│   ├── viewstate.ts       # what the URL means (account · period · year)
│   ├── history.ts         # weekly charts → calendar frames
│   ├── temporal.ts        # temporal universe, per-year state, derived facts
│   └── build.ts           # orchestrates a live build, emitting as it goes
├── layouts/BaseLayout.astro
├── components/SiteHeader.astro
├── pages/index.astro      # the page: canvas, controls, panels, method note
├── scripts/
│   ├── map.ts             # rendering, interaction, and which view is on screen
│   └── timeline.ts        # the temporal controller (loaded only on demand)
└── styles/global.css

test/                      # node --test, no browser: the arithmetic and the URLs
```

The split is the point: data retrieval (`lastfm`, `history`) → temporal model
(`temporal`) → graph and layout (`build`, `layout`) → rendering and UI
(`scripts/`). Nothing under `lib/` touches a canvas, which is what lets the
year-by-year arithmetic be tested without one.

## Run locally

```bash
npm install
npm run dev              # http://localhost:4321/groove-galaxy
npm run build            # static output to ./dist
npm run preview
npm run check            # astro type/diagnostics check
npm test                 # node --test (Node 22+, no browser needed)
```

## Whose map

Any public Last.fm account. "Map another account" in the caption strip opens
a username prompt, and `?user=<name>` does the same thing from a URL — so a
map is shareable and survives the back button.

There is no sign-in and no OAuth, because none is needed:
`user.getTopArtists` is a public read. Nothing about a visitor leaves their
browser; the accounts they have looked at are remembered locally so the
prompt can offer them back, and those maps are close to instant because the
cache already holds them.

This deliberately supersedes SPEC NG1 ("not a multi-user product"). The
original reasoning was that a per-visitor map would need a backend; building
live in the browser removed that, and with it the reason to say no.

## How a map gets built

Ordered so that the map exists long before it is finished:

1. **The artist set** — one `user.getTopArtists` call. Every bubble now
   exists, correctly sized, arranged on an even spiral. About a second in;
   the map is already pannable and searchable.
2. **Similarity** — one `artist.getSimilar` per artist, twenty at a time,
   restricted to artists *also on this map*. Edges accumulate, and the force
   simulation runs a few passes per frame, so the map visibly reorganises
   itself from a ring into clusters instead of appearing after a freeze.
3. **Groups** — Louvain community detection over the finished graph, which
   is what colours the bubbles.
4. **Tags and artwork** — fetched afterwards, in the background, behind the
   foreground work in the same request pool. Groups are named after their
   heaviest artist until tags arrive and a better name can be derived.

Measured on a 300-artist account: **first bubbles at ~1s, complete at ~5s**,
and **~0.6s with nothing fetched at all** on a second visit.

## Periods, and years

Two different questions, deliberately kept apart (§33 of the temporal spec):
*what am I listening to now* is a rolling window, *how did this become what
it is* is a calendar. "12 months" and "2025" are not two options of the same
kind, so they do not sit in one selector.

### The rolling period

`?period=` takes one of Last.fm's own windows — `7day`, `1month`, `3month`,
`6month`, `12month`, `overall` — and anything missing or unrecognised means
`overall`, which is what every URL written before this feature existed says.
Changing it rebuilds the map in place: the URL updates, Back and Forward
work, and the account is never re-typed.

Bubble size is always plays **inside the chosen window**. The play floor
moves with it (2 plays over a week, 3 over a month, … 25 over a lifetime),
because a 25-play bar that is sensible across fifteen years empties a
seven-day map completely.

What does *not* change is similarity: whether Daft Punk is close to Justice
has nothing to do with which weeks you are looking at, so the similarity,
tag and artwork caches are shared across every period and every account. A
period switch usually only has to fetch the artists it has not seen before.

### The timeline

`user.getTopArtists` cannot answer "2019". `user.getWeeklyChartList` and
`user.getWeeklyArtistChart` can, one week at a time, so a year is
reconstructed by adding its weeks up.

Weeks straddle New Year, and a weekly total cannot honestly be split across
the days inside it — so **each week is attributed whole, to the year
containing its midpoint**. A chart covering 29 Dec → 5 Jan counts as the new
year. It is deterministic, it gives away as often as it takes, and the method
note says so on the page.

Then one thing is built and never rebuilt:

- **one artist universe** — every year's top 50, unioned, topped up by total
  plays, capped at 300. A one-year obsession gets in on the strength of that
  year; a decade of steady background listening gets in on volume.
- **one similarity graph, one clustering, one layout.** Positions and group
  colours are computed once for the whole timeline and then held still.

A year then changes exactly two numbers per artist: radius and opacity. An
artist who stops being played shrinks and fades; when they come back, they
come back to the same place, which is the whole reason the map is worth
having a memory of. Bubbles that would overlap at their new sizes get a
bounded nudge — never more than ~24 units from where the reference layout put
them — rather than a fresh force simulation, because "the electronic corner
grew" is a fact about listening and "everything moved" is not.

Nothing historical is fetched until somebody presses **Explore over time**: a
decade is roughly five hundred requests, and no ordinary map load has any
business spending that. Completed weeks are immutable, so they are cached for
years; the week in progress gets half an hour. The second visit costs
nothing.

Frames are trimmed to the span the account actually listened in — Last.fm
hands back a chart for every week since registration, including the years
before anything was played. Quiet years *inside* that span stay, because a
quiet year is a real thing to see.

## The cache

The observation it is built on: **similarity is not personal.** That Daft
Punk is close to Justice is true of everybody's map, so it is worth keeping
for a month and is equally useful to whoever's history gets drawn next. Tags
and artwork are the same. Only play counts belong to one person, and those
are the one thing that must stay current.

So `src/lib/cache.ts` files entries by kind, each with its own lifetime —
similarity, tags and art for 30 days, top artists for 6 hours, the weekly
chart list for a day, a finished weekly chart for ten years and the week in
progress for half an hour — in IndexedDB
(localStorage is synchronous, so it would stutter the layout, and it caps out
around 5 MB). Entries are evicted least-recently-used past a ceiling, and
every failure path — private browsing, disabled storage, eviction — lands on
"cache miss" and nothing worse.

The payoff is not only the reload. Two accounts with overlapping taste share
their similarity entries, so the second map anyone builds in the same browser
is partly paid for already.

### Credentials

None that are new. The account (`NestorDHCP`) and the read-only Last.fm API
key are the same public pair the personal site's `/music` page already ships
in its page source. They are baked into the client, which is where they have
to be — the map is built in the browser, so there is nothing server-side to
hide them behind. That is only acceptable because the key is read-only and
sees nothing but public scrobble data.

Note that going live raised the traffic on that key from a dozen calls per
visitor to roughly 900. Last.fm does throttle (`error 29`), and the client
backs off and retries when it happens; the per-browser cache is what keeps a
returning visitor from spending any of that budget at all.

## Decisions

The spec deliberately left the following open. Here is what they were
resolved to, and why.

A fuller comparison of Last.fm against Spotify, ListenBrainz and Deezer —
including a measured bake-off on this map's own artists — is in
[`docs/data-providers.md`](./docs/data-providers.md).

**OQ-1 — Similarity signal and layout.** Similarity is Last.fm's own
`artist.getSimilar` match score, which is derived from listening behaviour
rather than editorial genre tags — exactly the kind of signal REQ-8 asks for.
Layout is MDS-seeded force-directed placement. MDS alone gives good global
structure but piles bubbles on top of each other; a force pass alone is at
the mercy of its starting positions. Together they are stable, deterministic
(fixed seed → identical map for identical input) and cheap enough to run in
a few seconds at build time.

**OQ-2 — Rendering and stack.** Astro + canvas 2D, deployed to GitHub Pages
as a project site. Canvas over SVG because three hundred bubbles with artwork
would be three hundred live DOM nodes to hit-test and repaint; canvas over
WebGL because at this size WebGL buys nothing and costs a dependency.

**OQ-3 — Inclusion rule.** All-time top 300 artists, minimum 25 plays. The
cap keeps the map explorable and the build inside Last.fm's rate limits; the
floor drops the one-play tail, which has no similarity structure to place it
by anyway. Stated verbatim under the map, and again in the method note
(REQ-3).

**OQ-4 — Cluster labels.** Groups are labelled, but nothing is labelled *by
hand*. Each group's name is whichever Last.fm tag is most distinctive to its
members — common inside the group and comparatively rare outside it, so the
groups don't all come out called "electronic". A group whose members share no
tags at all is named after its most-played artist. The legend says plainly
that this describes what landed there rather than what anything was sorted
by.

**OQ-5 — Link from `/music`.** A plain outbound link, not an iframe. The map
wants the whole viewport and its own pan/zoom gestures, both of which an
iframe inside a document-style page fights with. Groove Galaxy carries the
site's header and links back to `/music` and the homepage from every state
(REQ-28/29), and those links target `_top` so it behaves correctly if it is
ever embedded after all. **This side is ready; the link on `/music` itself
still needs adding in the personal site repo** — see "Still to do".

**OQ-6 — Snapshot mechanics.** *Superseded.* There is no snapshot. The map
is built live in the browser on every visit and cached there, which is what
made the weekly job, the committed dataset and the "as of" staleness notice
all unnecessary — and retires SPEC NG2, REQ-25 and REQ-32 with them. The
trade is that a Last.fm outage now means no map at all rather than a stale
one; the quiet state says so.

**OQ-7 — Bubble scale.** Logarithmic, radius from ~11 to ~58 layout units.
The play-count distribution runs from 5,567 down to 25, so a linear scale
would render most of the map as invisible dust. Monotonic in plays either way
(REQ-5).

**OQ-8 — Colour.** Colour encodes the derived group and nothing else, in a
muted palette assigned by group size. Because the groups fall out of the
similarity graph rather than out of a genre list, colour cannot smuggle in a
category that wasn't derived from the data — and it carries no axis meaning,
since it isn't a function of position.

## On axes

There is deliberately no axis legend, and no claim anywhere in the UI that
left/right or up/down means anything. They don't: the layout is
rotation-arbitrary, and only the distance between two bubbles carries
information. What *is* offered instead is per-artist explainability — open
any bubble and it lists the artists it was pulled toward and how strong each
link is, which is the honest version of "why is this here".

## Accessibility

Every bubble also exists as a real button in a screen-reader-only list:
focusing one pans the map to it and outlines it, activating one opens the
same detail panel a click would, and focus moves into the panel and back out
again on close. The list sits *after* the search box and controls in the tab
order, since searching by name is the faster route through three hundred
artists. Colour is never the only carrier of meaning — every group's name is
written out in the legend and in each artist's panel.

The period buttons and the timeline controls are ordinary buttons with a real
pressed state; arrow keys move along the period row the way a segmented
control should, and rebuilding the map never takes focus away from the button
that asked for it. One polite live region carries the coarse news — "3 months
ready. 39 artists.", "2024 selected. 27 active artists." — while the caption
strip carries the per-artist progress silently: a map settling three hundred
bubbles, or a timeline playing through eight years, must not become three
hundred announcements. In the timeline, only artists actually played in the
selected year are offered in the keyboard list; the rest are gone from it, as
they are from the canvas.

## Known risk: the shared API key

Going live took the key from a dozen calls per visitor to roughly 900 — one
per artist for similarity, plus tags and artwork in the background. Last.fm
does throttle (`error 29`), and testing this repeatedly trips it: a run that
rebuilt several full maps back to back saw 177 of 922 responses rate-limited.
The client backs off and retries, so the map still completes, but it takes
longer.

One visitor building one map is nowhere near that. But if this page ever gets
real traffic, the levers in order of how much they buy and how little they
cost are:

(The timeline adds a different kind of spending: one request per week of the
account's life, roughly 500 for a decade, paid once and then cached for
years. It only ever happens when a visitor explicitly asks for it.)

1. **Cut the background 600.** Tags and artwork are two-thirds of the volume
   and pure enrichment. Tags only name the groups, so sampling the dozen
   heaviest artists per group would give the same labels for a fraction of
   the calls — at the cost of the per-artist tag chips in the detail panel.
2. **Lower the artist cap.** 300 → 150 roughly halves everything and still
   makes a rich map (~2s instead of ~5s).
3. **Get a key of its own**, rather than sharing with `/music`.

## Still to do

- **Monthly resolution.** The data model already carries frame ids of the
  shape `2024-08`, the URL parser already accepts `?month=`, and
  `history.ts` aggregates at either resolution — only the UI is missing.

- **Add the link on the personal site.** `/music` needs a link out to this
  map (REQ-27). It lives in a different repository
  (`nelson-jnrnd/nelson-jnrnd.github.io`, `src/pages/music.astro`) so it
  isn't part of this change. Something like:

  ```html
  <p class="music__more">
    <a href="https://nelson-jnrnd.github.io/groove-galaxy/">
      Explore the whole listening map →
    </a>
  </p>
  ```

- **Turn Pages on.** Repository → Settings → Pages → *Build and deployment →
  Source* must be **GitHub Actions**. The deployed URL
  (`https://nelson-jnrnd.github.io/groove-galaxy/`) is what `site` + `base`
  in `astro.config.mjs` assume; change both together if it ever moves to a
  custom domain.
