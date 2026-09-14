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
 *   1. distance from the centre is similarity, angle is style, and size is
 *      how widely known an artist is — three different questions, three
 *      different channels, never doubled up and never bigger than the
 *      anchor itself (EXP-REQ-10/10a/11);
 *   2. an artist outside the Galaxy is drawn as being outside it, in shape
 *      as well as in colour — grey for played, green for new, nothing
 *      else — and never claims a cluster it was never clustered into (§7);
 *   3. nothing is fetched until it is travelled to. One hop outward is one
 *      similarity lookup, which is what lets this go on indefinitely
 *      without downloading the whole of Last.fm (EXP-PRINCIPLE-3,
 *      EXP-REQ-13/24).
 *
 * Clicking a style's own label focuses it: its wedge claims half the
 * circle, everyone else compresses into what's left, and it pulls in more
 * of that style from two sources — the anchor's own matches that were
 * ranked but cut for space (`System.overflow`), then, since a tag rarely
 * dominates that list on its own, a second-degree cast through whatever
 * is already on screen in that style, asking Last.fm what *they* are
 * close to (EXP-REQ-9a). The anchor itself never moves; only the shape of
 * the circle around it does.
 */
import { norm, type Artist, type Cluster } from "../lib/build.ts";
import {
  back,
  beginExploration,
  buildSystem,
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
/** Starting size, before a node's listener count has loaded. */
const NODE_R = 20;
/**
 * Once a node's global listener count is known, its size moves within this
 * range — popularity, this time, rather than similarity or personal plays.
 * The top of the range stays below ANCHOR_R: the artist being explored
 * stays the biggest thing on screen no matter how famous its neighbours
 * are (review — "never bigger than the star of the system"), and the range
 * itself is wide (review — "make the differences in size bigger") so the
 * difference between a household name and a niche act actually reads.
 */
const NODE_R_MIN = 12;
const NODE_R_MAX = 50;
/** Listener counts span orders of magnitude, so size follows their log. */
const LISTENERS_LOG_MIN = 3; // ~1,000 listeners
const LISTENERS_LOG_MAX = 6.3; // ~2,000,000 listeners
const TRANSITION_MS = 520;
const THUMB_PX = "64s";
const DETAIL_PX = "174s";
const UNCLUSTERED = "#6d6a62";
/** The one colour "new to you" gets — a border and a small top-right badge. */
const GREEN = "#5fa877";
const greenA = (a: number) => `rgba(95, 168, 119, ${a})`;

const $ = <T extends HTMLElement>(id: string): T | null =>
  document.getElementById(id) as T | null;

const clamp = (v: number, lo: number, hi: number) =>
  v < lo ? lo : v > hi ? hi : v;

const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

const plural = (n: number, one: string, many = one + "s") =>
  `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

const reducedMotion = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** One tag label, about to be placed around the outer edge of its wedge. */
interface TagLabel {
  tag: string;
  lines: string[];
  hue: number;
  angle: number;
  /** Half of how much arc, in radians at its drawing radius, the widest line needs. */
  halfWidth: number;
}

/**
 * Nudge tag labels apart along the ring they share, so two wedges whose
 * angular ranges sit close together — or overlap outright — don't print
 * their names on top of each other (review — "hard to see... particularly
 * when slices overlap"). Angle only: a label always stays on the outer
 * ring its wedge lives on, just not exactly at the mid-angle when a
 * neighbour needs the room.
 */
function resolveLabelOverlap(labels: TagLabel[]) {
  const gap = 0.035;
  for (let pass = 0; pass < 30; pass++) {
    let moved = false;
    for (let i = 0; i < labels.length; i++) {
      for (let j = i + 1; j < labels.length; j++) {
        const a = labels[i];
        const b = labels[j];
        let diff = b.angle - a.angle;
        while (diff <= -Math.PI) diff += Math.PI * 2;
        while (diff > Math.PI) diff -= Math.PI * 2;
        const needed = a.halfWidth + b.halfWidth + gap;
        if (Math.abs(diff) >= needed) continue;
        const push = (needed - Math.abs(diff)) / 2;
        const sign = diff >= 0 ? 1 : -1;
        a.angle -= sign * push;
        b.angle += sign * push;
        moved = true;
      }
    }
    if (!moved) break;
  }
}

/** A stable colour for a tag's wedge and label — same tag, same hue, always. */
function tagHue(tag: string): number {
  let h = 2166136261;
  for (let i = 0; i < tag.length; i++) {
    h ^= tag.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) / 4294967296) * 360;
}

const TAG_FONT = `500 11px "IBM Plex Sans", system-ui, sans-serif`;
/** Radial gap between wrapped lines of a tag label. */
const ARC_LINE_GAP = 15;

/**
 * Split a tag's name into at most two lines that each fit within
 * `maxAngle` radians at `radius`, so a long tag never runs past its own
 * neighbours (review — "make sure it's not too long — wrap around").
 * Most tags are one or two words and never wrap at all.
 */
function wrapArcText(
  ctx: CanvasRenderingContext2D,
  text: string,
  radius: number,
  maxAngle: number,
): string[] {
  const maxWidth = maxAngle * radius;
  if (ctx.measureText(text).width <= maxWidth) return [text];
  const words = text.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const attempt = current ? `${current} ${word}` : word;
    if (current && ctx.measureText(attempt).width > maxWidth) {
      lines.push(current);
      current = word;
    } else {
      current = attempt;
    }
  }
  if (current) lines.push(current);
  if (lines.length > 2) {
    lines.length = 2;
    lines[1] = lines[1].trimEnd() + "…";
  }
  return lines;
}

/**
 * A tag's name, following the curve of its own wedge rather than sitting
 * on top of it as a flat sticker (review — "wrap the text around the
 * radius of the section"). Text is walked outward from `midAngle`
 * character by character; on the lower half of the circle both the walk
 * direction and each glyph's own rotation flip, so the label still reads
 * left-to-right and right-side up no matter where around the System it
 * ends up.
 */
function drawArcText(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  lines: string[],
  midAngle: number,
  baseRadius: number,
  hue: number,
  active = false,
) {
  ctx.font = active ? `700 11px "IBM Plex Sans", system-ui, sans-serif` : TAG_FONT;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const flip = Math.sin(midAngle) > 0;
  const sweep = flip ? -1 : 1;
  const rotSign = flip ? -1 : 1;

  lines.forEach((line, li) => {
    // A second line has to land on the side of the first that still reads
    // top-to-bottom on screen — outward for a label on the bottom half,
    // inward for one on the top half, since "inward" and "outward" swap
    // which one means "further down the page" between the two halves.
    const radius = baseRadius + li * ARC_LINE_GAP * (flip ? 1 : -1);
    const chars = [...line];
    const widths = chars.map((c) => ctx.measureText(c).width);
    const totalAngle = widths.reduce((sum, w) => sum + w, 0) / radius;
    let angle = midAngle - sweep * (totalAngle / 2);
    for (let i = 0; i < chars.length; i++) {
      const half = widths[i] / radius / 2;
      angle += sweep * half;
      ctx.save();
      ctx.translate(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius);
      ctx.rotate(angle + (rotSign * Math.PI) / 2);
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = "rgba(20, 20, 19, 0.85)";
      ctx.strokeText(chars[i], 0, 0);
      ctx.fillStyle = active
        ? `hsla(${hue}, 75%, 90%, 1)`
        : `hsla(${hue}, 70%, 82%, 0.95)`;
      ctx.fillText(chars[i], 0, 0);
      ctx.restore();
      angle += sweep * half;
    }
  });
}

function sizeForListeners(n: number): number {
  const t = clamp(
    (Math.log10(n + 1) - LISTENERS_LOG_MIN) / (LISTENERS_LOG_MAX - LISTENERS_LOG_MIN),
    0,
    1,
  );
  return NODE_R_MIN + (NODE_R_MAX - NODE_R_MIN) * t;
}

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
  const infoBtn = $<HTMLButtonElement>("explore-info");
  const tip = $<HTMLDivElement>("tip");
  // The detail panel is opt-in now (review — "remove the side page that is
  // always showing"): closed until asked for, reachable by keyboard either
  // way (§21) through this toggle.
  let panelOpen = false;

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
  /**
   * A style claiming most of the circle (EXP-REQ-10a), or null. Reset on
   * every hop — focus belongs to the System it was set in, not the trail.
   */
  let focusedTag: string | null = null;
  /**
   * Extra artists pulled in from `system.overflow` because they share the
   * focused tag (review — "more artists of that tag are shown"). Cleared
   * whenever focus changes or clears, so at most one tag's expansion is
   * ever showing.
   */
  let expansion: ExploreNode[] = [];
  /** Where each tag's label currently is, for hit-testing a click on one. */
  let labelHits: { tag: string; angle: number; halfWidth: number; radius: number }[] = [];

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
    fitScale = Math.min(width, height) / ((OUTER + NODE_R_MAX + 60) * 2);
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
    const cx = toScreenX(centre.x);
    const cy = toScreenY(centre.y);

    // Style regions: a subtle wedge behind the System for every tag that's
    // in it, like a slice of the sky this System's style occupies (review —
    // "mark the grouping by tag with a background colour... like a pizza
    // slice"). Angle alone carries this (EXP-REQ-10a); radius stays
    // reserved for similarity.
    const byTag = new Map<string, number[]>();
    for (const p of placed) {
      if (!p.node.tag) continue;
      const q = at(p);
      const angle = Math.atan2(q.y - centre.y, q.x - centre.x);
      const list = byTag.get(p.node.tag);
      if (list) list.push(angle);
      else byTag.set(p.node.tag, [angle]);
    }
    const wedgeOuter = (OUTER + NODE_R_MAX + 70) * view.scale;
    const labelRadius = wedgeOuter * 0.9;
    ctx.font = TAG_FONT;
    const labels: TagLabel[] = [];
    for (const [tag, angles] of byTag) {
      let lo = angles[0];
      let hi = angles[0];
      for (const raw of angles) {
        let a = raw;
        while (a < lo - Math.PI) a += Math.PI * 2;
        while (a > lo + Math.PI) a -= Math.PI * 2;
        if (a < lo) lo = a;
        if (a > hi) hi = a;
      }
      const pad = 0.16;
      const start = lo - pad;
      const end = hi + pad;
      const hue = tagHue(tag);
      const active = tag === focusedTag;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, wedgeOuter, start, end);
      ctx.closePath();
      ctx.fillStyle = `hsla(${hue}, 50%, 60%, ${active ? 0.12 : 0.055})`;
      ctx.fill();

      // Never wider than the wedge itself, with a floor so a razor-thin
      // slice still gets a readable line to wrap onto.
      const lines = wrapArcText(ctx, tag, labelRadius, Math.max(end - start, 0.4));
      const widest = Math.max(...lines.map((l) => ctx.measureText(l).width));
      labels.push({
        tag,
        lines,
        hue,
        angle: (start + end) / 2,
        halfWidth: (widest / 2 + 8) / labelRadius,
      });
    }
    resolveLabelOverlap(labels);
    // World units, so a click can be hit-tested the same way node clicks
    // already are, regardless of the current pan/zoom (the anchor always
    // sits at the world origin).
    labelHits = labels.map((l) => ({
      tag: l.tag,
      angle: l.angle,
      halfWidth: l.halfWidth,
      radius: labelRadius / view.scale,
    }));
    for (const l of labels) {
      const active = l.tag === focusedTag;
      drawArcText(ctx, cx, cy, l.lines, l.angle, labelRadius, l.hue, active);
    }

    // Orbits, not spokes: distance from the anchor is still similarity to
    // it (EXP-REQ-10), drawn as the ring a node travels rather than a line
    // pointing at it (review — "orbit circles around the star"). Just two
    // colours, matching the node on the ring: grey for the Galaxy, green
    // for anything new.
    for (const p of placed) {
      const q = at(p);
      const radius = Math.hypot(q.x - centre.x, q.y - centre.y) * view.scale;
      if (radius < 1) continue;
      const focusOn = p === hovered || p === highlighted;
      const known = p.node.status === "galaxy";
      const alpha = (focusOn ? 0.55 : known ? 0.14 : 0.18) * (p.fresh ? t : 1);
      ctx.beginPath();
      ctx.strokeStyle = known ? `rgba(236, 233, 225, ${alpha})` : greenA(alpha);
      ctx.lineWidth = focusOn ? 1.6 : 1;
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
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
    // §7 / §21 — only two categories now (review): grey for an artist this
    // account has already played, green — a border and a small top-right
    // badge, never colour alone — for anything new.
    const known = p.node.status === "galaxy";
    const colour = known ? UNCLUSTERED : GREEN;

    ctx.globalAlpha = alpha;
    const img = images.get(norm(p.node.name));
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    if (img) {
      ctx.save();
      ctx.clip();
      ctx.drawImage(img, sx - r, sy - r, r * 2, r * 2);
      ctx.globalAlpha = alpha * (known ? 0.42 : 0.32);
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

    ctx.lineWidth = emphasised ? 2.4 : 1.4;
    ctx.strokeStyle = emphasised ? "#ece9e1" : colour;
    ctx.stroke();

    if (!known) {
      // The badge is the one thing that has to survive without colour:
      // a plain cross reads on any screen, colourblind or not.
      const bx = sx + r * Math.SQRT1_2;
      const by = sy - r * Math.SQRT1_2;
      const br = Math.max(r * 0.3, 6);
      ctx.beginPath();
      ctx.arc(bx, by, br, 0, Math.PI * 2);
      ctx.fillStyle = GREEN;
      ctx.fill();
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = "#141413";
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(bx - br * 0.5, by);
      ctx.lineTo(bx + br * 0.5, by);
      ctx.moveTo(bx, by - br * 0.5);
      ctx.lineTo(bx, by + br * 0.5);
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = "#141413";
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

  /** Which tag label, if any, a point falls near — the anchor is always
   * the world origin, so this is the same angle/radius test as `hit`. */
  function hitLabel(sx: number, sy: number): string | null {
    const wx = toWorldX(sx);
    const wy = toWorldY(sy);
    const angle = Math.atan2(wy, wx);
    const radius = Math.hypot(wx, wy);
    for (const l of labelHits) {
      if (Math.abs(radius - l.radius) > 26 / view.scale) continue;
      let diff = angle - l.angle;
      while (diff <= -Math.PI) diff += Math.PI * 2;
      while (diff > Math.PI) diff -= Math.PI * 2;
      if (Math.abs(diff) <= l.halfWidth + 0.02) return l.tag;
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
      if (target) {
        host.onTravel(target.node.name);
        return;
      }
      const tag = hitLabel(p.x, p.y);
      if (tag) setFocus(tag);
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
    node.status === "galaxy" ? "already played" : "new to you";

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

  /** Every node currently on screen besides the anchor: the System's own
   * neighbours, plus whatever's been pulled in for a focused tag. */
  const currentNodes = () => (system ? [...system.neighbours, ...expansion] : []);

  /**
   * (Re)lay out a given set of neighbour nodes, carrying over the size and
   * position of any that were already on screen — a hop, a tag arriving
   * late, or a focus change are all just "the node set or the layout
   * inputs changed", so they all go through here.
   */
  function place(nodes: ExploreNode[]) {
    const prevByName = new Map(placed.map((p) => [norm(p.node.name), p]));
    const points = layoutSystem(nodes, { inner: INNER, outer: OUTER, focusedTag });
    placed = nodes.map((node, i) => {
      const prev = prevByName.get(norm(node.name));
      return {
        node,
        x: points[i].x,
        y: points[i].y,
        r: prev ? prev.r : NODE_R,
        fromX: prev ? prev.x : points[i].x,
        fromY: prev ? prev.y : points[i].y,
        fresh: !prev,
      };
    });
    resolveOverlaps();
    transition = reducedMotion() ? 1 : 0;
    transitionFrom = performance.now();
    draw();
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
    const anchorFrom = previousPositions.get(norm(next.anchor.name));

    system = next;
    focusedTag = null;
    expansion = [];
    place(next.neighbours);
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
        : "",
    );
    announce(
      stuck
        ? `Exploring ${next.anchor.name}. No further strong connections found here.`
        : describeSystem(next),
    );
    void loadEnrichment(hop, [next.anchor, ...next.neighbours]);
  }

  /**
   * Nothing may overlap once sizes stop being uniform and angles start
   * clustering by style (review — "make sure they don't overlap / either
   * by moving the orbit or sliding them around their own orbit"). A node is
   * mostly nudged sideways, along its own orbit; only when two nodes sit at
   * almost the same angle — sliding alone cannot separate them — does it
   * drift onto a slightly different orbit. `layoutSystem`'s own radius,
   * which is similarity and nothing else, is never touched by this; this
   * runs afterwards, once real per-node sizes exist, which `layoutSystem`
   * never sees.
   */
  function resolveOverlaps() {
    const margin = 6;
    for (let pass = 0; pass < 40; pass++) {
      let moved = false;
      for (let i = 0; i < placed.length; i++) {
        for (let j = i + 1; j < placed.length; j++) {
          const a = placed[i];
          const b = placed[j];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const dist = Math.hypot(dx, dy) || 1e-6;
          const min = a.r + b.r + margin;
          if (dist >= min) continue;
          const push = (min - dist) / 2 + 0.5;
          const ux = dx / dist;
          const uy = dy / dist;
          nudge(a, -ux * push, -uy * push);
          nudge(b, ux * push, uy * push);
          moved = true;
        }
      }
      if (!moved) break;
    }
  }

  /** Move a placed node by a vector, mostly along its orbit, a little across it. */
  function nudge(p: Placed, vx: number, vy: number) {
    const r = Math.hypot(p.x, p.y) || 1e-6;
    const rx = p.x / r;
    const ry = p.y / r;
    const tx = -ry;
    const ty = rx;
    const radial = vx * rx + vy * ry;
    const tangent = vx * tx + vy * ty;
    p.x += tx * tangent + rx * radial * 0.4;
    p.y += ty * tangent + ry * radial * 0.4;
  }

  const snapshot = () => placed.map((p) => ({ x: p.x, y: p.y }));

  /** Resolve overlaps against a pre-change snapshot, then transition into it. */
  function settleFrom(before: { x: number; y: number }[]) {
    resolveOverlaps();
    let changed = false;
    placed.forEach((p, i) => {
      p.fromX = before[i].x;
      p.fromY = before[i].y;
      if (p.x !== before[i].x || p.y !== before[i].y) changed = true;
    });
    if (changed) {
      transition = reducedMotion() ? 1 : 0;
      transitionFrom = performance.now();
    }
    draw();
  }

  /** A node's listener count just arrived — resize it and settle any overlap that opens up. */
  function applyListeners(node: ExploreNode, value: number) {
    node.listeners = value;
    if (node === anchorPlaced?.node) return; // the star's size never depends on this
    const p = placed.find((q) => q.node === node);
    if (!p) return;
    const before = snapshot();
    p.r = sizeForListeners(value);
    settleFrom(before);
  }

  /**
   * A tag arriving late can shrink or grow every tag's arc, not just its
   * own node's — the whole System goes through the shared layout again
   * (review — "position around their own orbit could be influenced by the
   * style").
   */
  function applyTag(node: ExploreNode, tag: string) {
    node.tag = tag;
    if (node === anchorPlaced?.node) return; // the star sits at the centre regardless
    if (!placed.some((p) => p.node === node)) return;
    place(currentNodes());
  }

  /**
   * A tag was clicked (or activated from the panel's style list). The
   * same tag again clears the focus; a different one replaces it — at
   * most one tag's extra artists are ever showing at once (review —
   * "clicking a tag... could bring the focus to this system... zooming
   * on that tag").
   */
  function setFocus(tag: string) {
    if (!system) return;
    const next = focusedTag === tag ? null : tag;
    focusedTag = next;
    if (next === null) expansion = [];
    place(currentNodes());
    renderPanel();
    if (next) void expandFocus(next);
  }

  /**
   * The anchor's own similarity list already holds more matches than a
   * System ever shows (`buildSystem`'s `overflow`, EXP-REQ-9). Focusing a
   * tag is the one moment worth spending a burst of lookups on: which of
   * those hidden candidates share it. Nothing here is a new similarity
   * request (EXP-PRINCIPLE-3 stays intact) — only tag lookups, and only
   * for artists the anchor was already shown to be close to.
   */
  async function expandFocus(tag: string) {
    if (!system) return;
    const token = hop;

    // First, the cheap source: candidates the anchor's own similarity
    // list already ranked but had no room for. These carry a real match
    // to the anchor, so they place properly once their tag is confirmed.
    const pool = system.overflow.filter((n) => !n.tag).slice(0, 24);
    await Promise.all(
      pool.map(async (n) => {
        const tags = await api.tags(n.name).catch(() => []);
        if (tags.length) n.tag = tags[0];
      }),
    );
    if (dead || token !== hop || focusedTag !== tag || !system) return;
    const direct = system.overflow.filter((n) => n.tag === tag);

    // That alone is often thin or empty — a tag rarely dominates the
    // anchor's own top-40 (review — "most of the time it doesn't add
    // any new artists"). So cast wider: whatever's already on screen
    // carrying this tag is itself a seed, and Last.fm's own similarity
    // data around *those* artists is exactly the same kind of lookup
    // travelling already spends one of per hop (EXP-REQ-13) — just
    // several of them, spent only at the moment of focusing, not
    // speculatively (EXP-PRINCIPLE-3). These new artists have no
    // similarity score to the anchor, so they sit at the outer rim —
    // the same treatment already given an artist kept with no known
    // match (EXP-REQ-14) — and their own tag is left for the normal
    // lazy fetch to confirm, same as any other new node, rather than
    // assumed from the seed that found them.
    const shown = new Set(
      [anchorPlaced?.node.name, ...currentNodes().map((n) => n.name), ...direct.map((n) => n.name)]
        .filter((n): n is string => !!n)
        .map(norm),
    );
    const seeds = placed
      .filter((p) => p.node.tag === tag)
      .map((p) => p.node.name)
      .slice(0, 6);
    const found = new Map<string, ExploreNode>();
    await Promise.all(
      seeds.map(async (seedName) => {
        const list = await api.similar(seedName).catch(() => []);
        for (const entry of list.slice(0, 15)) {
          const key = norm(entry.name);
          if (!key || shown.has(key) || found.has(key)) continue;
          found.set(key, describeExpansion(entry.name.trim()));
        }
      }),
    );
    if (dead || token !== hop || focusedTag !== tag || !system) return;

    const matches = [...direct, ...found.values()].slice(0, 14);
    if (!matches.length) return;
    expansion = matches;
    place(currentNodes());
    void loadEnrichment(hop, matches);
  }

  /** A second-degree candidate: known territory if it's in the Galaxy,
   * otherwise a plain Frontier node — no match to the anchor to report,
   * unlike `describe` in explore.ts, which always has one. */
  function describeExpansion(name: string): ExploreNode {
    const key = norm(name);
    const known = galaxy.get(key);
    if (known) {
      return {
        name: known.name,
        image: known.image,
        status: "galaxy",
        galaxyArtistId: known.id,
        clusterId: known.cluster >= 0 ? known.cluster : undefined,
      };
    }
    return {
      name,
      image: "",
      status: state.explored.has(key) ? "explored" : "frontier",
    };
  }

  /**
   * §13 / EXP-REQ-20 — artwork, popularity and style are all background
   * enrichment for the artists actually on screen: the System is already
   * complete and readable without any of it. Nothing is prefetched for
   * artists that merely *might* be travelled to next.
   */
  async function loadEnrichment(token: number, nodes: ExploreNode[]) {
    if (saveData) return;
    await Promise.all(
      nodes.map(async (node) => {
        const key = norm(node.name);
        await Promise.all([
          (async () => {
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
            img.src = sized(url, node === anchorPlaced?.node ? DETAIL_PX : THUMB_PX);
          })(),
          (async () => {
            if (node.listeners !== undefined) return;
            const value = await api.listeners(node.name).catch(() => 0);
            if (dead || token !== hop) return;
            applyListeners(node, value);
          })(),
          (async () => {
            if (node.tag) return;
            const found = await api.tags(node.name).catch(() => []);
            if (dead || token !== hop || !found.length) return;
            applyTag(node, found[0]);
          })(),
        ]);
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

    // Only where you started and where you are now (review — a full path
    // has no visual effect beyond the current System, so it's not worth
    // the width): the intermediate hops are still reachable one at a time
    // through Back, or all at once through Return to Galaxy.
    trailBar.append(el("span", "trail__sep", "/"));
    const here = el("span", "trail__step is-here", currentAnchor(state).name);
    here.setAttribute("aria-current", "true");
    trailBar.append(here);
  }

  /* ── the panel: the anchor, and everything around it ──────────────── */

  function renderPanel() {
    if (!panel || !system) return;
    const { anchor, neighbours } = system;
    panel.replaceChildren();
    panel.hidden = !panelOpen;

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

    // §21 — the same "zoom in on a style" the canvas offers by clicking a
    // wedge label, reachable without a pointer: one toggle button per
    // style currently on screen.
    const tags = [...new Set(placed.map((p) => p.node.tag).filter((t): t is string => !!t))]
      .sort();
    if (tags.length) {
      const tagList = el("p", "detail__tags");
      for (const tag of tags) {
        const btn = el("button", "tag-toggle" + (tag === focusedTag ? " is-active" : ""), tag);
        btn.type = "button";
        btn.setAttribute("aria-pressed", String(tag === focusedTag));
        btn.addEventListener("click", () => setFocus(tag));
        tagList.append(btn);
      }
      body.append(tagList);
    }

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
        const known = node.status === "galaxy";
        const cat = known ? "played" : "new";
        const btn = el("button", `near near--${cat}`);
        btn.type = "button";
        const bar = el("span", "near__bar");
        bar.setAttribute("aria-hidden", "true");
        const fill = el("span", "near__fill");
        fill.style.width = `${Math.round(clamp(node.match ?? 0.04, 0.04, 1) * 100)}%`;
        fill.style.background = known ? UNCLUSTERED : GREEN;
        bar.append(fill);
        btn.append(
          el("span", "near__name", node.name),
          el("span", `near__badge near__badge--${cat}`, badgeFor(node)),
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
            `${anchor.name} in Last.fm's listening data — closer means more alike. ` +
            "Size is how widely known an artist is on Last.fm, never bigger than the centre.",
        ),
      );
    }

    panel.append(art, body);
    panel.scrollTop = 0;
  }

  const badgeFor = (node: ExploreNode) =>
    node.status === "galaxy" ? "played" : "new";

  /* ── controls ─────────────────────────────────────────────────────── */

  backBtn?.addEventListener("click", () => {
    // One step back along the trail, or out of exploration entirely when
    // this is where it started (EXP-REQ-19).
    if (back(state)) host.onBack();
    else host.onExit();
  }, { signal });
  exitBtn?.addEventListener("click", () => host.onExit(), { signal });
  infoBtn?.addEventListener("click", () => {
    panelOpen = !panelOpen;
    infoBtn.setAttribute("aria-expanded", String(panelOpen));
    if (panel) panel.hidden = !panelOpen;
  }, { signal });

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
