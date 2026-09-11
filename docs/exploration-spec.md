# Groove Galaxy — Exploration Mode Specification

Status: Proposed
Feature: Cluster exploration + artist discovery
Working name: Exploration Mode

## 1. Summary

Exploration Mode extends Groove Galaxy from a visualization of known
listening history into an explorable music similarity space.

The existing Galaxy remains the canonical representation of the user's own
listening history. Exploration does not replace or mutate it. Instead, the
user can progressively move outward:

`Galaxy → Cluster → Artist System → Artist System → …`

At each level, Groove Galaxy distinguishes between:

- artists already present in the user's current Galaxy;
- artists outside the current Galaxy but connected to it through Last.fm
  similarity;
- artists the user has already visited during the current exploration;
- the route through which the user reached their current location.

The result should feel less like receiving recommendations and more like
navigating a map whose borders extend beyond the territory already
represented by the user's listening history.

## 2. Product concept

The current Galaxy answers: *what does my listening look like?*

Exploration Mode adds: *what exists around the parts of my listening I
already know?* And eventually: *how far can I travel from something I know
while still understanding how I got there?*

Discovery must therefore remain spatial and explainable. Groove Galaxy
should never produce an unexplained list such as "you may also like these
artists". Instead, the interface should show: these artists sit immediately
beyond this part of your Galaxy, and these are the artists connecting you to
them.

## 3. Terminology

**Galaxy** — the existing Groove Galaxy map. It represents the selected
user's listening history for the selected period and inclusion rules. An
artist being "in the Galaxy" therefore means: this artist belongs to the
currently displayed personal artist set. It does not mean that every other
artist has never been listened to.

**Cluster** — an existing emergent Louvain community inside the Galaxy.
Clusters remain data-derived and retain their current automatically derived
labels. A cluster is a region of the user's Galaxy, not a separate galaxy.

**Frontier** — artists returned by similarity data that are not part of the
current Galaxy artist set. Frontier artists are potential paths outward.
Preferred UI wording: `Beyond your galaxy`, `At the frontier`, `Outside this
map`. Avoid `Unheard`, `New to you`, `Never listened` unless Groove Galaxy
later has data that can actually prove those statements.

**System** — an artist-centered local similarity view. Justice occupies the
center and its strongest related artists surround it. A System may contain
both Galaxy artists and Frontier artists.

**Trail** — the sequence of systems through which the visitor has travelled,
e.g. `Daft Punk → Justice → SebastiAn → Mr. Oizo`. The trail represents
navigation, not musical similarity beyond the individual links that were
actually traversed.

**Explored** — a Frontier artist that has been used as the center of a
System during the current exploration session. This is different from being
"in the Galaxy".

## 4. Core principles

**EXP-PRINCIPLE-1 — The personal Galaxy remains authoritative.** Exploration
must never insert Frontier artists permanently into the user's Galaxy. The
Galaxy visualizes listening; exploration visualizes similarity around that
listening. These are different concepts and must remain visually and
structurally distinguishable.

**EXP-PRINCIPLE-2 — Every discovery must have a visible reason.** A Frontier
artist only appears because a similarity relationship connects it to one or
more currently relevant artists. The UI must be capable of answering: why am
I seeing this artist?

**EXP-PRINCIPLE-3 — Explore lazily.** Groove Galaxy must not recursively
download an enormous artist graph. Only the current frontier is shown.
Similarity for an outside artist is fetched only when the user actually
travels to that artist. Exploration should therefore theoretically continue
indefinitely without requiring the entire network in advance.

**EXP-PRINCIPLE-4 — Preserve the user's mental map.** Focusing a cluster
must preserve the existing Galaxy coordinates. The cluster should feel like
zooming into an existing region, not generating an unrelated graph. Artist
Systems are allowed to use a different local layout because they represent a
different level of navigation.

## 5. Entry point 1 — Exploring a Cluster

Cluster legend entries become interactive. Selecting a cluster does not
immediately leave the Galaxy; Groove Galaxy enters Cluster Focus.

