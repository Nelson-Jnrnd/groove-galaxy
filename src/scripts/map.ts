/**
 * Groove Galaxy — the map.
 *
 * Draws a listening map onto a canvas and handles pan, zoom, hover, search,
 * selection and the keyboard route through it. The map is built live in the
 * browser (see lib/build.ts) rather than loaded from a precomputed file, so
 * this also drives the layout while it settles: bubbles appear as soon as
 * the artist list is known and visibly organise themselves over the next few
 * seconds as similarity arrives.
 *
 * It also owns which map is on screen. Three things can change that — the
 * account, the rolling period (7D…ALL) and entering or leaving the timeline
 * — and all three are the same operation: work out the view from the URL,
 * tear down whatever is showing, build the new one. The historical machinery
 * itself lives in scripts/timeline.ts and lib/{history,temporal}.ts and is
 * only loaded once somebody asks for it (§51, TE-REQ-20).
 */
import {
  build,
  EmptyHistoryError,
  norm,
  type Artist,
  type BuildMeta,
  type Cluster,
} from "../lib/build.ts";
import * as cache from "../lib/cache.ts";
import {
  aggregateFrontier,
  FRONTIER_LIMIT,
  galaxyIndex,
  placeFrontier,
  type ExploreOrigin,
  type FrontierCandidate,
} from "../lib/explore.ts";
import * as api from "../lib/lastfm.ts";
import {
  adjacency,
  ForceLayout,
  mdsSeed,
  spiral,
  type Edge,
  type Point,
} from "../lib/layout.ts";
import { PERIODS, periodInfo, type Period } from "../lib/period.ts";
import { parseView, sameView, toSearch, type ViewState } from "../lib/viewstate.ts";
import type { Explorer } from "./explorer.ts";

/* ─── Constants ──────────────────────────────────────────────────────── */

const UNCLUSTERED = "#6d6a62";
/** Screen radius (px) a bubble must reach before its name is drawn. */
const LABEL_AT = 15;
/** …and before its artwork is worth drawing rather than a flat disc. */
const ART_AT = 10;
/**
 * Artwork comes in two sizes. Every artist's thumbnail is prefetched in the
 * background — all 299 of them are only ~1.8 MB at 64px, which buys an
 * already-illustrated map instead of one that fills in a bubble at a time
 * as you zoom. The 174px version is fetched only once a bubble is big
 * enough on screen that 64px would look soft; prefetching that size for
 * everyone would cost ~11 MB, which is not a reasonable thing to do to
 * someone's phone.
 */
const THUMB_PX = "64s";
const DETAIL_PX = "174s";
/** On-screen radius past which the thumbnail stops being enough. */
const UPGRADE_AT = 34;
/**
 * Parallel image requests. Prefetching 299 thumbnails is bound by round
 * trips, not bandwidth — Last.fm's CDN averages ~200ms to first byte, so
 * wall-clock time is essentially (299 / this number) × 200ms. It serves
 * HTTP/2, where extra requests are extra streams on one connection rather
 * than extra connections, so a higher number is close to free. Anyone
 * behind an HTTP/1.1 proxy is capped at six by their browser regardless,
 * and simply queues.
 */
const MAX_CONCURRENT_IMAGES = 24;
const FLY_MS = 520;
/** How much of the map is left visible outside a focused region (EXP-REQ-1). */
const DIMMED = 0.12;
/** Per-frame budget for layout passes, leaving the rest of the frame to draw. */
const LAYOUT_BUDGET_MS = 7;

/**
 * A name waiting to be drawn. Labels are collected while the bubbles are
 * drawn and written afterwards, so that no bubble can land on top of a name
 * — and both the Galaxy's artists and the frontier around them queue up in
 * the same list.
 */
interface Label {
  name: string;
  sx: number;
  sy: number;
  r: number;
  alpha: number;
  emphasised: boolean;
}

/* ─── Small helpers ──────────────────────────────────────────────────── */

const $ = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const clamp = (v: number, lo: number, hi: number) =>
  v < lo ? lo : v > hi ? hi : v;

const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

/** Accent- and case-insensitive, for search matching. */
const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

const plural = (n: number, one: string, many = one + "s") =>
  `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/**
 * Last.fm image URLs carry their size in the path (`/i/u/300x300/<hash>.jpg`).
 * Bubbles are small, so ask for a variant rather than the original.
 */
function sized(url: string, size: string): string {
  return url.replace(/\/i\/u\/[^/]+\//, `/i/u/${size}/`);
}

/**
 * Last.fm's page for an artist we know only by name — which is all we have
 * for anything beyond the Galaxy, since it never came from a scrobble.
 */
export const lastFmArtistUrl = (name: string) =>
  `https://www.last.fm/music/${encodeURIComponent(name)}`;



/* ─── Entry point ────────────────────────────────────────────────────── */

/** The caption's live line: what the map is doing right now. */
function setCaption(text: string) {
  const el = document.getElementById("caption-asof");
  if (el) el.textContent = text;
}

/**
 * The one thing assistive technology is told out loud. Deliberately separate
 * from the caption, which ticks over every fifteen artists while a graph
 * builds: that is progress worth seeing and not worth hearing three hundred
 * times (TP-REQ-25 / TE-REQ-32).
 */
export function announce(text: string) {
  const el = document.getElementById("live");
  if (el) el.textContent = text;
}

