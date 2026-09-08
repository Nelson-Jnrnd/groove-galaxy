# Groove Galaxy

An explorable map of the artists in my Last.fm listening history. One bubble
per artist, sized by how much I have actually played them, positioned so that
artists the data says are alike end up near each other. Pan, zoom, search,
click a bubble to see why it sits where it does.

It answers a different question than the `/music` page on
[nelson-j.ch](https://nelson-j.ch): that one says *what is playing right
now*, this one says *what does the whole shape of my listening look like*.

The product requirements live in [`SPEC.md`](./SPEC.md). This README covers
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
- Node scripts for the data pipeline. No runtime backend — the page is
  static files plus one JSON snapshot.

## Project structure

```
scripts/
├── build-snapshot.mjs     # the whole data pipeline (see below)
├── lib/lastfm.mjs         # rate-limited, disk-cached Last.fm client
├── lib/layout.mjs         # MDS seed, force simulation, label propagation
└── preview.mjs            # dev helper: dump a snapshot to a flat SVG
src/
├── layouts/BaseLayout.astro
├── components/SiteHeader.astro
├── pages/index.astro      # the page: canvas, controls, panels, method note
├── scripts/map.ts         # rendering + interaction
└── styles/global.css
public/data/snapshot.json  # the committed snapshot the page renders
```

## Run locally

```bash
npm install
npm run dev              # http://localhost:4321/groove-galaxy
npm run build            # static output to ./dist
npm run preview
npm run check            # astro type/diagnostics check

npm run snapshot         # rebuild public/data/snapshot.json from Last.fm
npm run snapshot:layout  # re-run layout/clustering from the on-disk API cache
```

`npm run snapshot` makes about three Last.fm calls per artist (~900 in
total), serialised behind a fixed delay, and caches every response under
`.cache/`. Once that cache is warm, `npm run snapshot:layout` re-runs the
layout in a couple of seconds with no network at all — that is the loop to
use when tuning anything about the map's shape.

Useful flags: `--limit`, `--min-plays`, `--period`, `--gravity`, `--out`,
`--offline`.

## The data pipeline

1. **Pick the artists.** `user.getTopArtists` (all-time), keep the top 300
   with at least 25 plays.
2. **Find the similarity.** `artist.getSimilar` for each of them; keep only
   matches that are *also on the map*, take the stronger of the two
   directions for each pair, and keep each artist's ten strongest links so a
   single hub artist can't drag the whole map into its lap.
3. **Decorate.** `artist.getTopTags` for group labelling, and
   `artist.getTopAlbums` for artwork.
4. **Place.** Classical MDS on graph-hop distance for the global shape, then
   a force simulation (similarity pulls, everything else pushes, weak gravity
   toward the centre), then an overlap-relaxation pass.
5. **Group.** Label propagation over the same similarity graph.
6. **Emit** one JSON file with positions, radii, colours, group labels and
   each artist's nearest neighbours.

Everything above happens at snapshot time. The browser only draws.

The snapshot is committed to the repo, and
[`.github/workflows/snapshot.yml`](.github/workflows/snapshot.yml) rebuilds it
every Monday, commits it if it changed, and redeploys.

### Credentials

None that are new. The account (`NestorDHCP`) and the read-only Last.fm API
key are the same public pair the personal site's `/music` page already ships
in its page source — the key only ever sees public scrobble data. They are
baked in as defaults and can be overridden with `LASTFM_USERNAME` /
`LASTFM_API_KEY` (repository *variable* and *secret* respectively, wired up in
the snapshot workflow).

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

**OQ-6 — Snapshot mechanics.** A Node script, run weekly by a scheduled
GitHub Action, committing its output to the repo. Committing the snapshot
means the site builds identically without network access, the map's history
is inspectable in git, and a Last.fm outage can never take the map down —
worst case it goes stale, which the page says out loud.

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

## Still to do

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
