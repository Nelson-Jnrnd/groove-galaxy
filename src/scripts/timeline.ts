/**
 * Taste Evolution — the same galaxy, year by year.
 *
 * This is the controller: it reads the account's weekly charts through
 * lib/history.ts, turns them into a temporal model through lib/temporal.ts,
 * builds **one** reference graph and layout, and then does nothing to the map
 * except change how big each bubble is and how solid it looks. Moving
 * through time never re-clusters, never re-lays-out and never asks Last.fm
 * who sounds like whom again (TE-REQ-7/8, TE-REQ-28) — because none of those
 * things is what changed. What changed is the listening.
 *
 * Everything spatial belongs to the reference layout, so the region where
 * somebody's electronic music lives stays where it was in 2019, empties out
 * in 2021 and fills again in 2024 (TP-PRINCIPLE-2, §27).
 */
import {
  attachNeighbours,
  enrich,
  gatherSimilarity,
  group,
  prune,
  type Artist,
  type BuildMeta,
  type Cluster,
} from "../lib/build.ts";
import * as cache from "../lib/cache.ts";
import { loadHistory, type TemporalFrame } from "../lib/history.ts";
import * as api from "../lib/lastfm.ts";
import { adjacency, type Point } from "../lib/layout.ts";
import {
  buildStates,
  buildUniverse,
  clusterStats,
  frameMax,
  frameCeiling,
  playScale,
  radiusIn,
  referenceRadius,
  relax,
  summarise,
  type TemporalArtist,
} from "../lib/temporal.ts";
import { announce, type BootOptions, type MapView } from "./map.ts";
import type { ViewState } from "../lib/viewstate.ts";

/* ─── cadence (§30) ──────────────────────────────────────────────────── */

/** Long enough to watch a bubble change, short enough to stay a sentence. */
const TRANSITION_MS = 750;
/** …and the pause on the year itself before moving on. */
const HOLD_MS = 1100;
/** §44 — how far a bubble may be nudged from its reference position. */
const MAX_OFFSET = 24;

const $ = <T extends HTMLElement>(id: string): T | null =>
  document.getElementById(id) as T | null;

const clamp = (v: number, lo: number, hi: number) =>
  v < lo ? lo : v > hi ? hi : v;

