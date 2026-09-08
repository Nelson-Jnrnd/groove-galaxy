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
- No runtime backend and no build-time data step: the deployed site is an
  HTML file, a stylesheet and about 20 kB of JavaScript.

## Project structure

```
src/
├── lib/
│   ├── lastfm.ts          # browser Last.fm client: pooled, backing off, cached
│   ├── cache.ts           # IndexedDB store, one lifetime per kind of entry
│   ├── layout.ts          # MDS seed, force simulation (steppable), clustering
│   └── build.ts           # orchestrates a live build, emitting as it goes
├── layouts/BaseLayout.astro
├── components/SiteHeader.astro
├── pages/index.astro      # the page: canvas, controls, panels, method note
├── scripts/map.ts         # rendering, interaction, driving the settling layout
└── styles/global.css
```

## Run locally

```bash
npm install
npm run dev              # http://localhost:4321/groove-galaxy
npm run build            # static output to ./dist
npm run preview
npm run check            # astro type/diagnostics check

```

`?user=<name>` builds the map for any public Last.fm account instead of the
default one — no sign-in, because `user.getTopArtists` is a public read.

## How a map gets built

Ordered so that the map exists long before it is finished:

1. **The artist set** — one `user.getTopArtists` call. Every bubble now
   exists, correctly sized, arranged on an even spiral. About a second in;
   the map is already pannable and searchable.
2. **Similarity** — one `artist.getSimilar` per artist, twenty at a time,
   restricted to artists *also on this map*. Edges accumulate, and the force
   simulation runs a few passes per frame, so the map visibly reorganises
   itself from a ring into clusters instead of appearing after a freeze.
3. **Groups** — label propagation over the finished graph, which is what
   colours the bubbles.
4. **Tags and artwork** — fetched afterwards, in the background, behind the
   foreground work in the same request pool. Groups are named after their
   heaviest artist until tags arrive and a better name can be derived.

Measured on a 300-artist account: **first bubbles at ~1s, complete at ~5s**,
and **~0.6s with nothing fetched at all** on a second visit.

## The cache

The observation it is built on: **similarity is not personal.** That Daft
Punk is close to Justice is true of everybody's map, so it is worth keeping
for a month and is equally useful to whoever's history gets drawn next. Tags
and artwork are the same. Only play counts belong to one person, and those
are the one thing that must stay current.

So `src/lib/cache.ts` files entries by kind, each with its own lifetime —
similarity, tags and art for 30 days, top artists for 6 hours — in IndexedDB
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