export function start(): void {
  const stage = $<HTMLDivElement>("stage");
  const canvas = $<HTMLCanvasElement>("canvas");
  const veil = $<HTMLDivElement>("veil");
  const veilText = $<HTMLParagraphElement>("veil-text");
  const veilSub = $<HTMLParagraphElement>("veil-sub");
  const defaultUser = stage.dataset.defaultUser || "NestorDHCP";

  /** What the URL asks for… */
  let wanted = parseView(location.search, defaultUser);
  /** …and what is actually on screen, which lags it when a load fails. */
  let showing: ViewState | null = null;
  let current: MapView | null = null;
  /** Bumped on every view change; stale callbacks check it and give up. */
  let generation = 0;

  /** REQ-24: never leave a blank canvas behind — say what happened. */
  function quiet(message: string, detail?: string) {
    stage.dataset.state = "empty";
    delete stage.dataset.busy;
    veil.hidden = false;
    veilText.textContent = message;
    veilSub.hidden = !detail;
    if (detail) veilSub.textContent = detail;
    const scope = document.getElementById("caption-scope");
    const aboutScope = document.getElementById("about-scope");
    if (scope) scope.textContent = "Nothing to map right now.";
    if (aboutScope) {
      aboutScope.textContent =
        "Normally: the artists this account has played most on Last.fm, " +
        "sized by play count and placed next to whichever artists the data " +
        "says they are most alike.";
    }
    announce(message);
  }

  const accounts = wireAccountSwitcher(
    () => wanted.user,
    (user) => go({ ...wanted, user, mode: "map", frame: null }),
  );

  const periods = wirePeriodControl((period) =>
    go({ ...wanted, period, mode: "map", frame: null }),
  );

  const timelineEnter = document.getElementById("timeline-enter");
  timelineEnter?.addEventListener("click", () => {
    // §41 — the rolling period is carried along untouched, so leaving the
    // timeline can put the visitor back where they came from.
    go({ ...wanted, mode: "timeline", frame: null });
  });

  /**
   * Move to another view. Everything that changes what is on screen — a
   * period button, an account, entering or leaving the timeline, the back
   * button — arrives here, so there is one place where the URL, the controls
   * and the canvas are made to agree (TP-REQ-6/10/12).
   */
  function go(next: ViewState, replace = false) {
    const sameMap = Boolean(showing && sameView(next, showing));
    if (sameMap && next.period === wanted.period && next.explore === wanted.explore) {
      return;
    }
    wanted = next;
    const url = toSearch(next);
    if (replace || location.search === url) history.replaceState(null, "", url);
    else history.pushState(null, "", url);
    // Travelling between Systems changes which neighbourhood is on screen,
    // not which Galaxy it hangs off — so the map underneath is left exactly
    // as it was, which is the whole of `Return to Galaxy` (EXP-REQ-19).
    if (sameMap) {
      showing = next;
      syncExplore(next);
      return;
    }
    render(next);
  }

  window.addEventListener("popstate", () => {
    // TP-REQ-12 — Back and Forward are just another way of asking for a view.
    const next = parseView(location.search, defaultUser);
    if (showing && sameView(next, showing)) {
      wanted = next;
      showing = next;
      syncControls(next);
      // EXP-REQ-18 — Back walks the exploration route rather than rebuilding
      // an unrelated view.
      syncExplore(next);
      return;
    }
    wanted = next;
    render(next);
  });

  function syncControls(state: ViewState) {
    periods.sync(state.period, state.mode === "map");
    if (timelineEnter) {
      timelineEnter.setAttribute(
        "aria-pressed",
        state.mode === "timeline" ? "true" : "false",
      );
    }
  }

  /** Hand the stage over to a freshly built view, retiring the old one. */
  function adopt(view: MapView, state: ViewState) {
    if (current && current !== view) current.destroy();
    current = view;
    showing = state;
    delete stage.dataset.busy;
    stage.dataset.state = "ready";
    veil.hidden = true;
  }

  /**
   * TP-REQ-19/20 — a period or timeline that refuses to load must not cost
   * the visitor the map they already had, nor their account.
   */
  function failed(message: string, detail: string, state: ViewState) {
    if (current && showing) {
      delete stage.dataset.busy;
      setCaption(message);
      announce(`${message} Still showing ${describeView(showing)}.`);
      wanted = showing;
      syncControls(showing);
      history.replaceState(null, "", toSearch(showing));
      return;
    }
    quiet(message, detail);
    accounts.offerRetry(state.user);
  }

  function describeView(state: ViewState) {
    return state.mode === "timeline"
      ? `${state.user}'s timeline`
      : `${state.user} · ${periodInfo(state.period).label}`;
  }

  function render(state: ViewState) {
    const token = ++generation;
    const stale = () => token !== generation;
    // A different Galaxy is a different set of known artists, so whatever
    // was being explored around the old one no longer means anything (§18).
    closeExplorer();
    syncControls(state);
    document.title = `${state.user}'s listening map · Groove Galaxy`;

    if (current) {
      // §9 — the working map dims and stays put rather than being replaced by
      // a blank canvas while the next one is fetched.
      stage.dataset.busy = "true";
      setCaption(`Loading ${describeView(state)}…`);
    } else {
      veilText.textContent = "Reading the scrobbles…";
      veilSub.hidden = true;
      veil.hidden = false;
      stage.dataset.state = "loading";
    }
    announce(`Loading ${describeView(state)}.`);

    if (state.mode === "timeline") {
      renderTimeline(state, token, stale);
      return;
    }

    let built: MapView | null = null;
    build(state.user, state.period, {
      onArtists(artists, meta) {
        if (stale()) return;
        built = boot(stage, canvas, veil, artists, meta, {
          playsLabel: (a) =>
            `${plural(a.plays, "play")} · ${periodInfo(meta.period).suffix}`,
          // MVP-4 / §15 — any artist on the map is a door outward.
          onExplore: (name) => go({ ...wanted, explore: name }),
        });
        adopt(built, state);
      },
      onEdges(edges, done, total) {
        if (!stale()) built?.setEdges(edges, done, total);
      },
      onClusters(clusters) {
        if (!stale()) built?.setClusters(clusters);
      },
      onEnriched(artist) {
        if (!stale()) built?.refreshArtist(artist.id);
      },
      onLabels(clusters) {
        if (!stale()) built?.setClusters(clusters);
      },
    })
      .then(() => {
        if (stale()) return;
        accounts.remember(state.user);
        built?.finish();
        // A shared exploration link builds the Galaxy first, then opens the
        // System it names on top of it (§17).
        if (state.explore) syncExplore(state);
        announce(
          `${describeView(state)} ready. ${plural(
            built ? built.count : 0,
            "artist",
          )}.`,
        );
        // Housekeeping only once nobody is waiting on the network.
        void cache.sweep();
      })
      .catch((err: unknown) => {
        if (stale()) return;
        if (built) {
          // This map is already usable; a late failure is not a takeover.
          built.finish();
          return;
        }
        report(err, state);
      });
  }

  /** The historical machinery, fetched only when somebody asks for it. */
  function renderTimeline(
    state: ViewState,
    token: number,
    stale: () => boolean,
  ) {
    void import("./timeline.ts")
      .then(({ startTimeline }) =>
        startTimeline({
          stage,
          canvas,
          veil,
          state,
          stale,
          boot: (artists, meta, options) =>
            boot(stage, canvas, veil, artists, meta, options),
          adopt: (view, frame) => {
            if (stale()) return;
            const shown = { ...state, frame };
            adopt(view, shown);
            wanted = shown;
            history.replaceState(null, "", toSearch(shown));
            accounts.remember(state.user);
          },
          /**
           * TE-REQ-26 — the year is in the URL so it can be shared, but it
           * *replaces* rather than pushes: playing through eight years must
           * not leave eight entries for the back button to walk out of.
           */
          onFrame: (frame) => {
            if (stale()) return;
            const next = { ...wanted, frame };
            wanted = next;
            showing = next;
            history.replaceState(null, "", toSearch(next));
          },
          onExit: () => {
            if (token !== generation) return;
            // §41 — back to the rolling period the visitor arrived with.
            go({ ...wanted, mode: "map", frame: null });
          },
          onError: (err) => {
            if (!stale()) report(err, state);
          },
        }),
      )
      .catch((err: unknown) => {
        if (!stale()) report(err, state);
      });
  }

  function report(err: unknown, state: ViewState) {
    if (err instanceof EmptyHistoryError) {
      failed(
        "Not enough listening history to draw a map yet.",
        `${state.user} needs a few more scrobbles on the pile before there is a shape to show${
          state.period === "overall"
            ? ""
            : ` in ${periodInfo(state.period).phrase}`
        }.`,
        state,
      );
    } else if (err instanceof api.LastFmError && err.code === api.USER_NOT_FOUND) {
      failed(
        "No Last.fm account by that name.",
        `Last.fm doesn't know a user called "${state.user}".`,
        state,
      );
    } else if (err instanceof api.LastFmError && err.code === api.RATE_LIMITED) {
      // The key is shared and read-only, so a busy spell is somebody else's
      // map rather than anything this visitor did.
      failed(
        "Last.fm is asking us to slow down.",
        "Too many maps have been built in a short space of time. Waiting a minute and refreshing usually clears it.",
        state,
      );
    } else {
      failed(
        "Couldn't reach Last.fm just now.",
        "The map is built from live Last.fm data, and the request didn't come back. Refreshing may help.",
        state,
      );
    }
  }

  /* ── Exploration Mode (§8–§11) ────────────────────────────────────
     A layer over the map rather than a replacement for it: the Galaxy
     stays built and keeps whatever region it was focused on, so leaving a
     System is a matter of taking the layer away again (EXP-REQ-19).      */

  let explorer: Explorer | null = null;
  let explorerToken = 0;

  function closeExplorer() {
    explorerToken++;
    if (!explorer) return;
    explorer.destroy();
    explorer = null;
    delete stage.dataset.explore;
    current?.setDormant(false);
  }

  function originOf(view: MapView): ExploreOrigin {
    const focused = view.clusterFocus;
    return focused
      ? { kind: "cluster", clusterId: focused.id, label: focused.label }
      : { kind: "galaxy" };
  }

  function syncExplore(state: ViewState) {
    const token = ++explorerToken;
    if (state.mode !== "map" || !state.explore) {
      closeExplorer();
      return;
    }
    const map = current;
    if (!map) return;
    if (explorer) {
      explorer.travelTo(state.explore);
      return;
    }

    stage.dataset.explore = "true";
    map.setDormant(true);
    // §23 — the exploration module is fetched the first time somebody asks
    // to explore, the same way the timeline is.
    void import("./explorer.ts")
      .then(({ startExplorer }) => {
        if (token !== explorerToken || map !== current) return;
        explorer = startExplorer({
          stage,
          user: state.user,
          period: state.period,
          origin: originOf(map),
          anchor: state.explore!,
          artists: map.galaxyArtists,
          clusters: map.galaxyClusters,
          onTravel: (name) => {
            map.markExplored(name);
            go({ ...wanted, explore: name });
          },
          onBack: () => history.back(),
          onExit: () => go({ ...wanted, explore: null }),
        });
      })
      .catch(() => {
        if (token !== explorerToken) return;
        // Nothing to fall back to but the map itself, which is intact.
        delete stage.dataset.explore;
        map.setDormant(false);
        setCaption("Couldn't open exploration just now.");
        announce("Couldn't open exploration just now. Still showing the map.");
        wanted = { ...wanted, explore: null };
        history.replaceState(null, "", toSearch(wanted));
      });
  }

  // The URL is the source of truth from the very first frame, so a shared
  // link opens the account, the period and the year it names.
  history.replaceState(null, "", toSearch(wanted));
  render(wanted);
}

/* ─── the rolling-period control (TP-REQ-3/4/22/23) ──────────────────── */

/**
 * Six buttons, always visible, one of them pressed. Arrow keys move along
 * the row the way a segmented control should; the buttons themselves are
 * ordinary buttons, so they are keyboard-operable without any of that.
 *
 * Nothing here rebuilds the row when the map changes, which is what keeps a
 * keyboard user's focus where they left it while the new map loads
 * (TP-REQ-24).
 */
function wirePeriodControl(choose: (period: Period) => void) {
  const wrap = document.getElementById("periods");
  const buttons = new Map<Period, HTMLButtonElement>();
  if (wrap) {
    for (const info of PERIODS) {
      const btn = wrap.querySelector<HTMLButtonElement>(
        `[data-period="${info.value}"]`,
      );
      if (!btn) continue;
      buttons.set(info.value, btn);
      btn.addEventListener("click", () => choose(info.value));
    }
    wrap.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      const order = [...buttons.values()];
      const at = order.indexOf(document.activeElement as HTMLButtonElement);
      if (at === -1) return;
      e.preventDefault();
      const next =
        order[(at + (e.key === "ArrowRight" ? 1 : order.length - 1)) % order.length];
      next.focus();
    });
  }

  return {
    sync(period: Period, isMap: boolean) {
      for (const [value, btn] of buttons) {
        const on = isMap && value === period;
        btn.setAttribute("aria-pressed", on ? "true" : "false");
        btn.classList.toggle("is-on", on);
      }
    },
  };
}

/* ─── Choosing whose map to draw ─────────────────────────────────────── */

/** Accounts whose maps this browser has already built, newest first. */
const RECENTS_KEY = "groove-galaxy:recent-accounts";
const MAX_RECENTS = 6;

function readRecents(): string[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    const list: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(list)
      ? list.filter((x): x is string => typeof x === "string")
      : [];
  } catch {
    return []; // storage disabled — the feature simply isn't there
  }
}

/**
 * The account switcher.
 *
 * Wired up before the build starts and independent of it, because the case
 * that most needs it is the one where the build failed: a mistyped username
 * must offer a way to fix itself rather than being a dead end.
 *
 * Switching hands the account to the controller rather than reloading the
 * page: the URL still identifies the map — so it can be shared, bookmarked
 * and reached with the back button — but the browser keeps the caches it has
 * already warmed, and TP-REQ-5's "don't make me type my name again" holds
 * for every other control on the page too.
 */
function wireAccountSwitcher(
  current: () => string,
  navigate: (user: string) => void,
) {
  const dialog = $<HTMLDialogElement>("account");
  const form = $<HTMLFormElement>("account-form");
  const input = $<HTMLInputElement>("account-input");
  const error = $<HTMLParagraphElement>("account-error");
  const recentWrap = $<HTMLDivElement>("account-recent");
  const recentList = $<HTMLUListElement>("account-recent-list");
  const retry = $<HTMLButtonElement>("veil-retry");

  function show(prefill = "") {
    error.hidden = true;
    input.value = prefill;
    renderRecents();
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    input.focus();
    input.select();
  }

  function renderRecents() {
    const others = readRecents().filter(
      (name) => name.toLowerCase() !== current().toLowerCase(),
    );
    recentList.replaceChildren();
    if (!others.length) {
      recentWrap.hidden = true;
      return;
    }
    recentWrap.hidden = false;
    for (const name of others) {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "account__recent-btn";
      btn.textContent = name;
      // These are the maps that cost nothing to draw again.
      btn.title = `Show ${name}'s map — already cached, so it loads instantly`;
      btn.addEventListener("click", () => go(name));
      li.append(btn);
      recentList.append(li);
    }
  }

  function go(name: string) {
    const clean = name.trim();
    if (!clean) return;
    if (dialog.open) dialog.close();
    navigate(clean);
  }

  $<HTMLButtonElement>("account-open").addEventListener("click", () =>
    show(current()),
  );
  $<HTMLButtonElement>("account-cancel").addEventListener("click", () =>
    dialog.close(),
  );

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const name = input.value.trim();
    // Last.fm usernames are short and have no spaces; catching that here
    // saves a round trip to be told the obvious.
    if (!name || /\s/.test(name) || name.length > 30) {
      error.textContent = "That doesn't look like a Last.fm username.";
      error.hidden = false;
      input.focus();
      return;
    }
    go(name);
  });

  return {
    /** Offer the switcher from a failed build, prefilled with what failed. */
    offerRetry(prefill = "") {
      retry.hidden = false;
      retry.onclick = () => show(prefill);
    },
    /** Only remember an account whose map actually built. */
    remember(name: string) {
      try {
        const next = [
          name,
          ...readRecents().filter(
            (x) => x.toLowerCase() !== name.toLowerCase(),
          ),
        ].slice(0, MAX_RECENTS);
        localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
      } catch {
        /* storage disabled; the switcher still works, just without history */
      }
    },
  };
}