**EXP-REQ-1 — Cluster selection.** Clicking/tapping a cluster in the legend
shall: frame the viewport around the cluster; keep cluster members fully
visible; substantially dim artists belonging to other clusters; open a
Cluster detail panel; calculate and reveal the cluster's Frontier. Keyboard
activation must perform the same action.

**EXP-REQ-2 — Cluster detail panel.** The panel should contain at minimum:
cluster label; number of artists; share or number of plays represented by
the cluster; several representative/core artists; a short explanation that
the group emerged from similarity data; number of Frontier artists currently
exposed; an `Explore this region` / equivalent contextual heading.

**EXP-REQ-3 — Existing coordinates remain fixed.** Galaxy artists must
remain at their normal Galaxy coordinates during Cluster Focus. No new
clustering or global force simulation may move them. This maintains
continuity with the overview.

## 6. The Cluster Frontier

For each member of the selected cluster, Groove Galaxy already has or can
retrieve its Last.fm similar-artist list. Those lists are combined. Artists
already present anywhere in the current Galaxy are removed from the Frontier
candidate set. The remaining artists are candidates outside the Galaxy.

**EXP-REQ-4 — Frontier candidate aggregation.** For every outside candidate,
calculate `supportCount` (how many cluster members link to it), `sumMatch`
(sum of similarity scores from those members), `maxMatch` (strongest
individual relationship) and `supportingArtists` (the members responsible).
Candidates supported by multiple cluster members should generally rank above
candidates attached weakly to one artist. A suitable initial ordering is:
candidates with two or more supporting cluster members, ordered primarily by
`sumMatch`; then remaining candidates, ordered by `maxMatch`. The exact
ranking may later be tuned, but it must remain deterministic and
explainable.

**EXP-REQ-5 — Frontier size.** Cluster Focus should initially display
approximately 8–12 Frontier artists. The purpose is to expose exits from the
region, not surround the cluster with another hundred nodes.

**EXP-REQ-6 — Frontier positioning.** A Frontier artist should appear near
the part of the cluster responsible for it. Its initial position should be
derived from the weighted centroid of its supporting cluster members. The
candidate should then be pushed outward toward the boundary of the focused
region so that Galaxy members remain visually inside the region and Frontier
artists appear around its perimeter. A small collision pass may move
Frontier nodes to prevent overlap; Galaxy nodes remain fixed during it.

**EXP-REQ-7 — Frontier relationships.** At rest, the cluster must not become
covered in dozens of lines. When a Frontier artist is
hovered/focused/selected, show its relevant connections back into the
cluster.

## 7. Frontier visual language

Frontier artists must be immediately distinguishable from Galaxy artists
without relying exclusively on colour.

- Galaxy artist: existing cluster colour; existing bubble treatment; normal
  artwork treatment.
- Frontier artist: neutral/non-cluster visual treatment; distinct border or
  halo; visually lighter than Galaxy members; explicit `Beyond your Galaxy`
  status in tooltip/detail UI.

A Frontier artist must not receive the selected cluster's colour merely
because it is similar to that cluster. Cluster membership belongs to the
user's Galaxy graph; the outside artist has not gone through that clustering
calculation. Visited Frontier artists may gain a second visual state
indicating that they have been explored during the current session.

## 8. Entering an Artist System

Both Galaxy artists and Frontier artists can be used as entry points into a
System. In the existing Galaxy detail panel, add `Explore from this artist`.
In Cluster Focus, selecting a Frontier artist should expose `Explore this
artist`. Activating either enters System View.

## 9. System View

System View replaces the global Galaxy layout with a local artist-centered
network. The current artist becomes the anchor, and distance from it
reflects Last.fm similarity to it.

**EXP-REQ-8 — Anchor.** The focused artist sits at the visual center of the
System. It is visually larger or otherwise more prominent than surrounding
nodes.

**EXP-REQ-9 — Neighbour set.** The System uses the focused artist's
`artist.getSimilar` results. A normal System should contain approximately
12–18 neighbouring artists, deliberately containing both Galaxy artists,
where available, and Frontier artists. Do not allow Galaxy artists to consume
every slot if useful outside artists exist. An initial policy may reserve
several Frontier positions whenever enough suitable candidates exist.

