# Where the data comes from, and why

Groove Galaxy needs three things from a provider, and they are not equally
easy to get:

1. **Personal play counts** — bubble size (REQ-5). This is *my* listening, not
   an artist's popularity, so it can only come from something that has my
   history.
2. **Artist-to-artist similarity, with a weight** — bubble position (REQ-8/9).
   The weight matters as much as the ranking: it is the edge strength in the
   layout, and it is what the detail panel shows when it answers "why are
   these two near each other".
3. **Artist artwork** — bubble identity (REQ-7).

Only the second one is genuinely scarce. This note records what was compared,
on what evidence, and what it means if the current provider goes away.

## The short version

Spotify is not a contender, and not because it is worse: **the endpoint this
project is built on was switched off**. On 27 November 2024 Spotify cut new
Web API applications off from Related Artists, Audio Features, Audio Analysis
and Recommendations. That is the core signal here, and no amount of effort
recovers it — apps created after that date get `403`.

So the real comparison is **Last.fm vs ListenBrainz vs Deezer**, and the
honest conclusion is that no single one of them is best at all three jobs.

## The bake-off

Documentation says what an API offers; it does not say whether the answers are
any good for *this* set of artists. So seven artists from the actual map were
run through all three providers — a global name, a mid-sized one, two French,
one Japanese, one Ukrainian, and one deep-tail act.

**Coverage — did the provider know the artist at all?**

| Provider | Found |
| --- | --- |
| Last.fm | 7 / 7 |
| Deezer | 6 / 7 |
| ListenBrainz | 6 / 7 |

Both alternatives missed *Lucien & The Kimono Orchestra*. Deezer has no
record; ListenBrainz is keyed by MusicBrainz ID and there is no MBID to look
up. Last.fm's twenty years of scrobbles are simply deeper in the tail.

**Usable edges — how many returned neighbours are also on the map?** This is
what actually decides whether an artist joins a cluster or drifts to the edge.

| Artist | Last.fm | Deezer | ListenBrainz |
| --- | --- | --- | --- |
| Daft Punk | 9 | 6 | 10 |
| Men I Trust | 3 | 4 | 16 |
| L'Impératrice | 27 | 16 | 44 |
| Casiopea | 5 | 4 | 8 |
| Dabeull | 17 | 6 | 4 |
| Go_A | 0 | 0 | 3 |
| Lucien & The Kimono Orchestra | 1 | — | — |

ListenBrainz usually returns the densest graph. That is a real advantage, and
it is understated here: the comparison matched by name, and ListenBrainz
returns MusicBrainz spellings (`T‐SQUARE` with a U+2010 hyphen, `Parcels`
rather than `The Parcels`, `L’Impératrice` with a curly apostrophe). Matched
properly by MBID it would score higher still.

**Quality — but density is not the same as being right.** Top five for two
artists:

| | Last.fm | ListenBrainz |
| --- | --- | --- |
| Daft Punk | Justice, Modjo, Stardust, Thomas Bangalter, Cassius | Nile Rodgers, Gorillaz, Todd Edwards, **Radiohead**, **The Weeknd** |
| Casiopea | T-SQUARE, CASIOPEA-P4, Naniwa Express, 高中正義, Jun Fukamachi | T‐SQUARE, 高中正義, 大橋純子, **Frank Zappa**, Spyro Gyra |

ListenBrainz's signal is co-listening, and it shows a clear popularity pull:
big artists surface as "similar" to everything, because lots of people who
listen to anything also listen to them. Last.fm's match score is normalised
and its head is much tighter. Radiohead next to Daft Punk, and Frank Zappa
next to Casiopea, would visibly mush the clusters together.

Deezer's lists are tight and good — *Justice, Cassius, Etienne de Crécy* for
Daft Punk is arguably the best of the three — but they come back as a bare
ranked list with **no score**, so edge weights would have to be invented from
rank position, and the detail panel's honest "0.87" would become a fabricated
number.

## Provider by provider

### Last.fm — current spine

**For.** The only provider with my actual all-time play counts, which is
non-negotiable for bubble size. Similarity comes back *scored* 0–1, which is
what the layout weights and the explainability panel need. Deepest long-tail
coverage of the three. No OAuth: a public read-only key, already shipped in
`/music`'s page source. Tags come free, and they are what names the groups.

**Against.** Artist images are gone — every `artist.getInfo` image is now the
known placeholder hash, which is why bubbles fall back to the artist's
most-played album cover. The `mbid` parameter is actively broken: passing a
*correct* MBID for L'Impératrice returns "artist not found" while the plain
name works, so everything must be name-keyed and is therefore exposed to
alias and unicode drift. Non-commercial terms, no SLA, and the service has
been in maintenance mode for years. Similarity is a black box, and it can come
back empty for niche artists — Go_A got zero in-map neighbours.

### Spotify — unavailable

**For.** Best catalogue metadata, real artist images, and Audio Features would
have been the one dataset that could justify an axis actually meaning
something.

**Against.** Related Artists, Audio Features, Audio Analysis and
Recommendations are all closed to new applications as of 27 November 2024;
only apps that already had extended access kept them. Beyond that: OAuth
client-credentials means a real secret rather than a public read key — awkward
for a static site — and Spotify never exposed lifetime per-artist play counts
anyway, only coarse top-artist ranges behind user authorisation.