/* ─── The map proper ─────────────────────────────────────────────────── */

/** What `start()` keeps hold of so it can feed the map as data arrives. */
export interface MapView {
  setEdges(edges: Edge[], done: number, total: number): void;
  setClusters(clusters: Cluster[]): void;
  refreshArtist(id: number): void;
  finish(): void;
  /** How many bubbles this map holds. */
  readonly count: number;
  /** Every listener, observer and pending image this map owns, released. */
  destroy(): void;

  /* ── the hooks the timeline drives the same renderer through ────────
     A temporal frame changes radii and opacity and nothing else, so it
     needs to write those and ask for a repaint — not to own a renderer of
     its own (§50: the renderer is handed a state, it does not reconstruct
     history).                                                            */

  /** Repaint now, after the caller has written radii/alpha onto artists. */
  redraw(): void;
  /** Radii changed enough that the framing should be recomputed. */
  remeasure(): void;
  /**
   * Re-frame on the whole map — but only while the visitor has not taken the
   * view over. Once they have panned or zoomed, the view is theirs.
   */
  refit(): void;
  /** Called once the reference layout has finished settling. */
  onSettled(fn: () => void): void;
  /** A copy of the settled reference coordinates (§20). */
  basePositions(): Point[];
  /** Freeze the force simulation — the timeline owns positions from here. */
  stopLayout(): void;
  /** Re-render the open detail panel, e.g. after moving to another year. */
  refreshDetail(): void;
  /** The sentence under the map. */
  setCaptionScope(text: string): void;
  /** The live line beside it. */
  setStatus(text: string): void;
  /** Whichever artist the panel is open on, if any. */
  readonly selection: Artist | null;

  /* ── what Exploration Mode needs from the map (EXP §5, §14) ──────── */

  /** Frame and dim for one group, or `null` to show the whole Galaxy. */
  focusCluster(id: number | null): void;
  /** The group currently focused, if any — an exploration's origin. */
  readonly clusterFocus: Cluster | null;
  /** The Galaxy's artist set: what "in your Galaxy" means right now. */
  readonly galaxyArtists: Artist[];
  readonly galaxyClusters: Cluster[];
  /** Hand the stage to an exploration overlay, or take it back. */
  setDormant(on: boolean): void;
  /** Remember that an outside artist has been visited on this trail (§3). */
  markExplored(name: string): void;
}

export interface BootOptions {
  /** How a play count is worded — the active period or year decides it. */
  playsLabel?: (a: Artist) => string;
  /** Extra detail-panel content for the artist, inserted after the title. */
  detailExtra?: (a: Artist) => Node | null;
  /**
   * How the panel ranks this artist, or null for no ranking at all. The
   * timeline passes null: its own block already gives the rank *within the
   * shown year*, and a second ranking by range total would contradict it.
   */
  rankLine?: (a: Artist) => string | null;
  /** Somebody opened or closed an artist (TE-REQ-16 pauses playback on it). */
  onSelect?: (a: Artist | null) => void;
  /** Timeline mode: the caller supplies coordinates, not the force layout. */
  externalPositions?: boolean;
  /**
   * Somebody asked to explore outward from an artist. Absent in the
   * timeline, where exploration is deliberately out of scope (§19) — and
   * the button simply isn't offered rather than being offered and refused.
   */
  onExplore?: (name: string) => void;
}

/**
 * Which map currently owns the page's shared furniture — the legend, the
 * detail panel, the keyboard route, the search box. A map being retired
 * tidies those away only if a successor has not already claimed them, which
 * is the normal case when one period replaces another: the new map is built
 * and adopted first, and only then is the old one destroyed.
 */
let owner = 0;