**EXP-REQ-10 — Similarity representation.** Similarity to the anchor is
primarily encoded through radial distance. Stronger match: closer to the
center. Weaker match: farther away. This means node size does not need to
represent similarity.

**EXP-REQ-11 — Node size.** System View should use approximately uniform
neighbour node sizes. The existing Galaxy uses size to mean the user's play
count; using size to mean something different in Exploration Mode would be
misleading. The anchor may be larger solely as an interaction/focus
treatment. Personal play counts for Galaxy artists remain available in their
details.

**EXP-REQ-12 — Galaxy status.** Artists belonging to the current Galaxy must
remain recognisable as known territory. Their cluster identity may be reused
through colour. Frontier artists remain neutral. A small legend should
explain: `In your Galaxy`, `Beyond your Galaxy`, `Already explored`.

## 10. Travelling between systems

Selecting another artist in System View makes that artist the new center.
Groove Galaxy then loads that artist's own similarity neighbourhood and
redraws the System around them.

**EXP-REQ-13 — Lazy expansion.** Entering a Frontier artist's System causes
exactly that artist's similarity data to be loaded if it is not already
cached. Groove Galaxy must not prefetch the full similarity neighbourhood of
every visible Frontier artist. This is what keeps exploration effectively
unbounded without creating an API explosion.

**EXP-REQ-14 — Previous node preservation.** The artist from which the user
arrived must remain visible in the newly opened System even if it would
normally fall outside the neighbour display cutoff. This guarantees that the
route backwards remains understandable.

**EXP-REQ-15 — Travel feedback.** Transitions between systems should
visually communicate recentering. The chosen node should move toward the
center while the old neighbourhood fades/rearranges. With reduced-motion
enabled, this transition should happen immediately.

## 11. The Trail

Every traversal appends to the current Trail, e.g. `Your Galaxy / Electronic
cluster / Daft Punk / Justice / Gesaffelstein`. The full cluster portion is
optional when exploration began directly from an artist.

**EXP-REQ-16 — Trail UI.** A compact breadcrumb/trail control must remain
visible in System View. Long trails should collapse older entries rather
than consuming the page width, e.g. `Galaxy / … / Justice / Gesaffelstein`.

**EXP-REQ-17 — Trail state.** There are three relevant artist states.
*Galaxy*: artist belongs to the user's current Galaxy. *Frontier*: artist is
outside the Galaxy and has not yet been used as a System anchor. *Explored*:
artist is outside the Galaxy but has already been visited during this
exploration session.

**EXP-REQ-18 — Browser navigation.** Browser Back should travel backwards
through the exploration route where practical. Leaving System View must
restore the previous Galaxy or Cluster Focus rather than rebuild an
unrelated initial state.

**EXP-REQ-19 — Return controls.** System View must always expose `Back` and
`Return to Galaxy`. If exploration began from Cluster Focus, returning
should restore that cluster's focused viewport.

## 12. Artist information in Exploration Mode

*Galaxy artist* — show: artist; artwork; play count for the current Galaxy
period; current cluster; similarity to current System anchor; `In your
Galaxy`; Last.fm link.

*Frontier artist* — show: artist; artwork when available; similarity to
current System anchor; `Beyond your current Galaxy`; Last.fm link. Do not
display `0 plays`: not appearing in the current Galaxy does not prove zero
listening.

*Explored Frontier artist* — same as Frontier, plus a visual indication such
as `Explored on this trail`.

## 13. Artwork and metadata loading

Exploration must preserve the current application's progressive-loading
philosophy. Known Galaxy artists generally already have metadata available.
For Frontier artists: similarity comes first; names are sufficient to render
the network; artwork is secondary; tags are tertiary.

**EXP-REQ-20.** Do not issue artwork/tag requests for every possible
candidate in advance. For Frontier artists, artwork may be fetched for the
current anchor, visible Frontier nodes when network conditions permit, and
hovered/selected nodes. An initial fallback node without artwork is fully
acceptable.