const plural = (n: number, one: string, many = one + "s") =>
  `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

const reducedMotion = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export interface TimelineHost {
  stage: HTMLDivElement;
  canvas: HTMLCanvasElement;
  veil: HTMLDivElement;
  state: ViewState;
  /** True once the visitor has moved on and this timeline is history. */
  stale: () => boolean;
  boot: (
    artists: Artist[],
    meta: BuildMeta,
    options: BootOptions,
  ) => MapView;
  adopt: (view: MapView, frame: string) => void;
  onFrame: (frame: string) => void;
  onExit: () => void;
  onError: (err: unknown) => void;
}

export async function startTimeline(host: TimelineHost): Promise<void> {
  const { state, stale } = host;
  const bar = $<HTMLDivElement>("timeline");
  const frameList = $<HTMLUListElement>("timeline-frames");
  const summaryEl = $<HTMLDivElement>("timeline-summary");
  const playBtn = $<HTMLButtonElement>("timeline-play");
  const prevBtn = $<HTMLButtonElement>("timeline-prev");
  const nextBtn = $<HTMLButtonElement>("timeline-next");
  const exitBtn = $<HTMLButtonElement>("timeline-exit");
  const status = $<HTMLParagraphElement>("timeline-status");
  const veilText = $<HTMLParagraphElement>("veil-text");
  const veilSub = $<HTMLParagraphElement>("veil-sub");

  /** Everything this timeline listens to, dropped when it is replaced. */
  const life = new AbortController();
  const signal = life.signal;
  let torn = false;

  // Declared up here because the shell, and therefore `teardown`, exists
  // before any of the data does: a first request that fails must still be
  // able to take the timeline back off the screen.
  const buttons = new Map<string, HTMLButtonElement>();
  let transition = 0;
  let playing = false;
  let timer = 0;

  function teardown() {
    torn = true;
    stopPlayback();
    if (transition) cancelAnimationFrame(transition);
    life.abort();
    if (bar) bar.hidden = true;
    if (frameList) frameList.replaceChildren();
    if (summaryEl) summaryEl.replaceChildren();
  }

  const gone = () => torn || stale();

  // §34.3 — the shell appears at once, so nobody is left looking at a blank
  // canvas wondering whether anything is happening.
  if (bar) bar.hidden = false;
  if (status) status.textContent = "Reading the weekly charts…";
  if (veilText) veilText.textContent = "Reading years of weekly charts…";
  if (veilSub) {
    veilSub.hidden = false;
    veilSub.textContent =
      "Last.fm keeps one chart per week. They are being read back and added " +
      "up into years — the first visit is the slow one; after that they are " +
      "kept in this browser.";
  }

  exitBtn?.addEventListener("click", () => host.onExit(), { signal });

  /* ── 1. the history itself ─────────────────────────────────────────── */

  let frames: Map<string, TemporalFrame>;
  try {
    frames = await loadHistory(state.user, {
      selected: state.frame || undefined,
      cancelled: gone,
      events: {
        onFrames(ids) {
          if (gone()) return;
          renderFrameButtons(ids);
        },
        onFrame(frame, loaded, total) {
          if (gone()) return;
          if (status) {
            status.textContent = `Reading ${frame.label} — ${loaded} of ${total} years`;
          }
        },
      },
    });
  } catch (err) {
    if (!gone()) {
      teardown();
      host.onError(err);
    }
    return;
  }
  if (gone()) return;

  // §42 — Last.fm hands back a chart for every week since the account was
  // created, including the years before it was used. Those are not frames of
  // anybody's listening history, so the timeline starts where the listening
  // does and ends where it stops; quiet years *inside* that span are real
  // and stay.
  const all = [...frames.values()];
  const first = all.findIndex((f) => f.totalPlays > 0);
  const last = all.findLastIndex((f) => f.totalPlays > 0);
  if (first === -1) {
    teardown();
    host.onError(new Error("no historical charts"));
    return;
  }
  const ordered = all.slice(first, last + 1);
  const withListening = ordered.filter((f) => f.totalPlays > 0);

  const ids = ordered.map((f) => f.id);
  renderFrameButtons(ids);

  let selected =
    state.frame && frames.has(state.frame)
      ? state.frame
      : withListening[withListening.length - 1].id;

  /* ── 2. one universe, one graph, one layout ────────────────────────── */

  if (status) status.textContent = "Working out who lives on this map…";
  const names = buildUniverse(ordered);
  const urls = new Map<string, string>();
  for (const frame of ordered) {
    for (const [name, url] of frame.urls) if (!urls.has(name)) urls.set(name, url);
  }

  const inUniverse = new Set(names);
  const totals = new Map<string, number>();
  for (const frame of ordered) {
    for (const [name, plays] of frame.artists) {
      if (inUniverse.has(name)) totals.set(name, (totals.get(name) || 0) + plays);
    }
  }
  const totalValues = names.map((n) => totals.get(n) || 1);
  const minTotal = Math.min(...totalValues);
  const maxTotal = Math.max(...totalValues);

  // The reference bubble sizes — range totals, used only to lay the map out.
  // Nothing on screen is ever drawn at these sizes; the frame decides that.
  const artists: Artist[] = names.map((name, i) => ({
    id: i,
    name,
    plays: totals.get(name) || 0,
    url: urls.get(name) || `https://www.last.fm/music/${encodeURIComponent(name)}`,
    image: "",
    tags: [],
    r: referenceRadius(totals.get(name) || 1, minTotal, maxTotal),
    cluster: -1,
    similar: [],
    x: 0,
    y: 0,
    alpha: 1,
  }));

  const table = buildStates(artists, ordered);
  const scale = playScale(table, ordered);

  if (status) status.textContent = "Reading who sounds like whom…";
  const pairs = await gatherSimilarity(artists, (done, total) => {
    if (!gone() && status) {
      status.textContent = `Reading who sounds like whom — ${done} of ${total}`;
    }
  });
  if (gone()) return;

  const edges = prune(artists, pairs);
  attachNeighbours(artists, pairs);
  const clusters: Cluster[] = group(artists, adjacency(artists.length, edges));

  /* ── 3. the map, driven by frames rather than by a simulation ──────── */

  const meta: BuildMeta = {
    user: state.user,
    period: state.period,
    profileUrl: api.profileUrl(state.user),
    totalScrobbledArtists: 0,
    description: "",
  };

  const inner = host.boot(artists, meta, {
    playsLabel: (a) => {
      const plays = table.get(a.id)?.states.get(selected)?.plays || 0;
      const label = frames.get(selected)?.label || selected;
      return `${plural(plays, "play")} · ${label}`;
    },
    // The year's own rank is in the temporal block below; ranking by the
    // whole range's totals here would just disagree with it.
    rankLine: () => null,
    detailExtra: (a) => temporalPanel(a),
    // TE-REQ-16 — opening an artist stops the years moving underneath it.
    onSelect: (a) => {
      if (a) stopPlayback();
    },
    externalPositions: true,
  });

  /**
   * The controller owns the timeline bar, so tearing the map down has to
   * take the bar with it. Everything else is the map's own.
   */
  const view: MapView = Object.create(inner, {
    destroy: {
      value: () => {
        teardown();
        inner.destroy();
      },
    },
  });

  view.setClusters(clusters);
  view.setEdges(edges, artists.length, artists.length);
  host.adopt(view, selected);

  /** The stable geography every frame is drawn on (§20). */
  let base: Point[] = artists.map((a) => ({ x: a.x, y: a.y }));
  const working: Point[] = base.map((p) => ({ ...p }));
  let ready = false;

  view.onSettled(() => {
    if (gone()) return;
    base = view.basePositions();
    view.stopLayout();
    ready = true;
    show(selected, { animate: false });
    setPlayEnabled(true);
    // Artwork, tags and better cluster names, once the map is usable.
    void enrich(artists, clusters, {
      onArtists: () => {},
      onEdges: () => {},
      onClusters: () => {},
      onEnriched: (artist) => {
        if (!gone()) view.refreshArtist(artist.id);
      },
      onLabels: (next) => {
        if (!gone()) {
          view.setClusters(next);
          show(selected, { animate: false });
        }
      },
    });
    void cache.sweep();
  });

  /* ── frames on screen ──────────────────────────────────────────────── */

  function renderFrameButtons(list: string[]) {
    if (!frameList) return;
    frameList.replaceChildren();
    buttons.clear();
    for (const id of list) {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "timeline__frame";
      btn.textContent = id;
      // TE-REQ-31 — which year is showing is a fact, not a colour.
      btn.setAttribute("aria-pressed", "false");
      btn.addEventListener("click", () => {
        stopPlayback();
        show(id, { animate: true, user: true });
      }, { signal });
      buttons.set(id, btn);
      li.append(btn);
      frameList.append(li);
    }
  }

  function syncFrameButtons(id: string) {
    for (const [value, btn] of buttons) {
      const on = value === id;
      btn.setAttribute("aria-pressed", on ? "true" : "false");
      btn.classList.toggle("is-on", on);
      if (on) btn.scrollIntoView({ block: "nearest", inline: "center" });
    }
  }

  let fromRadii = artists.map(() => 0);
  let fromAlpha = artists.map(() => 0);

  /**
   * Move to a frame.
   *
   * Only two numbers per artist change: radius and opacity. Positions come
   * from the reference layout plus a bounded nudge so that changing sizes
   * don't leave bubbles sitting on top of each other (§44).
   */
  function show(
    id: string,
    { animate = true, user = false }: { animate?: boolean; user?: boolean } = {},
  ) {
    if (!frames.has(id) || gone()) return;
    const previous = selected;
    selected = id;
    syncFrameButtons(id);
    host.onFrame(id);

    const frame = frames.get(id)!;
    const ceiling = frameCeiling(scale, frameMax(table, id));
    const targetRadii = artists.map((a) =>
      radiusIn(table.get(a.id)?.states.get(id)?.plays || 0, scale, ceiling),
    );
    const targetAlpha = targetRadii.map((r) => (r > 0 ? 1 : 0));

    if (transition) cancelAnimationFrame(transition);
    fromRadii = artists.map((a) => a.r);
    fromAlpha = artists.map((a) => a.alpha ?? 1);

    const apply = (t: number) => {
      for (let i = 0; i < artists.length; i++) {
        artists[i].r = fromRadii[i] + (targetRadii[i] - fromRadii[i]) * t;
        artists[i].alpha = fromAlpha[i] + (targetAlpha[i] - fromAlpha[i]) * t;
      }
      const positions = relax(
        base,
        artists.map((a) => a.r),
        { maxOffset: MAX_OFFSET, out: working },
      );
      for (let i = 0; i < artists.length; i++) {
        artists[i].x = positions[i].x;
        artists[i].y = positions[i].y;
      }
      view.remeasure();
      // The keyboard route and the open panel describe the year that has
      // actually arrived, so they are rewritten once it has — and a quiet
      // year that no longer fills the frame is re-framed, unless the visitor
      // has taken the view over themselves.
      if (t >= 1) {
        view.refreshDetail();
        view.refit();
      }
    };

    if (!animate || reducedMotion() || !ready) {
      // §31 — with reduced motion the year simply *is* the new year.
      apply(1);
    } else {
      const t0 = performance.now();
      const step = (now: number) => {
        if (gone()) return;
        const t = clamp((now - t0) / TRANSITION_MS, 0, 1);
        apply(t < 1 ? 1 - Math.pow(1 - t, 3) : 1);
        if (t < 1) transition = requestAnimationFrame(step);
        else transition = 0;
      };
      transition = requestAnimationFrame(step);
    }

    renderSummary(frame, previous === id ? null : previousOf(id));
    if (user || !playing) {
      // TE-REQ-33 — one concise update per year, not one per bubble.
      announce(
        `${frame.label} selected. ${plural(
          activeCount(id),
          "active artist",
        )}.`,
      );
    }
  }

  const previousOf = (id: string): string | null => {
    const at = ids.indexOf(id);
    return at > 0 ? ids[at - 1] : null;
  };

  const activeCount = (id: string) =>
    artists.filter((a) => (table.get(a.id)?.states.get(id)?.plays || 0) > 0)
      .length;

  /* ── the frame's own summary (§38) ─────────────────────────────────── */

  function renderSummary(frame: TemporalFrame, previous: string | null) {
    if (!summaryEl) return;
    const stats = clusterStats(artists, clusters, table, frame.id, previous);
    const summary = summarise(frame, table, stats, previous);
    summaryEl.replaceChildren();

    const line = (text: string, className = "timeline__fact") => {
      const p = document.createElement("p");
      p.className = className;
      p.textContent = text;
      summaryEl.append(p);
    };

    const head = document.createElement("p");
    head.className = "timeline__year";
    head.textContent = frame.label;
    summaryEl.append(head);

    if (summary.totalPlays === 0) {
      // §42 — an empty year is a fact about the account, not a broken frame.
      line(`Very little listening recorded in ${frame.label}.`);
      return;
    }

    line(
      `${plural(summary.totalPlays, "mapped play")} · ${plural(
        summary.activeArtists,
        "active artist",
      )}${summary.complete ? "" : " · partial"}`,
    );
    if (summary.topArtist) line(`Most played: ${summary.topArtist}`);
    if (summary.biggestRiser) {
      line(
        `Biggest rise: ${summary.biggestRiser.name} (${summary.biggestRiser.from} → ${summary.biggestRiser.to})`,
      );
    }
    if (summary.biggestFaller) {
      line(
        `Biggest fall: ${summary.biggestFaller.name} (${summary.biggestFaller.from} → ${summary.biggestFaller.to})`,
      );
    }
    if (summary.newThisFrame.length) {
      line(`First appears here: ${summary.newThisFrame.slice(0, 3).join(", ")}`);
    }
    if (summary.returning.length) {
      line(`Back again: ${summary.returning.slice(0, 3).join(", ")}`);
    }
    if (summary.dominantCluster) {
      const c = summary.dominantCluster;
      const before =
        c.previousShare === null
          ? ""
          : ` (${Math.round(c.previousShare * 100)}% → ${Math.round(c.share * 100)}%)`;
      line(
        `Largest group: ${c.label} · ${Math.round(c.share * 100)}% of listening${before}`,
      );
      // §45 — the group keeps its name; only its core changes year to year.
      if (c.core.length) line(`${frame.label} core: ${c.core.join(", ")}`, "timeline__fact timeline__fact--quiet");
    }
    if (!summary.complete) {
      line(
        `${plural(frame.missing, "week")} of ${frame.label} could not be read, so these totals are a floor rather than an exact count.`,
        "timeline__fact timeline__fact--quiet",
      );
    }

    view.setCaptionScope(
      `${state.user}'s Last.fm listening in ${frame.label}, reconstructed from ` +
        `Last.fm's weekly charts: ${plural(summary.activeArtists, "artist")} ` +
        `played that year, sized by plays in ${frame.label}. Positions are the ` +
        `same in every year — only the listening moves.`,
    );
    view.setStatus(
      `${frame.label} · ${plural(summary.totalPlays, "mapped play")}` +
        (summary.complete ? "" : " · partial year"),
    );
  }

  /* ── the artist panel, in a year (§37) ─────────────────────────────── */

  function temporalPanel(a: Artist): Node | null {
    const entry: TemporalArtist | undefined = table.get(a.id);
    if (!entry) return null;
    const frame = frames.get(selected);
    const state_ = entry.states.get(selected);
    const wrap = document.createElement("div");
    wrap.className = "detail__temporal";

    const add = (text: string, className = "detail__temporal-line") => {
      const p = document.createElement("p");
      p.className = className;
      p.textContent = text;
      wrap.append(p);
    };

    // TE-REQ-24 — which historical period this is, said plainly.
    add(frame?.label || selected, "detail__temporal-head");
    if (!state_ || !state_.active) {
      add(`Not played in ${frame?.label || selected}.`);
    } else {
      if (state_.rank) add(`#${state_.rank} artist this year on this map`);
      if (state_.share) {
        add(`${(state_.share * 100).toFixed(1)}% of mapped listening`);
      }
    }

    // TE-REQ-25 — no comparison at all when there is nothing to compare to.
    const previous = previousOf(selected);
    const before = previous ? entry.states.get(previous)?.plays || 0 : null;
    if (previous && before !== null && (before > 0 || state_?.plays)) {
      const now = state_?.plays || 0;
      add(`${frames.get(previous)?.label || previous}: ${plural(before, "play")}`);
      if (before > 0) {
        const change = Math.round(((now - before) / before) * 100);
        add(`Change: ${change >= 0 ? "+" : ""}${change}%`);
      }
    }
    if (entry.firstSeen) {
      // §39 — what the weekly charts can actually support, no more.
      add(`First chart appearance: ${frames.get(entry.firstSeen)?.label || entry.firstSeen}`);
    }
    return wrap;
  }

  /* ── moving through time (§29) ─────────────────────────────────────── */

  function stepFrame(delta: number, user = true) {
    const at = ids.indexOf(selected);
    const next = ids[clamp(at + delta, 0, ids.length - 1)];
    if (next && next !== selected) show(next, { animate: true, user });
    return next !== selected || Boolean(next);
  }

  prevBtn?.addEventListener("click", () => {
    stopPlayback();
    stepFrame(-1);
  }, { signal });
  nextBtn?.addEventListener("click", () => {
    stopPlayback();
    stepFrame(1);
  }, { signal });

  function setPlayEnabled(on: boolean) {
    if (playBtn) playBtn.disabled = !on;
    if (prevBtn) prevBtn.disabled = !on;
    if (nextBtn) nextBtn.disabled = !on;
    for (const btn of buttons.values()) btn.disabled = !on;
  }
  setPlayEnabled(false);

  function stopPlayback() {
    playing = false;
    window.clearTimeout(timer);
    timer = 0;
    if (playBtn) {
      playBtn.textContent = "▶ Play";
      playBtn.setAttribute("aria-pressed", "false");
    }
  }

  function advance() {
    if (!playing || gone()) return;
    const at = ids.indexOf(selected);
    if (at >= ids.length - 1) {
      stopPlayback();
      return;
    }
    show(ids[at + 1], { animate: true });
    // TE-REQ-17 — cadence is a constant, never a wait on the network: every
    // frame's data is already in hand before Play is enabled at all.
    timer = window.setTimeout(advance, TRANSITION_MS + HOLD_MS);
  }

  playBtn?.addEventListener("click", () => {
    if (playing) {
      stopPlayback();
      return;
    }
    playing = true;
    if (playBtn) {
      playBtn.textContent = "❚❚ Pause";
      playBtn.setAttribute("aria-pressed", "true");
    }
    // Playing from the end starts over rather than doing nothing.
    if (ids.indexOf(selected) >= ids.length - 1) {
      show(ids[0], { animate: false });
    }
    timer = window.setTimeout(advance, HOLD_MS);
  }, { signal });

  // §32 / TE-REQ-18 — nothing moves until somebody presses Play, and with
  // reduced motion the button is still there, it simply steps rather than
  // glides.
  stopPlayback();

  window.addEventListener("keydown", (e) => {
    if (
      e.target instanceof HTMLElement &&
      (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")
    ) {
      return;
    }
    if (e.key === "ArrowRight" && e.shiftKey) {
      e.preventDefault();
      stopPlayback();
      stepFrame(1);
    } else if (e.key === "ArrowLeft" && e.shiftKey) {
      e.preventDefault();
      stopPlayback();
      stepFrame(-1);
    }
  }, { signal });

  if (status) {
    const incomplete = ordered.filter((f) => !f.complete).length;
    status.textContent =
      `${ids.length} years from Last.fm's weekly charts` +
      (incomplete
        ? ` · ${incomplete} with a week that could not be read`
        : "");
  }
}