function boot(
  stage: HTMLDivElement,
  canvas: HTMLCanvasElement,
  veil: HTMLDivElement,
  artists: Artist[],
  meta: BuildMeta,
  options: BootOptions = {},
): MapView {
  const mine = ++owner;
  /** Everything this map subscribes to, dropped in one go by `destroy()`. */
  const life = new AbortController();
  const signal = life.signal;
  let dead = false;
  const playsLabel =
    options.playsLabel || ((a: Artist) => plural(a.plays, "play"));
  const rankLine =
    options.rankLine === undefined ? defaultRankLine : options.rankLine;
  const ctx = canvas.getContext("2d", { alpha: false })!;
  const byId = new Map(artists.map((a) => [a.id, a]));

  // Whatever the last map left on the page belongs to the last map: an open
  // panel describing an artist in 2023 has no business surviving into the
  // 12-month map that replaced it.
  {
    const panel = $<HTMLElement>("detail");
    panel.hidden = true;
    panel.replaceChildren();
    const hoverTip = $<HTMLDivElement>("tip");
    hoverTip.hidden = true;
    const legendItems = $<HTMLUListElement>("legend-list");
    legendItems.replaceChildren();
    $<HTMLDivElement>("legend").hidden = true;
    const region = $<HTMLElement>("cluster-panel");
    region.hidden = true;
    region.replaceChildren();
  }
  let clusters: Cluster[] = [];
  const colorOf = (a: Artist) =>
    a.cluster >= 0 && clusters[a.cluster]
      ? clusters[a.cluster].color
      : UNCLUSTERED;

  /* ── the live layout ────────────────────────────────────────────────
     Everyone starts on an even spiral, which already reads as a map, and
     is pulled into shape as similarity arrives.                         */

  const radii = artists.map((a) => a.r);
  const layout = new ForceLayout();
  layout.reset(spiral(artists.length, Math.max(...radii) * 1.6), radii);
  syncPositions();

  function syncPositions() {
    for (let i = 0; i < artists.length; i++) {
      artists[i].x = layout.pos[i].x;
      artists[i].y = layout.pos[i].y;
    }
  }

  /** Bubbles move, so the extent has to be recomputed rather than read. */
  let bounds = { minX: -1, maxX: 1, minY: -1, maxY: 1 };
  function measure() {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const a of artists) {
      if (a.x - a.r < minX) minX = a.x - a.r;
      if (a.x + a.r > maxX) maxX = a.x + a.r;
      if (a.y - a.r < minY) minY = a.y - a.r;
      if (a.y + a.r > maxY) maxY = a.y + a.r;
    }
    const pad = Math.max(...radii);
    bounds = {
      minX: minX - pad, maxX: maxX + pad,
      minY: minY - pad, maxY: maxY + pad,
    };
  }
  measure();

  /* ── viewport ───────────────────────────────────────────────────── */

  let width = 0;
  let height = 0;
  let dpr = 1;
  const view = { cx: 0, cy: 0, scale: 1 };
  const biggestRadius = Math.max(...artists.map((a) => a.r));
  let fitScale = 1;
  let framed = false;
  const home = { cx: 0, cy: 0, scale: 1 };

  const toScreenX = (x: number) => (x - view.cx) * view.scale + width / 2;
  const toScreenY = (y: number) => (y - view.cy) * view.scale + height / 2;
  const toWorldX = (sx: number) => (sx - width / 2) / view.scale + view.cx;
  const toWorldY = (sy: number) => (sy - height / 2) / view.scale + view.cy;

  function computeHome() {
    const { minX, maxX, minY, maxY } = bounds;
    const w = Math.max(maxX - minX, 1);
    const h = Math.max(maxY - minY, 1);
    fitScale = Math.min(width / w, height / h) * 0.94;
    home.cx = (minX + maxX) / 2;
    home.cy = (minY + maxY) / 2;
    // On a phone, fitting the whole map leaves every bubble a few pixels
    // across and unlabelled. Below that floor the default view zooms in
    // instead and lets the visitor pan for the edges.
    const readable = 15 / biggestRadius;
    home.scale = Math.max(fitScale, readable);
  }

  function resize() {
    const rect = stage.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = Math.max(rect.width, 1);
    height = Math.max(rect.height, 1);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    computeHome();
    if (!framed) {
      // First measurement: start on the overview the reset button returns to.
      framed = true;
      view.cx = home.cx;
      view.cy = home.cy;
      view.scale = home.scale;
    }
    draw();
  }

  /* ── state ──────────────────────────────────────────────────────── */

  let hovered: Artist | null = null;
  let selected: Artist | null = null;
  let focused: Artist | null = null;
  /** Set while an exploration overlay owns the stage. */
  let dormant = false;

  /**
   * An artist beyond the Galaxy, drawn around the rim of a focused region.
   *
   * Deliberately not an `Artist` (§23): there is no play count, no radius
   * derived from one, and no cluster — this artist never went through the
   * Galaxy's clustering, and claiming a colour for it would say it had.
   */
  interface FrontierNode {
    candidate: FrontierCandidate;
    x: number;
    y: number;
    r: number;
    image: string;
  }

  let focusCluster: Cluster | null = null;
  let frontier: FrontierNode[] = [];
  let hoveredFrontier: FrontierNode | null = null;
  let selectedFrontier: FrontierNode | null = null;
  /** Non-null while the search box is narrowing things down. */
  let matches: Set<number> | null = null;

  /** Best artwork held for an artist so far, and which size it is. */
  const images = new Map<number, { img: HTMLImageElement; detail: boolean }>();
  const imageFailed = new Set<string>();

  let dirty = true;
  let rafId = 0;
  const draw = () => {
    dirty = true;
    if (!rafId) rafId = requestAnimationFrame(frame);
  };

  /** The view moved, so what's worth fetching first has changed. */
  const reprioritise = () => {
    queueOrderStale = true;
    pumpImages();
  };

  /* ── artwork ─────────────────────────────────────────────────────
     A self-draining queue. Every completion — success *or* failure —
     starts the next job, so one dead image can no longer wedge the whole
     pipeline the way a bare in-flight counter did. Jobs are re-sorted
     whenever the view moves, so whatever is on screen is fetched first
     and the background prefetch fills in behind it.                     */

  interface ImageJob {
    artist: Artist;
    detail: boolean;
  }

  let queue: ImageJob[] = [];
  const queued = new Set<string>();
  let activeImages = 0;
  let queueOrderStale = true;

  const jobKey = (id: number, detail: boolean) =>
    `${id}:${detail ? "d" : "t"}`;

  /** Honour a visitor who has asked their browser to save data. */
  const saveData = Boolean(
    (navigator as Navigator & { connection?: { saveData?: boolean } })
      .connection?.saveData,
  );

  function enqueue(a: Artist, detail: boolean) {
    if (!a.image) return;
    // Under Save-Data, only fetch art for a bubble big enough to warrant it.
    if (saveData && !detail) return;
    const key = jobKey(a.id, detail);
    if (queued.has(key) || imageFailed.has(key)) return;
    const held = images.get(a.id);
    if (held && (held.detail || !detail)) return; // already have this or better
    queued.add(key);
    queue.push({ artist: a, detail });
    pumpImages();
  }

  /** Distance from the centre of the viewport, in world units. */
  function offScreenness(a: Artist) {
    return Math.hypot(a.x - view.cx, a.y - view.cy);
  }

  function pumpImages() {
    if (dead) return;
    if (queueOrderStale && queue.length > 1) {
      // Nearest to the middle of the current view first, and within that
      // the bigger bubbles — which is the order a visitor notices them in.
      queue.sort(
        (j, k) =>
          offScreenness(j.artist) - offScreenness(k.artist) ||
          k.artist.r - j.artist.r,
      );
      queueOrderStale = false;
    }

    while (activeImages < MAX_CONCURRENT_IMAGES && queue.length) {
      const job = queue.shift()!;
      const key = jobKey(job.artist.id, job.detail);
      const held = images.get(job.artist.id);
      if (held && (held.detail || !job.detail)) {
        queued.delete(key);
        continue;
      }

      activeImages++;
      const img = new Image();
      img.decoding = "async";
      img.referrerPolicy = "no-referrer";
      // Only the on-demand upgrades get a priority hint. The background
      // prefetch deliberately stays on "auto": marking it "low" lets
      // Chromium's resource scheduler park those requests indefinitely
      // while anything else on the page is still pending, which is exactly
      // the never-finishes-loading behaviour this queue exists to fix.
      if (job.detail) {
        (img as HTMLImageElement & { fetchPriority?: string }).fetchPriority =
          "high";
      }

      let settled = false;
      const done = (ok: boolean) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        activeImages--;
        queued.delete(key);
        if (ok) {
          const current = images.get(job.artist.id);
          // A late thumbnail must never overwrite a detail image.
          if (!current || (job.detail && !current.detail)) {
            images.set(job.artist.id, { img, detail: job.detail });
            draw();
          }
        } else {
          imageFailed.add(key);
        }
        pumpImages(); // the point of all this: always keep draining
      };

      // Last.fm's CDN occasionally takes several seconds on a cache miss.
      // Without this, one such request holds a slot indefinitely and the
      // queue drains ten times slower than it should.
      const timer = window.setTimeout(() => {
        img.src = ""; // abandon it
        done(false);
      }, 15000);

      img.onload = () => done(img.naturalWidth > 0);
      img.onerror = () => done(false);
      img.src = sized(job.artist.image, job.detail ? DETAIL_PX : THUMB_PX);
    }
  }


  /* ── drawing ────────────────────────────────────────────────────── */

  function frame() {
    rafId = 0;
    if (!dirty) return;
    dirty = false;
    render();
  }

  function render() {
    ctx.fillStyle = "#141413";
    ctx.fillRect(0, 0, width, height);

    const highlight = selected || hovered || focused;
    const linked = new Set<number>();
    if (highlight) {
      linked.add(highlight.id);
      for (const s of highlight.similar) linked.add(s.id);
    }

    // Similarity links, drawn only for whatever is currently in focus. This
    // is the "why is this here" answer made visible (REQ-9/REQ-13) without
    // turning the whole map into a hairball.
    if (highlight) {
      ctx.lineWidth = 1;
      for (const s of highlight.similar) {
        const other = byId.get(s.id);
        if (!other || other.r <= 0 || (other.alpha ?? 1) <= 0.12) continue;
        ctx.strokeStyle = `rgba(236, 233, 225, ${0.1 + s.score * 0.32})`;
        ctx.beginPath();
        ctx.moveTo(toScreenX(highlight.x), toScreenY(highlight.y));
        ctx.lineTo(toScreenX(other.x), toScreenY(other.y));
        ctx.stroke();
      }
    }

    // EXP-REQ-7 — at rest a focused region is not covered in lines; the
    // links out only appear for the frontier artist being looked at.
    const showLinks = selectedFrontier || hoveredFrontier;
    if (showLinks && focusCluster) {
      ctx.lineWidth = 1;
      for (const link of showLinks.candidate.links) {
        const member = byId.get(link.artistId);
        if (!member) continue;
        ctx.strokeStyle = `rgba(236, 233, 225, ${0.12 + link.match * 0.4})`;
        ctx.beginPath();
        ctx.moveTo(toScreenX(showLinks.x), toScreenY(showLinks.y));
        ctx.lineTo(toScreenX(member.x), toScreenY(member.y));
        ctx.stroke();
      }
    }

    const labels: Label[] = [];

    for (const a of artists) {
      // A temporal frame the artist wasn't played in leaves them at zero
      // radius: nothing to draw, and nothing to trip over (TE-REQ-10).
      const own = a.alpha ?? 1;
      if (a.r <= 0 || own <= 0.01) continue;
      const r = a.r * view.scale;
      const sx = toScreenX(a.x);
      const sy = toScreenY(a.y);
      if (sx + r < -40 || sx - r > width + 40) continue;
      if (sy + r < -40 || sy - r > height + 40) continue;

      const isMatch = !matches || matches.has(a.id);
      const isLinked = !highlight || linked.has(a.id);
      let alpha = own;
      // EXP-REQ-1 — a focused region keeps its members fully visible and
      // pushes the rest of the Galaxy well back, without moving anything.
      if (focusCluster && a.cluster !== focusCluster.id) alpha *= DIMMED;
      if (!isMatch) alpha *= 0.14;
      else if (!isLinked) alpha *= 0.5;

      const color = colorOf(a);
      ctx.globalAlpha = alpha;

      if (r >= UPGRADE_AT) enqueue(a, true);
      const held = images.get(a.id);
      const img = held && held.img;

      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);

      if (img && r >= ART_AT) {
        ctx.save();
        ctx.clip();
        ctx.drawImage(img, sx - r, sy - r, r * 2, r * 2);
        // A wash of the group colour keeps 300 different covers reading as
        // one map rather than a contact sheet.
        ctx.globalAlpha = alpha * 0.42;
        ctx.fillStyle = color;
        ctx.fillRect(sx - r, sy - r, r * 2, r * 2);
        ctx.restore();
        ctx.globalAlpha = alpha;
      } else {
        ctx.fillStyle = color;
        ctx.globalAlpha = alpha * 0.5;
        ctx.fill();
        ctx.globalAlpha = alpha;
      }

      const emphasised = a === selected || a === hovered || a === focused;
      ctx.lineWidth = emphasised ? 2.5 : 1.25;
      ctx.strokeStyle = emphasised ? "#ece9e1" : color;
      ctx.stroke();

      if (a === focused && a !== selected) {
        ctx.beginPath();
        ctx.arc(sx, sy, r + 5, 0, Math.PI * 2);
        ctx.strokeStyle = "#5fa877";
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      if (r >= LABEL_AT || emphasised || (matches && matches.has(a.id))) {
        labels.push({
          name: a.name,
          sx,
          sy,
          r,
          alpha: clamp(alpha * 1.4, 0, 1),
          emphasised,
        });
      }
    }

    drawFrontier(labels);

    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (const { name, sx, sy, r, alpha, emphasised } of labels) {
      // A fading artist's name fades with it rather than hanging over an
      // empty patch of map.
      ctx.globalAlpha = alpha;
      ctx.font = `${emphasised ? 500 : 400} ${clamp(r * 0.34, 11, 15).toFixed(1)}px "IBM Plex Sans", system-ui, sans-serif`;
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(20, 20, 19, 0.85)";
      ctx.strokeText(name, sx, sy + r + 5);
      ctx.fillStyle = emphasised ? "#ece9e1" : "rgba(236, 233, 225, 0.72)";
      ctx.fillText(name, sx, sy + r + 5);
    }
    ctx.globalAlpha = 1;
  }

  /**
   * The artists just outside the Galaxy, drawn around the rim of the region
   * that reaches them (§7).
   *
   * Their visual language is deliberately *not* the map's: no group colour,
   * a dashed halo rather than a solid rim, and a lighter weight overall.
   * A frontier artist has not been through the Galaxy's clustering, so
   * painting it in a cluster's colour would claim a membership it does not
   * have — and the difference has to survive being seen in greyscale
   * (§7, §21), which is why it is a different *shape* of ring and not a
   * different hue.
   */
  function drawFrontier(labels: Label[]) {
    if (!frontier.length) return;
    for (const node of frontier) {
      const r = node.r * view.scale;
      const sx = toScreenX(node.x);
      const sy = toScreenY(node.y);
      if (sx + r < -60 || sx - r > width + 60) continue;
      if (sy + r < -60 || sy - r > height + 60) continue;

      const emphasised = node === selectedFrontier || node === hoveredFrontier;
      const visited = explored.has(norm(node.candidate.name));
      ctx.globalAlpha = emphasised ? 1 : 0.82;

      const img = frontierImages.get(norm(node.candidate.name));
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      if (img && r >= ART_AT) {
        ctx.save();
        ctx.clip();
        ctx.drawImage(img, sx - r, sy - r, r * 2, r * 2);
        // Desaturating wash: known territory is in colour, this is not.
        ctx.globalAlpha = (emphasised ? 1 : 0.82) * 0.45;
        ctx.fillStyle = "#1a1a18";
        ctx.fillRect(sx - r, sy - r, r * 2, r * 2);
        ctx.restore();
        ctx.globalAlpha = emphasised ? 1 : 0.82;
      } else {
        ctx.fillStyle = "rgba(236, 233, 225, 0.08)";
        ctx.fill();
      }

      // The border: dashed for an artist beyond the Galaxy, closed for one
      // that has been visited — so "explored" reads without colour too.
      ctx.setLineDash(visited ? [] : [4, 3]);
      ctx.lineWidth = emphasised ? 2.2 : 1.4;
      ctx.strokeStyle = emphasised
        ? "#ece9e1"
        : visited
          ? "rgba(95, 168, 119, 0.85)"
          : "rgba(236, 233, 225, 0.55)";
      ctx.stroke();
      ctx.setLineDash([]);

      // …plus a halo, which is what actually reads at a glance: these are
      // outside the border of the map rather than part of it.
      ctx.beginPath();
      ctx.arc(sx, sy, r + 4, 0, Math.PI * 2);
      ctx.strokeStyle = emphasised
        ? "rgba(236, 233, 225, 0.35)"
        : "rgba(236, 233, 225, 0.13)";
      ctx.lineWidth = 1;
      ctx.stroke();

      labels.push({
        name: node.candidate.name,
        sx,
        sy,
        r,
        alpha: emphasised ? 1 : 0.78,
        emphasised,
      });
    }
    ctx.globalAlpha = 1;
  }

  /* ── hit testing ────────────────────────────────────────────────── */

  /** Frontier nodes sit on top: they are the reason the region is focused. */
  function hitFrontier(sx: number, sy: number): FrontierNode | null {
    if (!frontier.length) return null;
    const wx = toWorldX(sx);
    const wy = toWorldY(sy);
    let best: FrontierNode | null = null;
    let bestDepth = Infinity;
    for (const node of frontier) {
      const grab = Math.max(node.r, 10 / view.scale);
      const d = Math.hypot(wx - node.x, wy - node.y);
      if (d <= grab && d - node.r < bestDepth) {
        bestDepth = d - node.r;
        best = node;
      }
    }
    return best;
  }

  function hit(sx: number, sy: number): Artist | null {
    const wx = toWorldX(sx);
    const wy = toWorldY(sy);
    let best: Artist | null = null;
    let bestDepth = Infinity;
    for (const a of artists) {
      if (a.r <= 0 || (a.alpha ?? 1) <= 0.12) continue; // §26: gone means gone
      const dx = wx - a.x;
      const dy = wy - a.y;
      // Keep small bubbles tappable even when zoomed out (REQ-21).
      const grab = Math.max(a.r, 9 / view.scale);
      const d = Math.hypot(dx, dy);
      if (d <= grab && d - a.r < bestDepth) {
        bestDepth = d - a.r;
        best = a;
      }
    }
    return best;
  }

  /* ── camera moves ───────────────────────────────────────────────── */

  let animation = 0;

  function stopAnimation() {
    if (animation) cancelAnimationFrame(animation);
    animation = 0;
  }

  function flyTo(cx: number, cy: number, scale: number) {
    stopAnimation();
    const from = { ...view };
    const to = { cx, cy, scale: clamp(scale, fitScale * 0.45, fitScale * 14) };
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      Object.assign(view, to);
      draw();
      return;
    }
    const t0 = performance.now();
    const step = (now: number) => {
      const t = clamp((now - t0) / FLY_MS, 0, 1);
      const e = easeOut(t);
      view.cx = from.cx + (to.cx - from.cx) * e;
      view.cy = from.cy + (to.cy - from.cy) * e;
      // Interpolate zoom geometrically — linear zoom reads as a lurch.
      view.scale = from.scale * Math.pow(to.scale / from.scale, e);
      draw();
      if (t < 1) animation = requestAnimationFrame(step);
      else {
        animation = 0;
        reprioritise();
      }
    };
    animation = requestAnimationFrame(step);
  }

  function flyToArtist(a: Artist) {
    // Close enough to read the neighbourhood, never so close it loses context.
    const target = clamp(
      Math.min(width, height) / (Math.max(a.r, 8) * 9),
      fitScale * 1.1,
      fitScale * 5,
    );
    flyTo(a.x, a.y, Math.max(view.scale, target));
  }

  function zoomAbout(sx: number, sy: number, factor: number) {
    stopAnimation();
    const wx = toWorldX(sx);
    const wy = toWorldY(sy);
    view.scale = clamp(view.scale * factor, fitScale * 0.45, fitScale * 14);
    view.cx = wx - (sx - width / 2) / view.scale;
    view.cy = wy - (sy - height / 2) / view.scale;
    draw();
    reprioritise();
  }

  function resetView() {
    flyTo(home.cx, home.cy, home.scale);
  }

  /* ── pointer: pan, pinch, tap, hover ────────────────────────────── */

  const pointers = new Map<number, { x: number; y: number }>();
  let panning = false;
  let movedBy = 0;
  let last = { x: 0, y: 0 };
  let pinchDistance = 0;

  const localPoint = (e: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture(e.pointerId);
    const p = localPoint(e);
    pointers.set(e.pointerId, p);
    if (pointers.size === 1) {
      stopAnimation();
      panning = true;
      movedBy = 0;
      last = p;
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchDistance = Math.hypot(a.x - b.x, a.y - b.y);
      panning = false;
    }
  }, { signal });

  canvas.addEventListener("pointermove", (e) => {
    const p = localPoint(e);

    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, p);

    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchDistance > 0 && d > 0) {
        zoomAbout((a.x + b.x) / 2, (a.y + b.y) / 2, d / pinchDistance);
      }
      pinchDistance = d;
      return;
    }

    if (panning) {
      const dx = p.x - last.x;
      const dy = p.y - last.y;
      movedBy += Math.abs(dx) + Math.abs(dy);
      view.cx -= dx / view.scale;
      view.cy -= dy / view.scale;
      last = p;
      draw();
      reprioritise();
      return;
    }

    if (e.pointerType === "mouse") {
      const node = hitFrontier(p.x, p.y);
      if (node) setFrontierHover(node, e.clientX, e.clientY);
      else setHover(hit(p.x, p.y), e.clientX, e.clientY);
    }
  }, { signal });

  function endPointer(e: PointerEvent) {
    const wasPanning = panning;
    const p = pointers.get(e.pointerId) || localPoint(e);
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchDistance = 0;
    if (pointers.size === 0) panning = false;

    // A tap, not a drag.
    if (wasPanning && movedBy < 6 && e.type === "pointerup") {
      const node = hitFrontier(p.x, p.y);
      if (node) {
        // §21 — touch reaches everything a pointer does.
        if (e.pointerType !== "mouse") setFrontierHover(node, e.clientX, e.clientY);
        selectFrontier(node);
        return;
      }
      const target = hit(p.x, p.y);
      if (target) {
        if (e.pointerType !== "mouse") setHover(target, e.clientX, e.clientY);
        select(target);
      } else {
        deselect();
        setHover(null);
      }
    }
  }

  canvas.addEventListener("pointerup", endPointer, { signal });
  canvas.addEventListener("pointercancel", endPointer, { signal });
  canvas.addEventListener("pointerleave", () => {
    if (!panning) {
      setHover(null);
      setFrontierHover(null);
    }
  }, { signal });

  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      // Trackpads report tiny deltas, mice report large ones; normalise.
      const step = Math.exp(-clamp(e.deltaY, -60, 60) * 0.0032);
      zoomAbout(e.clientX - rect.left, e.clientY - rect.top, step);
    },
    { passive: false, signal },
  );

  /* ── hover tooltip (REQ-20) ─────────────────────────────────────── */

  const tip = $<HTMLDivElement>("tip");

  /**
   * The tooltip for an artist beyond the Galaxy. It never shows a play
   * count — not appearing in this Galaxy is not evidence of zero listening
   * (§12), so the honest thing to show is the connection that put it there.
   */
  function setFrontierHover(
    node: FrontierNode | null,
    clientX = 0,
    clientY = 0,
  ) {
    if (node) setHover(null);
    if (node !== hoveredFrontier) {
      hoveredFrontier = node;
      canvas.style.cursor = node ? "pointer" : "grab";
      draw();
    }
    if (!node) {
      if (!hovered) tip.hidden = true;
      return;
    }
    tip.hidden = false;
    tip.textContent = `${node.candidate.name} · beyond your Galaxy · ${plural(
      node.candidate.supportCount,
      "link",
    )} into this region`;
    positionTip(clientX, clientY);
  }

  function positionTip(clientX: number, clientY: number) {
    const rect = stage.getBoundingClientRect();
    const x = clamp(clientX - rect.left + 14, 8, rect.width - tip.offsetWidth - 8);
    const y = clamp(clientY - rect.top + 16, 8, rect.height - tip.offsetHeight - 8);
    tip.style.transform = `translate(${x}px, ${y}px)`;
  }

  function setHover(a: Artist | null, clientX = 0, clientY = 0) {
    if (a && hoveredFrontier) {
      hoveredFrontier = null;
      draw();
    }
    if (a !== hovered) {
      hovered = a;
      canvas.style.cursor = a ? "pointer" : "grab";
      draw();
    }
    if (!a) {
      tip.hidden = true;
      return;
    }
    tip.hidden = false;
    tip.textContent = `${a.name} · ${playsLabel(a)}`;
    positionTip(clientX, clientY);
  }

  /* ── detail panel (REQ-14/15/16) ────────────────────────────────── */

  const detail = $<HTMLElement>("detail");

  /** Where focus should land when the detail panel closes. */
  let returnFocusTo: HTMLElement | null = null;

  function select(a: Artist, { fly = false, takeFocus = false } = {}) {
    if (selected === a) {
      deselect();
      return;
    }
    selectedFrontier = null;
    selected = a;
    // TE-REQ-16 — reading an artist stops the timeline advancing under you.
    options.onSelect?.(a);
    if (fly) flyToArtist(a);
    renderDetail(a);
    syncA11y();
    draw();
    if (takeFocus) {
      returnFocusTo = a11yButtons.get(a.id) || null;
      detail.focus();
    }
  }

  function deselect() {
    if (selectedFrontier) {
      selectedFrontier = null;
      detail.hidden = true;
      detail.replaceChildren();
      delete stage.dataset.detail;
      draw();
    }
    if (!selected) return;
    selected = null;
    options.onSelect?.(null);
    detail.hidden = true;
    detail.replaceChildren();
    delete stage.dataset.detail;
    syncA11y();
    draw();
    if (returnFocusTo) {
      returnFocusTo.focus();
      returnFocusTo = null;
    }
    // REQ-16: closing changes nothing about where the visitor is looking.
  }

  function el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
    text?: string,
  ): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function renderDetail(a: Artist) {
    detail.replaceChildren();
    detail.hidden = false;
    // On a phone the region panel and the artist panel want the same
    // bottom of the same screen; the artist you just opened wins, and
    // closing it brings the region back.
    stage.dataset.detail = "true";

    const close = el("button", "detail__close", "✕");
    close.type = "button";
    close.setAttribute("aria-label", "Close artist details");
    close.addEventListener("click", () => {
      const origin = returnFocusTo;
      deselect();
      if (!origin) search.focus();
    });

    const art = el(
      "div",
      "detail__art" + (a.image ? "" : " detail__art--empty"),
    );
    if (a.image) {
      art.style.backgroundImage = `url("${sized(a.image, DETAIL_PX)}")`;
      enqueue(a, true); // the map should sharpen to match the panel
    } else {
      art.textContent = "♪";
    }
    art.style.setProperty("--tint", colorOf(a));

    const body = el("div", "detail__body");

    const kicker = el("p", "detail__kicker");
    const swatch = el("span", "detail__swatch");
    swatch.style.background = colorOf(a);
    swatch.setAttribute("aria-hidden", "true");
    kicker.append(
      swatch,
      document.createTextNode(
        a.cluster >= 0 && clusters[a.cluster]
          ? clusters[a.cluster].label
          : "no strong ties on this map",
      ),
    );

    const title = el("h2", "detail__title", a.name);

    // §11 — a windowed play count says which window it is a count of, so
    // "47 plays" can never be mistaken for a lifetime total.
    const label = playsLabel(a);
    const [head, ...rest] = label.split(" · ");
    const rank = rankLine(a);
    const plays = el("p", "detail__plays");
    plays.append(
      el("strong", undefined, head),
      document.createTextNode(
        `${rest.length ? ` · ${rest.join(" · ")}` : ""}${rank ? ` — ${rank}` : ""}`,
      ),
    );

    body.append(kicker, title, plays);

    const extra = options.detailExtra?.(a);
    if (extra) body.append(extra);

    if (a.tags.length) {
      const tags = el("ul", "detail__tags");
      for (const t of a.tags) tags.append(el("li", "detail__tag", t));
      body.append(tags);
    }

    const link = el("p", "detail__links");
    const anchor = el("a", undefined, "Last.fm page ↗");
    anchor.href = a.url;
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    link.append(anchor);
    body.append(link);

    // §15 — exploring never requires focusing a whole region first. One
    // artist you like is reason enough to look at what surrounds it.
    if (options.onExplore) {
      const explore = el("button", "detail__explore", "Explore from here →");
      explore.type = "button";
      explore.title = `Open the artists around ${a.name}`;
      explore.addEventListener("click", () => options.onExplore!(a.name));
      body.append(explore);
    }

    // REQ-13/REQ-15: the positioning, explained one artist at a time.
    const nearHead = el(
      "p",
      "detail__near-head",
      a.similar.length ? "Closest on this map" : "Nothing close on this map",
    );
    body.append(nearHead);

    if (a.similar.length) {
      const list = el("ul", "detail__near");
      for (const s of a.similar) {
        const other = byId.get(s.id);
        if (!other) continue;
        const li = el("li");
        const btn = el("button", "near");
        btn.type = "button";
        const name = el("span", "near__name", other.name);
        const bar = el("span", "near__bar");
        bar.setAttribute("aria-hidden", "true");
        const fill = el("span", "near__fill");
        fill.style.width = `${Math.round(clamp(s.score, 0.04, 1) * 100)}%`;
        fill.style.background = colorOf(other);
        bar.append(fill);
        const score = el("span", "near__score", s.score.toFixed(2));
        btn.setAttribute(
          "aria-label",
          `${other.name}, similarity ${s.score.toFixed(2)} — show on the map`,
        );
        btn.append(name, bar, score);
        btn.addEventListener("click", (event) => {
          const origin = returnFocusTo;
          selected = null;
          select(other, { fly: true });
          returnFocusTo = origin;
          if (event.detail === 0) detail.focus();
        });
        li.append(btn);
        list.append(li);
      }
      body.append(list);
      body.append(
        el(
          "p",
          "detail__why",
          "Similarity comes from Last.fm's own listening data — it is what pulled these bubbles together.",
        ),
      );
    } else {
      body.append(
        el(
          "p",
          "detail__why",
          "Nothing else here is strongly tied to this artist, so the bubble drifted to the edge rather than joining a group.",
        ),
      );
    }

    detail.append(close, art, body);
    detail.scrollTop = 0;
  }

  function defaultRankLine(a: Artist) {
    const rank = artists.filter((o) => o.plays > a.plays).length + 1;
    return `#${rank} most played of the ${artists.length} artists here`;
  }

  /* ── keyboard route through the bubbles (REQ-22) ─────────────────── */

  const a11yList = $<HTMLUListElement>("a11y-list");
  const a11yButtons = new Map<number, HTMLButtonElement>();

  {
    // A previous map's list is gone; this one owns the route now.
    a11yList.replaceChildren();
    const frag = document.createDocumentFragment();
    // Heaviest first, so tabbing starts somewhere meaningful.
    for (const a of [...artists].sort((x, y) => y.plays - x.plays)) {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.setAttribute("aria-pressed", "false");
      btn.textContent = `${a.name}, ${playsLabel(a)}${groupPhrase(a)}`;
      btn.addEventListener("focus", () => {
        focused = a;
        flyToArtist(a);
        draw();
      });
      btn.addEventListener("blur", () => {
        if (focused === a) {
          focused = null;
          draw();
        }
      });
      btn.addEventListener("click", (event) => {
        // A click with no coordinates came from Enter/Space, i.e. a keyboard
        // user: move them into the panel rather than leaving them stranded
        // partway down a three-hundred-item list.
        select(a, { fly: true, takeFocus: event.detail === 0 });
      });
      a11yButtons.set(a.id, btn);
      li.append(btn);
      frag.append(li);
    }
    a11yList.append(frag);
  }

  /**
   * A group is named either after a tag ("french") or, before tags land,
   * after the artist at its heart ("around L'Impératrice") — which needs a
   * different sentence around it to read as English.
   */
  function groupPhrase(a: Artist) {
    const label = a.cluster >= 0 && clusters[a.cluster]
      ? clusters[a.cluster].label
      : "";
    if (!label) return ", not close to any group";
    return label.startsWith("around ")
      ? `, in the group ${label}`
      : `, in the ${label} group`;
  }

  /**
   * Group names only exist once clustering has run, and in the timeline both
   * the play counts and who is even here change with the year — so the
   * keyboard route is rewritten rather than written once. An artist the
   * account wasn't playing in the selected year leaves the route entirely
   * (TE-REQ-34) rather than sitting in it as a silent zero.
   */
  function rebuildA11yLabels() {
    for (const [id, btn] of a11yButtons) {
      const a = byId.get(id);
      if (!a) continue;
      btn.textContent = `${a.name}, ${playsLabel(a)}${groupPhrase(a)}`;
      const item = btn.parentElement;
      if (item) item.hidden = a.r <= 0;
    }
  }

  function syncA11y() {
    for (const [id, btn] of a11yButtons) {
      btn.setAttribute(
        "aria-pressed",
        selected && selected.id === id ? "true" : "false",
      );
    }
  }

  /* ── search (REQ-19) ────────────────────────────────────────────── */

  const search = $<HTMLInputElement>("search");
  const results = $<HTMLUListElement>("results");
  let cursor = -1;
  let shown: Artist[] = [];

  function closeResults() {
    results.hidden = true;
    results.replaceChildren();
    search.setAttribute("aria-expanded", "false");
    cursor = -1;
    shown = [];
  }

  function runSearch() {
    const q = fold(search.value.trim());
    if (!q) {
      matches = null;
      closeResults();
      draw();
      return;
    }
    const found = artists
      .filter((a) => fold(a.name).includes(q))
      .sort((a, b) => {
        const ax = fold(a.name).startsWith(q) ? 0 : 1;
        const bx = fold(b.name).startsWith(q) ? 0 : 1;
        return ax - bx || b.plays - a.plays;
      });

    matches = new Set(found.map((a) => a.id));
    shown = found.slice(0, 8);
    cursor = -1;

    results.replaceChildren();
    if (!found.length) {
      const li = el("li", "finder__empty", "No artist here by that name.");
      li.setAttribute("role", "presentation");
      results.append(li);
    } else {
      shown.forEach((a, i) => {
        const li = el("li", "finder__result");
        li.id = `result-${i}`;
        li.setAttribute("role", "option");
        li.setAttribute("aria-selected", "false");
        const dot = el("span", "finder__dot");
        dot.style.background = colorOf(a);
        dot.setAttribute("aria-hidden", "true");
        li.append(dot, el("span", "finder__name", a.name));
        li.append(el("span", "finder__plays", playsLabel(a)));
        li.addEventListener("mousedown", (ev) => {
          ev.preventDefault();
          pick(a);
        });
        results.append(li);
      });
    }
    results.hidden = false;
    search.setAttribute("aria-expanded", "true");
    draw();
  }

  function highlightResult(next: number) {
    if (!shown.length) return;
    cursor = (next + shown.length) % shown.length;
    [...results.children].forEach((child, i) => {
      const on = i === cursor;
      child.setAttribute("aria-selected", on ? "true" : "false");
      child.classList.toggle("is-active", on);
    });
    search.setAttribute("aria-activedescendant", `result-${cursor}`);
  }

  function pick(a: Artist) {
    matches = null;
    search.value = "";
    closeResults();
    selected = null;
    select(a, { fly: true });
  }

  search.addEventListener("input", runSearch, { signal });
  search.addEventListener("focus", () => {
    if (search.value.trim()) runSearch();
  }, { signal });
  search.addEventListener("blur", () => window.setTimeout(closeResults, 120), { signal });
  search.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      highlightResult(cursor + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      highlightResult(cursor - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const target = shown[cursor >= 0 ? cursor : 0];
      if (target) pick(target);
    } else if (e.key === "Escape") {
      search.value = "";
      matches = null;
      closeResults();
      draw();
    }
  }, { signal });

  /* ── zoom / reset controls (REQ-17, REQ-18) ─────────────────────── */

  $<HTMLButtonElement>("zoom-in").addEventListener(
    "click",
    () => zoomAbout(width / 2, height / 2, 1.45),
    { signal },
  );
  $<HTMLButtonElement>("zoom-out").addEventListener(
    "click",
    () => zoomAbout(width / 2, height / 2, 1 / 1.45),
    { signal },
  );
  $<HTMLButtonElement>("reset").addEventListener("click", () => {
    matches = null;
    search.value = "";
    closeResults();
    resetView();
  }, { signal });

  window.addEventListener("keydown", (e) => {
    const inField =
      e.target instanceof HTMLElement &&
      (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA");
    if (e.key === "Escape") {
      if (selected || selectedFrontier) deselect();
      return;
    }
    if (inField || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "+" || e.key === "=") zoomAbout(width / 2, height / 2, 1.45);
    else if (e.key === "-" || e.key === "_")
      zoomAbout(width / 2, height / 2, 1 / 1.45);
    else if (e.key === "0") resetView();
    else if (e.key === "/") {
      e.preventDefault();
      search.focus();
    }
  }, { signal });

  /* ── legend (OQ-4/OQ-8) ─────────────────────────────────────────── */

  const legend = $<HTMLDivElement>("legend");
  const legendToggle = $<HTMLButtonElement>("legend-toggle");
  const legendBody = $<HTMLDivElement>("legend-body");
  const legendList = $<HTMLUListElement>("legend-list");
  let legendWired = false;
  const legendButtons = new Map<number, HTMLButtonElement>();

  /** Which legend entry reads as the region currently being explored. */
  function syncLegendState() {
    for (const [id, btn] of legendButtons) {
      const on = focusCluster !== null && focusCluster.id === id;
      btn.classList.toggle("is-on", on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    }
  }

  function renderLegend() {
    if (!clusters.length) return;
    legend.hidden = false;
    legendList.replaceChildren();
    legendButtons.clear();
    for (const c of clusters) {
      const li = el("li", "legend__item");
      const btn = el("button", "legend__btn");
      btn.type = "button";
      const dot = el("span", "legend__dot");
      dot.style.background = c.color;
      dot.setAttribute("aria-hidden", "true");
      btn.append(dot, el("span", "legend__label", c.label));
      btn.append(el("span", "legend__count", String(c.size)));
      btn.title = `${c.size} artists, anchored by ${c.anchor}`;
      btn.setAttribute("aria-pressed", "false");
      btn.setAttribute(
        "aria-label",
        `Explore the ${c.label} region — ${c.size} artists, most played is ` +
          `${c.anchor}. Frames this part of the map and finds the artists just beyond it.`,
      );
      // EXP-REQ-1 — the legend is the way into a region. These are ordinary
      // buttons, so Enter and Space do exactly what a click does.
      btn.addEventListener("click", () => {
        enterCluster(focusCluster && focusCluster.id === c.id ? null : c);
      });
      legendButtons.set(c.id, btn);
      li.append(btn);
      legendList.append(li);
    }
    syncLegendState();

    if (legendWired) return;
    legendWired = true;
    if (window.matchMedia("(min-width: 60rem)").matches) {
      legendToggle.setAttribute("aria-expanded", "true");
      legendBody.hidden = false;
    }
    legendToggle.addEventListener("click", () => {
      const open = legendToggle.getAttribute("aria-expanded") === "true";
      legendToggle.setAttribute("aria-expanded", open ? "false" : "true");
      legendBody.hidden = open;
    }, { signal });
  }

  /* ── Cluster Focus and the Frontier (EXP-REQ-1…7) ───────────────── */

  /**
   * Who counts as "in the Galaxy" — the artist set currently on screen,
   * nothing more. An artist missing from it has not been proven unheard;
   * it is simply not part of this map (§3).
   */
  const galaxy = galaxyIndex(artists);
  const clusterPanel = $<HTMLElement>("cluster-panel");
  const totalPlays = artists.reduce((sum, a) => sum + a.plays, 0);
  /** Outside artists visited during this exploration session (§3). */
  const explored = new Set<string>();
  const frontierImages = new Map<string, HTMLImageElement>();
  /** Bumped whenever the focused region changes; stale work checks it. */
  let frontierToken = 0;

  const membersOf = (c: Cluster) => artists.filter((a) => a.cluster === c.id);

  /** Where a region sits and how far it reaches, in map coordinates. */
  function regionOf(members: Artist[]) {
    let cx = 0;
    let cy = 0;
    for (const m of members) {
      cx += m.x;
      cy += m.y;
    }
    const n = members.length || 1;
    cx /= n;
    cy /= n;
    let radius = 1;
    for (const m of members) {
      radius = Math.max(radius, Math.hypot(m.x - cx, m.y - cy) + m.r);
    }
    return { centre: { x: cx, y: cy }, radius };
  }

  /**
   * Frontier bubbles are all one size, and that size means nothing.
   * On the map a radius is a play count; an outside artist has no play
   * count here, so giving it a size derived from anything else would be a
   * second meaning for the same visual channel (EXP-REQ-11).
   */
  function frontierRadius(members: Artist[]) {
    const sorted = members.map((m) => m.r).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] || 16;
    return clamp(median * 0.62, 9, 26);
  }

  /**
   * EXP-REQ-1 — focus one region: frame it, dim the rest of the Galaxy,
   * open its panel, and go looking for what lies just beyond it. Nothing
   * moves: these are the Galaxy's own coordinates, zoomed into
   * (EXP-REQ-3/PRINCIPLE-4).
   */
  function enterCluster(c: Cluster | null) {
    frontierToken++;
    frontier = [];
    hoveredFrontier = null;
    selectedFrontier = null;
    const changed = focusCluster !== c;
    focusCluster = c;
    syncLegendState();

    if (!c) {
      clusterPanel.hidden = true;
      clusterPanel.replaceChildren();
      draw();
      if (changed) resetView();
      return;
    }

    deselect();
    const members = membersOf(c);
    if (!members.length) return;
    const region = regionOf(members);
    // The visitor has said where they want to be; the map stops re-framing
    // itself on the whole Galaxy behind their back.
    following = false;
    const margin = region.radius * 1.9;
    flyTo(
      region.centre.x,
      region.centre.y,
      clamp(
        Math.min(width, height) / (margin * 2),
        fitScale * 0.5,
        fitScale * 12,
      ),
    );
    renderClusterPanel(c, members);
    draw();
    announce(
      `Focused on the ${c.label} group: ${plural(members.length, "artist")}. ` +
        "Looking for artists just beyond it.",
    );
    void loadFrontier(c, members, region);
  }

  /**
   * The region's frontier.
   *
   * EXP-REQ-21 — every one of these similarity lists was already fetched to
   * build the Galaxy, so this normally costs no network at all: the shared
   * cache answers, and what looks like a fan-out is a handful of reads.
   */
  async function loadFrontier(
    c: Cluster,
    members: Artist[],
    region: { centre: Point; radius: number },
  ) {
    const token = ++frontierToken;
    const lists = new Map<number, api.SimilarArtist[]>();
    await Promise.all(
      members.map(async (m) => {
        const list = await api.similar(m.name).catch(() => []);
        lists.set(m.id, list);
      }),
    );
    if (dead || token !== frontierToken || focusCluster !== c) return;

    const candidates = aggregateFrontier(members, lists, galaxy).slice(
      0,
      FRONTIER_LIMIT,
    );
    const r = frontierRadius(members);
    const positions = placeFrontier(
      candidates,
      new Map(members.map((m) => [m.id, { x: m.x, y: m.y }])),
      {
        centre: region.centre,
        radius: region.radius,
        gap: r * 2.8,
        spacing: r * 2.6,
      },
    );
    frontier = candidates.map((candidate, i) => ({
      candidate,
      x: positions[i].x,
      y: positions[i].y,
      r,
      image: "",
    }));
    renderClusterPanel(c, members);
    draw();
    announce(
      frontier.length
        ? `${plural(frontier.length, "artist")} found just beyond the ${c.label} group.`
        : `No artists beyond the ${c.label} group that aren't already on this map.`,
    );
    void loadFrontierArt(token);
  }

  /**
   * EXP-REQ-20 / §13 — artwork is fetched for the frontier that is actually
   * on screen, and for nobody else. A node without a picture is a perfectly
   * good node; the similarity is the part that carries the meaning.
   */
  async function loadFrontierArt(token: number) {
    if (saveData) return;
    await Promise.all(
      frontier.map(async (node) => {
        const key = norm(node.candidate.name);
        if (frontierImages.has(key)) return;
        const url = await api.artwork(node.candidate.name).catch(() => "");
        if (dead || token !== frontierToken || !url) return;
        node.image = url;
        const img = new Image();
        img.decoding = "async";
        img.referrerPolicy = "no-referrer";
        img.onload = () => {
          if (dead || token !== frontierToken || !img.naturalWidth) return;
          frontierImages.set(key, img);
          draw();
        };
        // A missing picture is never a failure worth reporting (§22).
        img.onerror = () => {};
        img.src = sized(url, THUMB_PX);
      }),
    );
  }

  /** EXP-REQ-2 — what this region is, and what is beyond it. */
  function renderClusterPanel(c: Cluster, members: Artist[]) {
    clusterPanel.replaceChildren();
    clusterPanel.hidden = false;

    const close = el("button", "detail__close", "✕");
    close.type = "button";
    close.setAttribute("aria-label", "Leave this region and show the whole Galaxy");
    close.addEventListener("click", () => {
      enterCluster(null);
      legendButtons.get(c.id)?.focus();
    });

    const head = el("p", "cluster__kicker", "Explore this region");
    const title = el("h2", "cluster__title", c.label);
    const swatch = el("span", "cluster__swatch");
    swatch.style.background = c.color;
    swatch.setAttribute("aria-hidden", "true");
    title.prepend(swatch);

    const share = totalPlays
      ? ` · ${Math.round((c.plays / totalPlays) * 100)}% of this Galaxy`
      : "";
    const facts = el(
      "p",
      "cluster__facts",
      `${plural(members.length, "artist")}${share}`,
    );

    const coreHead = el("p", "cluster__head", "Core artists");
    const core = el("ul", "cluster__core");
    for (const a of [...members].sort((x, y) => y.plays - x.plays).slice(0, 4)) {
      const li = el("li");
      const btn = el("button", "cluster__core-btn", a.name);
      btn.type = "button";
      btn.addEventListener("click", () => select(a, { fly: true }));
      li.append(btn);
      core.append(li);
    }

    const why = el(
      "p",
      "cluster__why",
      "This group emerged from the similarity data itself — nobody sorted " +
        "these artists into it, and its name is simply the tag most " +
        "distinctive to whoever landed here.",
    );

    clusterPanel.append(close, head, title, facts, coreHead, core, why);

    const beyondHead = el("p", "cluster__head", "Beyond this region");
    clusterPanel.append(beyondHead);

    if (!frontier.length) {
      clusterPanel.append(
        el(
          "p",
          "cluster__why",
          frontierToken > 0 && focusCluster === c
            ? "Looking for artists just outside your Galaxy…"
            : "Nothing found just outside your Galaxy from here.",
        ),
      );
      return;
    }

    clusterPanel.append(
      el(
        "p",
        "cluster__facts",
        `${plural(frontier.length, "nearby artist")} outside your current Galaxy`,
      ),
    );

    // The same nodes as a list — which is what makes them keyboard
    // reachable and touch-friendly, and where the "why is this here"
    // answer lives in text rather than in a line on a canvas (§21).
    const list = el("ul", "cluster__frontier");
    for (const node of frontier) {
      const li = el("li");
      const btn = el("button", "frontier-item");
      btn.type = "button";
      btn.append(el("span", "frontier-item__name", node.candidate.name));
      btn.append(
        el(
          "span",
          "frontier-item__support",
          `${node.candidate.supportCount} link${
            node.candidate.supportCount === 1 ? "" : "s"
          }`,
        ),
      );
      btn.setAttribute(
        "aria-label",
        `${node.candidate.name}, beyond your Galaxy, connected to ` +
          `${plural(node.candidate.supportCount, "artist")} in this region — show why`,
      );
      btn.addEventListener("click", () => {
        selectFrontier(node, { fly: true });
      });
      li.append(btn);
      list.append(li);
    }
    clusterPanel.append(list);
  }

  /** EXP-REQ-7 — the links back into the region, on demand. */
  function selectFrontier(node: FrontierNode, { fly = false } = {}) {
    if (selectedFrontier === node) {
      deselect();
      return;
    }
    deselect();
    selectedFrontier = node;
    renderFrontierDetail(node);
    if (fly) {
      flyTo(node.x, node.y, Math.max(view.scale, fitScale * 1.2));
    }
    draw();
  }

  /**
   * §12 — what an artist beyond the Galaxy gets to say about itself.
   *
   * Never a play count, and never "0 plays": this map does not know what
   * this account has listened to outside its own top artists, so the only
   * honest claim is the one about similarity.
   */
  function renderFrontierDetail(node: FrontierNode) {
    const { candidate } = node;
    detail.replaceChildren();
    detail.hidden = false;
    stage.dataset.detail = "true";

    const close = el("button", "detail__close", "✕");
    close.type = "button";
    close.setAttribute("aria-label", "Close artist details");
    close.addEventListener("click", () => deselect());

    const art = el(
      "div",
      "detail__art detail__art--frontier" + (node.image ? "" : " detail__art--empty"),
    );
    if (node.image) art.style.backgroundImage = `url("${sized(node.image, DETAIL_PX)}")`;
    else art.textContent = "♪";

    const body = el("div", "detail__body");
    const visited = explored.has(norm(candidate.name));

    const kicker = el("p", "detail__kicker detail__kicker--frontier");
    const ring = el("span", "detail__swatch detail__swatch--frontier");
    ring.setAttribute("aria-hidden", "true");
    kicker.append(
      ring,
      document.createTextNode(
        visited ? "Beyond your Galaxy · explored on this trail" : "Beyond your Galaxy",
      ),
    );

    body.append(kicker, el("h2", "detail__title", candidate.name));
    body.append(
      el(
        "p",
        "detail__plays",
        `Connected to ${plural(candidate.supportCount, "artist")} in this region`,
      ),
    );

    const link = el("p", "detail__links");
    const anchor = el("a", undefined, "Last.fm page ↗");
    anchor.href = lastFmArtistUrl(candidate.name);
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    link.append(anchor);
    body.append(link);

    if (options.onExplore) {
      const explore = el("button", "detail__explore", "Explore this artist →");
      explore.type = "button";
      explore.title = `Open the artists around ${candidate.name}`;
      explore.addEventListener("click", () => options.onExplore!(candidate.name));
      body.append(explore);
    }

    body.append(el("p", "detail__near-head", "Strongest links"));
    const list = el("ul", "detail__near");
    for (const l of candidate.links.slice(0, 5)) {
      const other = byId.get(l.artistId);
      if (!other) continue;
      const li = el("li");
      const btn = el("button", "near");
      btn.type = "button";
      const bar = el("span", "near__bar");
      bar.setAttribute("aria-hidden", "true");
      const fill = el("span", "near__fill");
      fill.style.width = `${Math.round(clamp(l.match, 0.04, 1) * 100)}%`;
      fill.style.background = colorOf(other);
      bar.append(fill);
      btn.append(
        el("span", "near__name", other.name),
        bar,
        el("span", "near__score", `${Math.round(l.match * 100)}%`),
      );
      btn.setAttribute(
        "aria-label",
        `${other.name}, in your Galaxy, similarity ${Math.round(l.match * 100)} per cent — show on the map`,
      );
      btn.addEventListener("click", () => select(other, { fly: true }));
      li.append(btn);
      list.append(li);
    }
    body.append(list);
    body.append(
      el(
        "p",
        "detail__why",
        "This artist is not on your map. It is here because the artists " +
          "above it — which are — point at it in Last.fm's similarity data.",
      ),
    );

    detail.append(close, art, body);
    detail.scrollTop = 0;
    announce(
      `${candidate.name}, beyond your Galaxy, connected to ` +
        `${plural(candidate.supportCount, "artist")} in this region.`,
    );
  }

  /* ── caption + method note (REQ-3) ──────────────────────────────── */

  const captionScope = $<HTMLParagraphElement>("caption-scope");
  const captionState = $<HTMLSpanElement>("caption-asof");
  captionScope.textContent = meta.description;
  $<HTMLElement>("about-scope").textContent = meta.description;
  $<HTMLElement>("about-fresh").textContent =
    "It is built from Last.fm the moment you open the page, so it is as " +
    "current as your scrobbles are. Nothing is precomputed and there is no " +
    "server in between — your browser does the fetching and the layout. " +
    "What it has already looked up is kept in this browser, so coming back " +
    "is close to instant.";

  const profile = $<HTMLAnchorElement>("about-profile");
  profile.href = meta.profileUrl;
  profile.textContent = `${meta.user} on Last.fm ↗`;

  // A shared link should say whose map it opens.
  document.title = `${meta.user}'s listening map · Groove Galaxy`;

  /** The live status line: what the map is still waiting for. */
  function setStatus(text: string) {
    captionState.textContent = text;
  }
  setStatus(`Reading ${meta.user}'s listening history…`);

  const aboutToggle = $<HTMLButtonElement>("about-toggle");
  const about = $<HTMLElement>("about");
  aboutToggle.addEventListener("click", () => {
    const open = aboutToggle.getAttribute("aria-expanded") === "true";
    aboutToggle.setAttribute("aria-expanded", open ? "false" : "true");
    about.hidden = open;
    if (!open) about.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, { signal });

  /* ── settling ────────────────────────────────────────────────────
     While the layout is still moving the map re-frames itself, so the
     visitor watches it organise rather than watching it wander off the
     edge. The moment they touch it, it is theirs and it stops.          */

  let following = true;
  let settling = false;
  /** Set once the timeline takes over positions; the simulation stops. */
  let frozen = false;
  const settledCallbacks: (() => void)[] = [];

  function stopFollowing() {
    following = false;
  }
  canvas.addEventListener("pointerdown", stopFollowing, { signal });
  canvas.addEventListener("wheel", stopFollowing, { passive: true, signal });

  function settleFrame() {
    if (!settling || dead) return;
    layout.step(LAYOUT_BUDGET_MS);
    layout.centre();
    syncPositions();
    measure();
    computeHome();
    if (following) {
      view.cx = home.cx;
      view.cy = home.cy;
      view.scale = home.scale;
    }
    draw();
    if (layout.settled) {
      settling = false;
      reprioritise();
      // §20 — the reference layout is now the timeline's fixed geography.
      const waiting = settledCallbacks.splice(0);
      for (const fn of waiting) fn();
    } else {
      requestAnimationFrame(settleFrame);
    }
  }

  function nudge() {
    if (settling || frozen || dead) return;
    settling = true;
    requestAnimationFrame(settleFrame);
  }

  /* ── what start() feeds in as the build progresses ───────────────── */

  const view_: MapView = {
    setEdges(edges, done, total) {
      // Re-seed from the graph's own shape the first time it is worth it:
      // MDS gives the global arrangement that the force pass then refines.
      if (!seeded && done >= total) {
        seeded = true;
        const adj = adjacency(artists.length, edges);
        layout.reset(mdsSeed(artists.length, adj), radii);
      }
      layout.setEdges(edges);
      nudge();
      setStatus(
        done < total
          ? `Placing artists — ${done} of ${total}`
          : "Settling…",
      );
    },

    setClusters(next) {
      clusters = next;
      // The groups are the same groups — only their names improved — so a
      // focused region stays focused rather than snapping back out.
      if (focusCluster) {
        focusCluster = clusters[focusCluster.id] ?? null;
        if (focusCluster) renderClusterPanel(focusCluster, membersOf(focusCluster));
      }
      renderLegend();
      if (selected) renderDetail(selected);
      rebuildA11yLabels();
      draw();
    },

    refreshArtist(id) {
      const a = byId.get(id);
      if (a && a.image) enqueue(a, false);
      if (selected && selected.id === id) renderDetail(selected);
      draw();
    },

    finish() {
      const cached = cache.summary();
      setStatus(
        `Live from Last.fm · ${artists.length} artists` +
          (cached ? ` · ${cached}` : ""),
      );
      nudge();
    },

    get count() {
      return artists.length;
    },

    get selection() {
      return selected;
    },

    /* ── exploration hooks (EXP §5, §14) ──────────────────────────── */

    focusCluster(id) {
      enterCluster(id === null ? null : (clusters[id] ?? null));
    },

    get clusterFocus() {
      return focusCluster;
    },

    get galaxyArtists() {
      return artists;
    },

    get galaxyClusters() {
      return clusters;
    },

    /**
     * An exploration overlay has the stage. The map is left exactly as it
     * is — same region focused, same viewport — because that is what it
     * has to be when the visitor comes back (EXP-REQ-19).
     */
    setDormant(on) {
      if (dormant === on) return;
      dormant = on;
      if (on) {
        setHover(null);
        setFrontierHover(null);
        stopAnimation();
      } else {
        draw();
      }
    },

    markExplored(name) {
      explored.add(norm(name));
      if (selectedFrontier) renderFrontierDetail(selectedFrontier);
      draw();
    },

    redraw: draw,

    remeasure() {
      measure();
      computeHome();
      draw();
    },

    refit() {
      if (!following) return;
      view.cx = home.cx;
      view.cy = home.cy;
      view.scale = home.scale;
      draw();
      reprioritise();
    },

    onSettled(fn) {
      if (layout.settled && !settling) fn();
      else settledCallbacks.push(fn);
    },

    basePositions() {
      return layout.pos.map((p) => ({ x: p.x, y: p.y }));
    },

    stopLayout() {
      frozen = true;
      settling = false;
    },

    refreshDetail() {
      if (selected) renderDetail(selected);
      rebuildA11yLabels();
    },

    setCaptionScope(text) {
      captionScope.textContent = text;
      $<HTMLElement>("about-scope").textContent = text;
    },

    setStatus,

    /**
     * Everything this map holds on to, released — so switching period or
     * entering the timeline replaces the map rather than layering a second
     * one on top of the same buttons.
     */
    destroy() {
      dead = true;
      frozen = true;
      settling = false;
      life.abort();
      observer.disconnect();
      stopAnimation();
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
      queue = [];
      queued.clear();
      images.clear();
      a11yButtons.clear();
      matches = null;
      frontier = [];
      frontierImages.clear();
      legendButtons.clear();
      if (owner !== mine) return; // a successor already owns the page
      clusterPanel.hidden = true;
      clusterPanel.replaceChildren();
      delete stage.dataset.detail;
      a11yList.replaceChildren();
      detail.hidden = true;
      detail.replaceChildren();
      legend.hidden = true;
      legendList.replaceChildren();
      tip.hidden = true;
      search.value = "";
      closeResults();
    },
  };
  let seeded = false;

  /* ── go ─────────────────────────────────────────────────────────── */

  const observer = new ResizeObserver(resize);
  observer.observe(stage);
  window.addEventListener(
    "orientationchange",
    () => window.setTimeout(resize, 200),
    { signal },
  );

  resize();
  stage.dataset.state = "ready";
  veil.hidden = true;
  canvas.style.cursor = "grab";
  nudge();

  return view_;
}