## 14. Cluster exploration and System exploration relationship

Cluster Focus answers: *what exists just beyond this part of my Galaxy?*
System View answers: *what exists around this specific artist?* Cluster
Focus is therefore broad and contextual; System View is local and
navigational.

Example journey: the user sees the complete Galaxy; selects the `French
electronic` cluster; other clusters dim; eight Frontier artists appear
around its edge; the user notices Breakbot outside the Galaxy; opens
Breakbot's System; several Galaxy artists remain visibly connected to
Breakbot; the user travels from Breakbot to L'Impératrice; that System
reveals another set of artists; the trail shows how they got there; the user
can always trace the route back to known territory. This should be the
signature interaction of the feature.

## 15. Direct artist exploration from the Galaxy

Cluster Focus must not be mandatory. Any normal Galaxy artist's current
detail panel should gain `Explore from here`, which opens its System
directly. That makes exploration useful even when the visitor is interested
in one artist rather than an entire cluster.

## 16. Search while exploring

In the Galaxy, current behaviour remains unchanged. In System View, search
may initially remain limited to the currently loaded exploration graph. A
future version may support jumping directly to any Last.fm artist, but
global Last.fm artist search is not required for the first implementation.

## 17. URL and shareability

Exploration should be representable in the URL at least at the current-focus
level, e.g. `?user=NestorDHCP&period=overall&explore=Justice`. A direct link
only needs to reconstruct user, period and focused artist; it does not need
to reconstruct the entire historical Trail, which may live in browser
history/session state. Cluster IDs should not be treated as permanently
stable public identifiers unless their stability can be guaranteed across
map rebuilds; artist names are better exploration anchors.

## 18. Period semantics

Exploration inherits the Galaxy period from which it was opened. A `7D`
Galaxy and an `ALL` Galaxy may therefore classify different artists as
Galaxy vs Frontier. This is correct: "beyond your Galaxy" always means
outside the artist set represented by the Galaxy from which this exploration
originated. The period should remain visible somewhere in Exploration Mode.
Changing period exits or rebuilds the exploration from the corresponding
Galaxy.

## 19. Timeline interaction

Historical Timeline exploration is explicitly out of scope for the first
version. Timeline mode has different semantics because its artist universe
and year frames are intentionally held stable through time. Exploration v1
should operate only from normal rolling-period Galaxy views. A future
version could explore "artists surrounding my 2018 Galaxy", but that should
be designed separately.

## 20. Performance requirements

**EXP-REQ-21.** Opening Cluster Focus should normally require no new
similarity network traffic after the parent Galaxy has completed building.
Its cluster members' similarity lists have already been requested by the
Galaxy build and should be available through the shared cache.

**EXP-REQ-22.** Opening a System for a Galaxy artist should normally require
no new similarity request for that artist.

**EXP-REQ-23.** Travelling to a previously uncached Frontier artist should
require approximately one foreground similarity request. Metadata/artwork
requests remain background enrichment.

**EXP-REQ-24.** Exploration must never recursively fetch
neighbours-of-neighbours merely because they have become visible. Only
travelling to an artist expands that node.

## 21. Accessibility

Cluster legend entries must become actual interactive controls with keyboard
semantics. Every visible exploration node must remain keyboard reachable.
Screen-reader announcements should summarize each new System, e.g.
"Exploring Justice. 6 related artists are in your Galaxy and 10 are beyond
it." Galaxy/Frontier/Explored status must not rely on colour alone. Touch
behaviour must support the same exploration paths as desktop. Reduced-motion
preferences must be respected during recenter animations.

## 22. Error handling

Failure to load a Frontier artist's similarity data must not destroy the
exploration. The current System remains visible, with a quiet message such
as "Couldn't map the area around this artist." The visitor can return or
select another node. A missing artwork request is never a System-level
failure. An artist with no useful similarity results may still be displayed
as a dead end — "No further strong connections found here" — which is a
legitimate endpoint of exploration.

## 23. Proposed architecture

