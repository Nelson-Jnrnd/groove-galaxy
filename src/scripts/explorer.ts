/**
 * Exploration Mode — travelling between artist Systems.
 *
 * The Galaxy stays exactly where it was, underneath this: same artists,
 * same coordinates, same focused region. What this module draws is a
 * different *level* of navigation — one artist at the centre, the artists
 * Last.fm says are closest to it arranged around them, and a trail showing
 * how the visitor got there (EXP-PRINCIPLE-1, §14).
 *
 * Three rules shape almost everything here:
 *
 *   1. distance from the centre means similarity to the centre, and node
 *      size means nothing at all — on the map size is a play count, and a
 *      second meaning for the same channel would be a lie (EXP-REQ-10/11);
 *   2. an artist outside the Galaxy is drawn as being outside it, in shape
 *      as well as in colour, and never claims a cluster it was never
 *      clustered into (§7);
 *   3. nothing is fetched until it is travelled to. One hop outward is one
 *      similarity lookup, which is what lets this go on indefinitely
 *      without downloading the whole of Last.fm (EXP-PRINCIPLE-3,
 *      EXP-REQ-13/24).
 */
import { norm, type Artist, type Cluster } from "../lib/build.ts";
import {
  back,
  beginExploration,
  buildSystem,
  collapseTrail,
  currentAnchor,
  deadEnd,
  describeSystem,
  galaxyIndex,
  previousAnchor,
  layoutSystem,
  travel,
  type ExploreNode,
  type ExploreOrigin,
  type ExploreState,
  type System,
  type TrailEntry,
} from "../lib/explore.ts";
import * as api from "../lib/lastfm.ts";
import { periodInfo, type Period } from "../lib/period.ts";
import { announce, lastFmArtistUrl } from "./map.ts";

/* ─── geometry ───────────────────────────────────────────────────────── */

/** Closest a neighbour is ever drawn to the anchor, in world units. */
const INNER = 150;
/** …and the farthest. Everything in between is similarity. */
const OUTER = 430;
const ANCHOR_R = 54;
const NODE_R = 26;
const TRANSITION_MS = 520;
const THUMB_PX = "64s";
const DETAIL_PX = "174s";
const UNCLUSTERED = "#6d6a62";

const $ = <T extends HTMLElement>(id: string): T | null =>
  document.getElementById(id) as T | null;

const clamp = (v: number, lo: number, hi: number) =>
  v < lo ? lo : v > hi ? hi : v;

const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