**Verdict:** not a fallback, not a migration target. Rule it out and stop
thinking about it.

### ListenBrainz / MusicBrainz — the principled option

**For.** CC0, free forever, run by a non-profit that published a post
explicitly pitching itself as the answer to exactly this Spotify episode.
MBID-keyed, so no name-matching class of bug at all. Scored. Densest graph in
the test. The datasets are downloadable, so a mirror is possible — no provider
can switch it off underneath the project.

**Against.** Needs a MusicBrainz resolution pass first (1 req/s, and artists
outside MusicBrainz are unreachable). The similarity endpoint lives on
`labs.api.listenbrainz.org` and is described by its own maintainers as still
limited — labs, not a stability promise. And the popularity bias above is a
real quality cost at the head of the list. No personal play counts unless I
actually scrobble there, though Last.fm can be mirrored into it.

### Deezer — the quiet surprise

**For.** No authentication whatsoever. 50 requests per 5 seconds, roughly ten
times the throughput the pipeline currently paces itself at. Tight, sensible
related-artist lists. And **real artist portraits up to 1000×1000** — which
fixes the one requirement currently being met by a workaround.

**Against.** No similarity score, only rank order. No personal listening data
of any kind, so it can never be the spine. Thinner tail. Terms are a revocable
grant for personal and development use rather than an open licence.

### Also considered

- **Apple Music API** — needs a paid developer membership and JWT signing, has
  no public artist-similarity endpoint, and personal history needs a MusicKit
  user token. Wrong shape for a static public page.
- **Discogs** — no similarity at all. Genuinely interesting later for the
  owned-vinyl-vs-actually-played idea in SPEC §8, not for this.
- **AcousticBrainz** — frozen since 2022. Worth stating plainly: with Spotify's
  Audio Features gone too, there is currently **no open source of per-track
  acoustic descriptors**. Any future "this axis means energy" idea is blocked
  on data that does not exist publicly, which is a second, independent reason
  the map's axes stay meaningless.

## What this argues for

Keep **Last.fm as the spine**. It is the only provider that has my play
counts, its scores are what make the detail panel's explanation truthful
rather than decorative, and it is the only one that reaches the bottom of the
tail.

Two cheap additions are worth making, in this order:

1. **Deezer for artwork.** Purely an image lookup keyed on artist name at
   snapshot time. Replaces the album-cover substitution with actual artist
   portraits and satisfies REQ-7 as written. Low risk: if Deezer misses, the
   existing album-cover path is still there behind it.
2. **ListenBrainz as a similarity fallback.** Only for artists where Last.fm
   returns no in-map neighbours — the Go_A case. Those artists currently drift
   to the edge, which REQ-12 permits but does not celebrate. Using the weaker
   signal *only where there is otherwise no signal* gets the benefit of
   ListenBrainz's density without letting its popularity bias near the core
   clusters.

What is explicitly **not** worth doing is a wholesale migration. Every
alternative loses the play counts, the scores, or the tail.

## The dependency risk, and why it is contained

Last.fm did to nobody what Spotify did to everybody, but it is a single
private dependency in maintenance mode, and the Spotify episode is the
reference class for how these end.

The design contains it only partly, and it is worth being straight about
which part:

- every provider call is behind one module (`src/lib/lastfm.ts`), so swapping
  the similarity source is a contained change;
- a month of similarity, tags and artwork is cached in each visitor's browser,
  so a short outage is invisible to anyone who has been before.

But since the map became live (see README, "How a map gets built") there is
no committed dataset behind it. If Last.fm goes away, a first-time visitor
gets the quiet "couldn't reach Last.fm" state rather than a stale map. That
is a deliberate trade — it bought the removal of the weekly job and the
always-current data — and it is the reason the module boundary above matters
more than it used to.

One correction to the measurements above, found later: Last.fm **does**
rate-limit, despite a 60-call burst at 110 req/s drawing no complaint. Enough
sustained volume returns `error 29`, so the client backs off and retries
rather than failing a map mid-build. A single visitor building one map makes
about 900 calls and does not come close; it took repeated full rebuilds in a
test loop to trip it.

## Sources

- [Spotify — Introducing some changes to our Web API (27 Nov 2024)](https://developer.spotify.com/blog/2024-11-27-changes-to-the-web-api)
- [TechCrunch — Spotify cuts developer access to several of its recommendation features](https://techcrunch.com/2024/11/27/spotify-cuts-developer-access-to-several-of-its-recommendation-features/)
- [MetaBrainz — Pissed off by Spotify enshittifying more API endpoints? We can help!](https://blog.metabrainz.org/2024/11/28/pissed-off-by-spotify-enshittifying-more-api-endpoints-we-can-help/)
- [ListenBrainz API documentation](https://listenbrainz.readthedocs.io/en/latest/users/api/core.html)
- [Deezer for Developers — terms of use](https://developers.deezer.com/termsofuse)

Bake-off figures were measured on 8 September 2026 against the artist set in
`public/data/snapshot.json`.