Add `src/lib/explore.ts`: classify Galaxy vs Frontier artists; aggregate
cluster Frontier candidates; rank Frontier candidates; build System
neighbour sets; maintain pure exploration graph structures; deterministic
positioning helpers where appropriate.

Add `src/scripts/explorer.ts`: Exploration Mode canvas rendering; Cluster
Focus overlays where not owned by the normal map renderer; System
navigation; Trail; interaction; lifecycle and cleanup. The module should be
loaded lazily when exploration is first requested, following the same
general principle used by Timeline Mode.

Extend `src/lib/viewstate.ts` with exploration state.

Avoid forcing Frontier artists into the existing `Artist` interface. The
current `Artist` type requires personal concepts such as plays, radius and
cluster, and those values do not necessarily exist for an outside artist.
Use a dedicated model such as:

```ts
interface ExploreNode {
  name: string;
  image: string;
  status: "galaxy" | "frontier" | "explored";
  galaxyArtistId?: number;
  clusterId?: number;
  match?: number;
}
```

And:

```ts
interface FrontierCandidate {
  name: string;
  supportCount: number;
  sumMatch: number;
  maxMatch: number;
  links: {
    artistId: number;
    match: number;
  }[];
}
```

The exact structures can evolve, but the domain distinction should remain
explicit.

## 24. Test requirements

Pure exploration algorithms should be covered by automated tests. At
minimum:

*Frontier aggregation* — given three cluster artists whose Last.fm lists
overlap: candidates already in the Galaxy are removed; duplicate artist
names are merged; `supportCount`, `sumMatch` and `maxMatch` are correct;
ordering is deterministic.

*System neighbour selection* — neighbour count respects its cap; Galaxy
artists are identified correctly; Frontier artists remain present where
available; the previous Trail artist is retained; duplicate normalized names
cannot produce duplicate nodes.

*Navigation* — Galaxy → System; Cluster → System; System → System; Back;
Return to Galaxy.

*View-state parsing* — unknown or malformed exploration parameters must
degrade safely to the normal Galaxy rather than produce a broken view.

## 25. MVP

1. Make cluster legend entries selectable and frame/dim their corresponding
   region.
2. Show approximately 8–12 Frontier artists around a focused cluster.
3. Explain why each Frontier artist is there by showing its supporting
   Galaxy artists.
4. Add `Explore from here` to artist details.
5. Implement artist-centered System View.
6. Clearly distinguish Galaxy and Frontier artists.
7. Allow System → System traversal.
8. Maintain a Trail and allow returning to the Galaxy.
9. Use lazy similarity loading so one outside hop roughly equals one new
   similarity lookup.
10. Support keyboard, touch, failure states and reduced motion.

## 26. Deliberately deferred features

Persistent exploration history across browser sessions; Spotify playback;
automatic playlist creation; global Last.fm artist search; recommendations
scored from the entire Galaxy at once; explicit "you have never listened to
this artist" detection; collaborative/two-user exploration; historical-year
exploration; automatic shortest path between arbitrary artists;
achievements/gamification; permanently adding discovered artists to the
Galaxy.

## 27. Strong follow-up features

*Find a route to…* — choose an artist and calculate a path through the
explored similarity graph. *Route back home* — when several hops outside the
Galaxy, identify the nearest currently known Galaxy artists and offer a path
back. *Exploration history* — persist visited Frontier artists locally and
distinguish unexplored, explored before, and part of current Trail. *Deep
cluster frontier* — expand the Frontier ranking using second-degree
similarity without rendering every intermediate node. *Discovery map* — show
all artists the visitor has explored outside their Galaxy over time as a
separate overlay.

## 28. Success criteria

The feature is successful if a visitor can begin with an artist they already
recognise, leave their Galaxy, travel through several unfamiliar artists and
still answer all three questions: where did I start? why did this artist
appear? how do I get back? At no point should Groove Galaxy feel like a
random recommendation carousel.

The defining product idea is: your listening history is the mapped
territory, similarity data is the space beyond it, and exploration lets you
cross the border without losing the path home.