const plural = (n: number, one: string, many = one + "s") =>
  `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

const reducedMotion = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function sized(url: string, size: string): string {
  return url.replace(/\/i\/u\/[^/]+\//, `/i/u/${size}/`);
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

/* ─── the host ───────────────────────────────────────────────────────── */

export interface ExplorerHost {
  stage: HTMLDivElement;
  user: string;
  period: Period;
  /** Where this exploration began — what `Return to Galaxy` goes back to. */
  origin: ExploreOrigin;
  /** The artist to open first. */
  anchor: string;
  /** The Galaxy underneath: what counts as known territory (§3, §18). */
  artists: Artist[];
  clusters: Cluster[];
  /** Somebody chose a new centre. The controller owns the URL, not this. */
  onTravel: (name: string) => void;
  onBack: () => void;
  onExit: () => void;
}

export interface Explorer {
  /** Show this artist's System, wherever the request came from. */
  travelTo(name: string): void;
  destroy(): void;
}

/** One node as it is currently being drawn. */
interface Placed {
  node: ExploreNode;
  x: number;
  y: number;
  r: number;
  /** Where it is coming from, for the recentring transition (EXP-REQ-15). */
  fromX: number;
  fromY: number;
  /** True when it was not on screen a moment ago, so it fades in. */
  fresh: boolean;
}

export function startExplorer(host: ExplorerHost): Explorer {
  const { stage } = host;
  const canvas = $<HTMLCanvasElement>("explore-canvas");
  const shell = $<HTMLDivElement>("explore");
  const trailBar = $<HTMLElement>("explore-trail");
  const statusLine = $<HTMLParagraphElement>("explore-status");
  const periodLine = $<HTMLParagraphElement>("explore-period");
  const panel = $<HTMLElement>("explore-detail");
  const backBtn = $<HTMLButtonElement>("explore-back");
  const exitBtn = $<HTMLButtonElement>("explore-exit");
  const tip = $<HTMLDivElement>("tip");

  const life = new AbortController();
  const signal = life.signal;
  let dead = false;

  const galaxy = galaxyIndex(host.artists);
  const saveData = Boolean(
    (navigator as Navigator & { connection?: { saveData?: boolean } })
      .connection?.saveData,
  );

  let state: ExploreState = beginExploration(host.origin, entryFor(host.anchor));
  let system: System | null = null;
  /** True when the only way out of this System is the way in (§22). */
  let stuck = false;
  let placed: Placed[] = [];
  let anchorPlaced: Placed | null = null;
  let hovered: Placed | null = null;
  let highlighted: Placed | null = null;
  /** Bumped on every hop; a slow similarity answer for an old one is dropped. */
  let hop = 0;

  const images = new Map<string, HTMLImageElement>();

  if (shell) shell.hidden = false;
  if (canvas) canvas.hidden = false;
  if (periodLine) {
    // §18 — which Galaxy "beyond your Galaxy" is measured against stays on
    // screen, because a 7-day Galaxy and an all-time one disagree about it.
    periodLine.textContent = `${host.user} · ${periodInfo(host.period).label}`;
  }

  const ctx = canvas ? canvas.getContext("2d", { alpha: false }) : null;

  /* ── viewport ─────────────────────────────────────────────────────── */

  let width = 0;
  let height = 0;
  let dpr = 1;
  const view = { cx: 0, cy: 0, scale: 1 };
  let fitScale = 1;

  const toScreenX = (x: number) => (x - view.cx) * view.scale + width / 2;
  const toScreenY = (y: number) => (y - view.cy) * view.scale + height / 2;
  const toWorldX = (sx: number) => (sx - width / 2) / view.scale + view.cx;
  const toWorldY = (sy: number) => (sy - height / 2) / view.scale + view.cy;

  function resize() {
    if (!canvas || !ctx) return;
    const rect = stage.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = Math.max(rect.width, 1);
    height = Math.max(rect.height, 1);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    fitScale = Math.min(width, height) / ((OUTER + NODE_R + 40) * 2);
    if (!framed) {
      framed = true;
      view.cx = 0;
      view.cy = 0;
      view.scale = fitScale;
    }
    draw();
  }
  let framed = false;

  /* ── the frame loop ───────────────────────────────────────────────── */

  let dirty = true;
  let rafId = 0;
  let transitionFrom = 0;
  let transition = 1;

  function draw() {
    dirty = true;
    if (!rafId) rafId = requestAnimationFrame(frame);
  }

  function frame(now: number) {
    rafId = 0;
    if (dead || !ctx) return;
    if (transition < 1) {
      transition = clamp((now - transitionFrom) / TRANSITION_MS, 0, 1);
      dirty = true;
    }
    if (!dirty) return;
    dirty = false;
    render();
    if (transition < 1) rafId = requestAnimationFrame(frame);
  }

  function render() {
    if (!ctx) return;
    ctx.fillStyle = "#141413";
    ctx.fillRect(0, 0, width, height);
    if (!anchorPlaced) return;

    const t = easeOut(transition);
    const at = (p: Placed) => ({
      x: p.fromX + (p.x - p.fromX) * t,
      y: p.fromY + (p.y - p.fromY) * t,
    });

    const centre = at(anchorPlaced);

    // Spokes: the similarity this whole picture is made of. Weight follows
    // the match, so the strong ties read as strong ties.
    for (const p of placed) {
      const q = at(p);
      const match = p.node.match ?? 0;
      const focusOn = p === hovered || p === highlighted;
      ctx.strokeStyle = `rgba(236, 233, 225, ${
        (focusOn ? 0.5 : 0.1 + match * 0.3) * (p.fresh ? t : 1)
      })`;
      ctx.lineWidth = focusOn ? 1.8 : 1;
      // Stop the spoke at each node's rim rather than running under it:
      // an outside node is deliberately barely filled, and a line crossing
      // it reads as a mark on the artist rather than a link to them.
      const ax = toScreenX(centre.x);
      const ay = toScreenY(centre.y);
      const bx = toScreenX(q.x);
      const by = toScreenY(q.y);
      const len = Math.hypot(bx - ax, by - ay) || 1;
      const ux = (bx - ax) / len;
      const uy = (by - ay) / len;
      const from = Math.min(anchorPlaced.r * view.scale, len * 0.45);
      const to = Math.min(p.r * view.scale, len * 0.45);
      ctx.beginPath();
      ctx.moveTo(ax + ux * from, ay + uy * from);
      ctx.lineTo(bx - ux * to, by - uy * to);
      ctx.stroke();
    }

    for (const p of placed) drawNode(p, at(p), p.fresh ? t : 1);
    drawNode(anchorPlaced, centre, 1, true);
    ctx.globalAlpha = 1;
  }

  function drawNode(
    p: Placed,
    pos: { x: number; y: number },
    alpha: number,
    isAnchor = false,
  ) {
    if (!ctx) return;
    const r = p.r * view.scale;
    const sx = toScreenX(pos.x);
    const sy = toScreenY(pos.y);
    const emphasised = isAnchor || p === hovered || p === highlighted;
    const known = p.node.status === "galaxy";
    const visited = p.node.status === "explored";
    const colour =
      known && p.node.clusterId !== undefined
        ? (host.clusters[p.node.clusterId]?.color ?? UNCLUSTERED)
        : known
          ? UNCLUSTERED
          : "rgba(236, 233, 225, 0.08)";

    ctx.globalAlpha = alpha;
    const img = images.get(norm(p.node.name));
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    if (img) {
      ctx.save();
      ctx.clip();
      ctx.drawImage(img, sx - r, sy - r, r * 2, r * 2);
      ctx.globalAlpha = alpha * (known ? 0.42 : 0.5);
      ctx.fillStyle = known ? colour : "#1a1a18";
      ctx.fillRect(sx - r, sy - r, r * 2, r * 2);
      ctx.restore();
      ctx.globalAlpha = alpha;
    } else {
      ctx.fillStyle = known ? colour : "rgba(236, 233, 225, 0.08)";
      ctx.globalAlpha = alpha * (known ? 0.5 : 1);
      ctx.fill();
      ctx.globalAlpha = alpha;
    }

    // §7 / §21 — status is carried by the shape of the rim as well as its
    // colour: solid for known territory, dashed for what lies beyond it,
    // and a doubled rim for somewhere this trail has already been.
    ctx.setLineDash(known || visited ? [] : [4, 3]);
    ctx.lineWidth = emphasised ? 2.4 : 1.4;
    ctx.strokeStyle = emphasised
      ? "#ece9e1"
      : known
        ? colour
        : visited
          ? "rgba(95, 168, 119, 0.9)"
          : "rgba(236, 233, 225, 0.55)";
    ctx.stroke();
    ctx.setLineDash([]);

    if (!known) {
      ctx.beginPath();
      ctx.arc(sx, sy, r + (visited ? 3 : 4), 0, Math.PI * 2);
      ctx.strokeStyle = visited
        ? "rgba(95, 168, 119, 0.55)"
        : "rgba(236, 233, 225, 0.15)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    const size = isAnchor ? 15 : clamp(r * 0.42, 11, 14);
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.font = `${emphasised ? 500 : 400} ${size.toFixed(1)}px "IBM Plex Sans", system-ui, sans-serif`;
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(20, 20, 19, 0.85)";
    ctx.strokeText(p.node.name, sx, sy + r + 6);
    ctx.fillStyle = emphasised ? "#ece9e1" : "rgba(236, 233, 225, 0.75)";
    ctx.fillText(p.node.name, sx, sy + r + 6);
  }

  /* ── pointer ──────────────────────────────────────────────────────── */

  function hit(sx: number, sy: number): Placed | null {
    const wx = toWorldX(sx);
    const wy = toWorldY(sy);
    for (const p of placed) {
      if (Math.hypot(wx - p.x, wy - p.y) <= Math.max(p.r, 12 / view.scale)) {
        return p;
      }
    }
    return null;
  }

  if (canvas) {
    let panning = false;
    let movedBy = 0;
    let last = { x: 0, y: 0 };
    const local = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };

    canvas.addEventListener("pointerdown", (e) => {
      canvas.setPointerCapture(e.pointerId);
      panning = true;
      movedBy = 0;
      last = local(e);
    }, { signal });

    canvas.addEventListener("pointermove", (e) => {
      const p = local(e);
      if (panning && (e.buttons || e.pointerType !== "mouse")) {
        const dx = p.x - last.x;
        const dy = p.y - last.y;
        movedBy += Math.abs(dx) + Math.abs(dy);
        view.cx -= dx / view.scale;
        view.cy -= dy / view.scale;
        last = p;
        draw();
        return;
      }
      if (e.pointerType === "mouse") setHover(hit(p.x, p.y), e.clientX, e.clientY);
    }, { signal });

    const end = (e: PointerEvent) => {
      const p = local(e);
      const wasPanning = panning;
      panning = false;
      if (!wasPanning || movedBy >= 6 || e.type !== "pointerup") return;
      const target = hit(p.x, p.y);
      // §10 — choosing another artist is what travelling *is*.
      if (target) host.onTravel(target.node.name);
    };
    canvas.addEventListener("pointerup", end, { signal });
    canvas.addEventListener("pointercancel", () => { panning = false; }, { signal });
    canvas.addEventListener("pointerleave", () => setHover(null), { signal });

    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const wx = toWorldX(sx);
      const wy = toWorldY(sy);
      view.scale = clamp(
        view.scale * Math.exp(-clamp(e.deltaY, -60, 60) * 0.0032),
        fitScale * 0.4,
        fitScale * 6,
      );
      view.cx = wx - (sx - width / 2) / view.scale;
      view.cy = wy - (sy - height / 2) / view.scale;
      draw();
    }, { passive: false, signal });
  }

  function setHover(p: Placed | null, clientX = 0, clientY = 0) {
    if (p !== hovered) {
      hovered = p;
      if (canvas) canvas.style.cursor = p ? "pointer" : "grab";
      draw();
    }
    if (!tip) return;
    if (!p) {
      tip.hidden = true;
      return;
    }
    tip.hidden = false;
    tip.textContent = `${p.node.name} · ${statusWord(p.node)}${
      p.node.match ? ` · ${Math.round(p.node.match * 100)}% match` : ""
    }`;
    const rect = stage.getBoundingClientRect();
    tip.style.transform = `translate(${clamp(
      clientX - rect.left + 14,
      8,
      rect.width - tip.offsetWidth - 8,
    )}px, ${clamp(
      clientY - rect.top + 16,
      8,
      rect.height - tip.offsetHeight - 8,
    )}px)`;
  }

  const statusWord = (node: ExploreNode) =>
    node.status === "galaxy"
      ? "in your Galaxy"
      : node.status === "explored"
        ? "beyond your Galaxy · explored"
        : "beyond your Galaxy";

  /* ── travelling ───────────────────────────────────────────────────── */

  function entryFor(name: string): TrailEntry {
    const known = galaxy.get(norm(name));
    return {
      name: known ? known.name : name,
      status: known ? "galaxy" : "frontier",
    };
  }

  function setStatus(text: string) {
    if (statusLine) statusLine.textContent = text;
  }

  /**
   * One hop. EXP-REQ-13 — exactly one similarity lookup, for exactly the
   * artist being travelled to, and only when it is actually travelled to.
   */
  async function open(name: string) {
    const token = ++hop;
    state = travel(state, entryFor(name));
    renderTrail();
    const anchorName = currentAnchor(state).name;
    setStatus(`Mapping the area around ${anchorName}…`);

    let similar: api.SimilarArtist[];
    try {
      similar = await api.similar(anchorName);
    } catch {
      // §22 — a failed lookup never takes the exploration down with it.
      if (dead || token !== hop) return;
      setStatus("Couldn't map the area around this artist. Try another node, or go back.");
      announce(`Couldn't map the area around ${anchorName}.`);
      return;
    }
    if (dead || token !== hop) return;

    const previous = previousAnchor(state);
    const next = buildSystem({
      anchor: anchorName,
      similar,
      galaxy,
      explored: state.explored,
      previous: previous ? previous.name : null,
    });
    show(next);
  }

  function show(next: System) {
    const previousPositions = new Map<string, { x: number; y: number }>();
    for (const p of placed) previousPositions.set(norm(p.node.name), { x: p.x, y: p.y });
    if (anchorPlaced) {
      previousPositions.set(norm(anchorPlaced.node.name), {
        x: anchorPlaced.x,
        y: anchorPlaced.y,
      });
    }

    system = next;
    const points = layoutSystem(next.neighbours, { inner: INNER, outer: OUTER });
    placed = next.neighbours.map((node, i) => {
      const from = previousPositions.get(norm(node.name));
      return {
        node,
        x: points[i].x,
        y: points[i].y,
        r: NODE_R,
        fromX: from ? from.x : points[i].x,
        fromY: from ? from.y : points[i].y,
        fresh: !from,
      };
    });
    const anchorFrom = previousPositions.get(norm(next.anchor.name));
    anchorPlaced = {
      node: next.anchor,
      x: 0,
      y: 0,
      r: ANCHOR_R,
      // The artist that was chosen visibly moves to the middle — that is
      // what says "you are now here" (EXP-REQ-15).
      fromX: anchorFrom ? anchorFrom.x : 0,
      fromY: anchorFrom ? anchorFrom.y : 0,
      fresh: false,
    };
    hovered = null;
    highlighted = null;
    stuck = deadEnd(next, previousAnchor(state)?.name ?? null);

    transition = reducedMotion() ? 1 : 0;
    transitionFrom = performance.now();
    // Recentre on the new System, so travelling can't strand the visitor
    // off the edge of a view they panned earlier.
    view.cx = 0;
    view.cy = 0;
    draw();

    renderTrail();
    renderPanel();
    setStatus(
      stuck
        ? "No further strong connections found here. That is a legitimate end of the road — go back, or return to your Galaxy."
        : `${plural(
            next.neighbours.filter((n) => n.status === "galaxy").length,
            "artist",
          )} here are in your Galaxy · ${
            next.neighbours.filter((n) => n.status !== "galaxy").length
          } beyond it`,
    );
    announce(
      stuck
        ? `Exploring ${next.anchor.name}. No further strong connections found here.`
        : describeSystem(next),
    );
    void loadArt(hop, next);
  }

  /**
   * §13 / EXP-REQ-20 — artwork is background enrichment for the artists
   * actually on screen. Nothing is prefetched for artists that merely
   * *might* be travelled to next.
   */
  async function loadArt(token: number, next: System) {
    if (saveData) return;
    const wanted = [next.anchor, ...next.neighbours];
    await Promise.all(
      wanted.map(async (node) => {
        const key = norm(node.name);
        if (images.has(key)) return;
        const url = node.image || (await api.artwork(node.name).catch(() => ""));
        if (dead || token !== hop || !url) return;
        const img = new Image();
        img.decoding = "async";
        img.referrerPolicy = "no-referrer";
        img.onload = () => {
          if (dead || !img.naturalWidth) return;
          images.set(key, img);
          draw();
        };
        img.onerror = () => {};
        img.src = sized(url, node === next.anchor ? DETAIL_PX : THUMB_PX);
      }),
    );
  }

  /* ── the trail (EXP-REQ-16) ───────────────────────────────────────── */

  function renderTrail() {
    if (!trailBar) return;
    trailBar.replaceChildren();

    const root = el("button", "trail__step trail__step--home");
    root.type = "button";
    root.textContent =
      host.origin.kind === "cluster" ? host.origin.label : "Your Galaxy";
    root.title =
      host.origin.kind === "cluster"
        ? `Back to the ${host.origin.label} region of your Galaxy`
        : "Back to your Galaxy";
    root.addEventListener("click", () => host.onExit());
    trailBar.append(root);

    for (const entry of collapseTrail(state.trail, 3)) {
      trailBar.append(el("span", "trail__sep", "/"));
      if (!entry) {
        trailBar.append(el("span", "trail__ellipsis", "…"));
        continue;
      }
      const here = norm(entry.name) === norm(currentAnchor(state).name);
      const step = el("button", `trail__step${here ? " is-here" : ""}`);
      step.type = "button";
      step.textContent = entry.name;
      if (here) step.setAttribute("aria-current", "true");
      step.addEventListener("click", () => host.onTravel(entry.name));
      trailBar.append(step);
    }
  }

  /* ── the panel: the anchor, and everything around it ──────────────── */

  function renderPanel() {
    if (!panel || !system) return;
    const { anchor, neighbours } = system;
    panel.replaceChildren();
    panel.hidden = false;

    const known = galaxy.get(norm(anchor.name));
    const art = el(
      "div",
      "detail__art" +
        (known ? "" : " detail__art--frontier") +
        (known?.image || anchor.image ? "" : " detail__art--empty"),
    );
    const artUrl = known?.image || anchor.image;
    if (artUrl) art.style.backgroundImage = `url("${sized(artUrl, DETAIL_PX)}")`;
    else art.textContent = "♪";

    const body = el("div", "detail__body");
    const kicker = el(
      "p",
      `detail__kicker${known ? "" : " detail__kicker--frontier"}`,
    );
    const swatch = el(
      "span",
      `detail__swatch${known ? "" : " detail__swatch--frontier"}`,
    );
    swatch.setAttribute("aria-hidden", "true");
    if (known) {
      swatch.style.background =
        known.cluster >= 0 && host.clusters[known.cluster]
          ? host.clusters[known.cluster].color
          : UNCLUSTERED;
    }
    kicker.append(
      swatch,
      document.createTextNode(
        known
          ? `In your Galaxy${
              known.cluster >= 0 && host.clusters[known.cluster]
                ? ` · ${host.clusters[known.cluster].label}`
                : ""
            }`
          : // The anchor is the artist being explored right now, so saying
            // it has been explored would be noise; that mark belongs on the
            // artists around it (§12).
            "Beyond your current Galaxy",
      ),
    );
    body.append(kicker, el("h2", "detail__title", anchor.name));

    // §12 — a play count only exists for an artist the Galaxy actually
    // holds. "0 plays" is never shown, because it is never known.
    if (known) {
      body.append(
        el(
          "p",
          "detail__plays",
          `${plural(known.plays, "play")} · ${periodInfo(host.period).suffix}`,
        ),
      );
    }

    const link = el("p", "detail__links");
    const a = el("a", undefined, "Last.fm page ↗");
    a.href = known ? known.url : lastFmArtistUrl(anchor.name);
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    link.append(a);
    body.append(link);

    body.append(
      el(
        "p",
        "detail__near-head",
        stuck ? "No further strong connections found here" : "Around this artist",
      ),
    );

    if (stuck) {
      body.append(
        el(
          "p",
          "detail__why",
          "Last.fm has no further strong similarity data for this artist. " +
            "That is a legitimate end of the road — go back a step and take " +
            "another turning.",
        ),
      );
    }

    if (!neighbours.length) {
      /* nothing to list at all */
    } else {
      const list = el("ul", "detail__near");
      for (const node of neighbours) {
        const li = el("li");
        const btn = el("button", `near near--${node.status}`);
        btn.type = "button";
        const bar = el("span", "near__bar");
        bar.setAttribute("aria-hidden", "true");
        const fill = el("span", "near__fill");
        fill.style.width = `${Math.round(clamp(node.match ?? 0.04, 0.04, 1) * 100)}%`;
        fill.style.background =
          node.status === "galaxy" && node.clusterId !== undefined
            ? (host.clusters[node.clusterId]?.color ?? UNCLUSTERED)
            : node.status === "explored"
              ? "#5fa877"
              : "rgba(236, 233, 225, 0.5)";
        bar.append(fill);
        btn.append(
          el("span", "near__name", node.name),
          el("span", `near__badge near__badge--${node.status}`, badgeFor(node)),
          bar,
          el(
            "span",
            "near__score",
            node.match ? `${Math.round(node.match * 100)}%` : "—",
          ),
        );
        btn.setAttribute(
          "aria-label",
          `${node.name}, ${statusWord(node)}${
            node.match ? `, ${Math.round(node.match * 100)} per cent match` : ""
          } — explore from here`,
        );
        // Focusing the list marks the node on the canvas, so a keyboard
        // user can see where they are in the System (§21).
        btn.addEventListener("focus", () => {
          highlighted = placed.find((p) => p.node === node) || null;
          draw();
        });
        btn.addEventListener("blur", () => {
          highlighted = null;
          draw();
        });
        btn.addEventListener("mouseenter", () => {
          hovered = placed.find((p) => p.node === node) || null;
          draw();
        });
        btn.addEventListener("mouseleave", () => {
          hovered = null;
          draw();
        });
        btn.addEventListener("click", () => host.onTravel(node.name));
        li.append(btn);
        list.append(li);
      }
      body.append(list);
      body.append(
        el(
          "p",
          "detail__why",
          "Distance from the centre is similarity to " +
            `${anchor.name} in Last.fm's listening data. Size means nothing here — ` +
            "on your Galaxy it means plays, and an artist beyond your Galaxy has none to show.",
        ),
      );
    }

    panel.append(art, body);
    panel.scrollTop = 0;
  }

  const badgeFor = (node: ExploreNode) =>
    node.status === "galaxy"
      ? "in your Galaxy"
      : node.status === "explored"
        ? "explored"
        : "beyond";

  /* ── controls ─────────────────────────────────────────────────────── */

  backBtn?.addEventListener("click", () => {
    // One step back along the trail, or out of exploration entirely when
    // this is where it started (EXP-REQ-19).
    if (back(state)) host.onBack();
    else host.onExit();
  }, { signal });
  exitBtn?.addEventListener("click", () => host.onExit(), { signal });

  window.addEventListener("keydown", (e) => {
    if (
      e.target instanceof HTMLElement &&
      (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")
    ) {
      return;
    }
    if (e.key === "Escape") host.onExit();
  }, { signal });

  const observer = new ResizeObserver(resize);
  observer.observe(stage);
  resize();
  void open(host.anchor);

  return {
    travelTo(name: string) {
      if (dead) return;
      if (system && norm(system.anchor.name) === norm(name)) return;
      void open(name);
    },
    destroy() {
      dead = true;
      life.abort();
      observer.disconnect();
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
      images.clear();
      placed = [];
      anchorPlaced = null;
      if (canvas) canvas.hidden = true;
      if (shell) shell.hidden = true;
      if (trailBar) trailBar.replaceChildren();
      if (panel) {
        panel.hidden = true;
        panel.replaceChildren();
      }
      if (tip) tip.hidden = true;
    },
  };
}
