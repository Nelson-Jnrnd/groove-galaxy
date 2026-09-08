/**
 * Groove Galaxy — the map.
 *
 * Renders the precomputed snapshot (see scripts/build-snapshot.mjs) onto a
 * canvas and handles pan, zoom, hover, search, selection and the keyboard
 * route through it. No layout or similarity work happens here: positions,
 * sizes, groups and neighbour lists all arrive already computed, so the
 * runtime job is purely drawing and interaction.
 */

/* ─── The snapshot's shape ───────────────────────────────────────────── */

interface Similar {
  id: number;
  score: number;
}

interface Artist {
  id: number;
  name: string;
  plays: number;
  url: string;
  image: string;
  tags: string[];
  x: number;
  y: number;
  r: number;
  cluster: number;
  similar: Similar[];
}

interface Cluster {
  id: number;
  color: string;
  label: string;
  size: number;
  anchor: string;
  plays: number;
}

interface Snapshot {
  version: number;
  generatedAt: string;
  user: string;
  profileUrl: string;
  selection: {
    period: string;
    limit: number;
    minPlays: number;
    included: number;
    totalScrobbledArtists: number;
    description: string;
  };
  stats: { artists: number; edges: number; clusters: number };
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  clusters: Cluster[];
  artists: Artist[];
  edges: [number, number, number][];
}

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

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

function agoWords(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const days = Math.floor((Date.now() - then) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  const months = Math.round(days / 30.4);
  if (months < 24) return `${months} month${months === 1 ? "" : "s"} ago`;
  return `${Math.round(months / 12)} years ago`;
}

/* ─── Entry point ────────────────────────────────────────────────────── */

export function start(): void {
  const stage = $<HTMLDivElement>("stage");
  const canvas = $<HTMLCanvasElement>("canvas");
  const veil = $<HTMLDivElement>("veil");
  const veilText = $<HTMLParagraphElement>("veil-text");
  const veilSub = $<HTMLParagraphElement>("veil-sub");

  const url = stage.dataset.snapshot || "data/snapshot.json";

  /** REQ-24: never leave a blank canvas behind — say what happened. */
  function quiet(message: string, detail?: string) {
    stage.dataset.state = "empty";
    veil.hidden = false;
    veilText.textContent = message;
    if (detail) {
      veilSub.textContent = detail;
      veilSub.hidden = false;
    }
    // The caption and method note are normally filled from the snapshot; with
    // no snapshot they would sit blank, which reads as broken rather than quiet.
    const fallback =
      "Normally: the artists I have played most on Last.fm, sized by play count and placed next to whichever artists the data says they are most alike.";
    const scope = document.getElementById("caption-scope");
    const aboutScope = document.getElementById("about-scope");
    if (scope) scope.textContent = "Nothing to map right now.";
    if (aboutScope) aboutScope.textContent = fallback;
  }

  fetch(url, { cache: "no-cache" })
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json() as Promise<Snapshot>;
    })
    .then((snap) => {
      if (!snap || !Array.isArray(snap.artists) || snap.artists.length < 3) {
        quiet(
          "Not enough listening history to draw a map yet.",
          "Come back once there are a few more scrobbles on the pile.",
        );
        return;
      }
      boot(snap, stage, canvas, veil);
    })
    .catch(() => {
      quiet(
        "Couldn't load the map just now.",
        "The snapshot of my Last.fm history didn't come back. Refreshing may help.",
      );
    });
}

/* ─── The map proper ─────────────────────────────────────────────────── */

function boot(
  snap: Snapshot,
  stage: HTMLDivElement,
  canvas: HTMLCanvasElement,
  veil: HTMLDivElement,
): void {
  const ctx = canvas.getContext("2d", { alpha: false })!;
  const artists = snap.artists;
  const byId = new Map(artists.map((a) => [a.id, a]));
  const colorOf = (a: Artist) =>
    a.cluster >= 0 && snap.clusters[a.cluster]
      ? snap.clusters[a.cluster].color
      : UNCLUSTERED;

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
    const { minX, maxX, minY, maxY } = snap.bounds;
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

  function enqueue(a: Artist, detail: boolean) {
    if (!a.image) return;
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

  /**
   * Warm every artist's thumbnail up front, so the map is illustrated
   * before anyone zooms rather than because they did. Skipped when the
   * visitor has asked their browser to save data.
   */
  function prefetchArtwork() {
    const conn = (
      navigator as Navigator & { connection?: { saveData?: boolean } }
    ).connection;
    if (conn && conn.saveData) return;
    for (const a of artists) enqueue(a, false);
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
        if (!other) continue;
        ctx.strokeStyle = `rgba(236, 233, 225, ${0.1 + s.score * 0.32})`;
        ctx.beginPath();
        ctx.moveTo(toScreenX(highlight.x), toScreenY(highlight.y));
        ctx.lineTo(toScreenX(other.x), toScreenY(other.y));
        ctx.stroke();
      }
    }

    const labels: { a: Artist; sx: number; sy: number; r: number }[] = [];

    for (const a of artists) {
      const r = a.r * view.scale;
      const sx = toScreenX(a.x);
      const sy = toScreenY(a.y);
      if (sx + r < -40 || sx - r > width + 40) continue;
      if (sy + r < -40 || sy - r > height + 40) continue;

      const isMatch = !matches || matches.has(a.id);
      const isLinked = !highlight || linked.has(a.id);
      let alpha = 1;
      if (!isMatch) alpha = 0.14;
      else if (!isLinked) alpha = 0.5;

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
        labels.push({ a, sx, sy, r });
      }
    }

    ctx.globalAlpha = 1;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (const { a, sx, sy, r } of labels) {
      const emphasised = a === selected || a === hovered || a === focused;
      ctx.font = `${emphasised ? 500 : 400} ${clamp(r * 0.34, 11, 15).toFixed(1)}px "IBM Plex Sans", system-ui, sans-serif`;
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(20, 20, 19, 0.85)";
      ctx.strokeText(a.name, sx, sy + r + 5);
      ctx.fillStyle = emphasised ? "#ece9e1" : "rgba(236, 233, 225, 0.72)";
      ctx.fillText(a.name, sx, sy + r + 5);
    }
  }

  /* ── hit testing ────────────────────────────────────────────────── */

  function hit(sx: number, sy: number): Artist | null {
    const wx = toWorldX(sx);
    const wy = toWorldY(sy);
    let best: Artist | null = null;
    let bestDepth = Infinity;
    for (const a of artists) {
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
      Math.min(width, height) / (a.r * 9),
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
  });

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

    if (e.pointerType === "mouse") setHover(hit(p.x, p.y), e.clientX, e.clientY);
  });

  function endPointer(e: PointerEvent) {
    const wasPanning = panning;
    const p = pointers.get(e.pointerId) || localPoint(e);
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchDistance = 0;
    if (pointers.size === 0) panning = false;

    // A tap, not a drag.
    if (wasPanning && movedBy < 6 && e.type === "pointerup") {
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

  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);
  canvas.addEventListener("pointerleave", () => {
    if (!panning) setHover(null);
  });

  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      // Trackpads report tiny deltas, mice report large ones; normalise.
      const step = Math.exp(-clamp(e.deltaY, -60, 60) * 0.0032);
      zoomAbout(e.clientX - rect.left, e.clientY - rect.top, step);
    },
    { passive: false },
  );

  /* ── hover tooltip (REQ-20) ─────────────────────────────────────── */

  const tip = $<HTMLDivElement>("tip");

  function setHover(a: Artist | null, clientX = 0, clientY = 0) {
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
    tip.textContent = `${a.name} · ${plural(a.plays, "play")}`;
    const rect = stage.getBoundingClientRect();
    const x = clamp(clientX - rect.left + 14, 8, rect.width - tip.offsetWidth - 8);
    const y = clamp(clientY - rect.top + 16, 8, rect.height - tip.offsetHeight - 8);
    tip.style.transform = `translate(${x}px, ${y}px)`;
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
    selected = a;
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
    if (!selected) return;
    selected = null;
    detail.hidden = true;
    detail.replaceChildren();
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
        a.cluster >= 0 && snap.clusters[a.cluster]
          ? snap.clusters[a.cluster].label
          : "no strong ties on this map",
      ),
    );

    const title = el("h2", "detail__title", a.name);

    const plays = el("p", "detail__plays");
    plays.append(
      el("strong", undefined, a.plays.toLocaleString("en-US")),
      document.createTextNode(
        ` ${a.plays === 1 ? "play" : "plays"} — ${rankLine(a)}`,
      ),
    );

    body.append(kicker, title, plays);

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

  function rankLine(a: Artist) {
    const rank = artists.filter((o) => o.plays > a.plays).length + 1;
    return `#${rank} most played of the ${artists.length} artists here`;
  }

  /* ── keyboard route through the bubbles (REQ-22) ─────────────────── */

  const a11yList = $<HTMLUListElement>("a11y-list");
  const a11yButtons = new Map<number, HTMLButtonElement>();

  {
    const frag = document.createDocumentFragment();
    // Heaviest first, so tabbing starts somewhere meaningful.
    for (const a of [...artists].sort((x, y) => y.plays - x.plays)) {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.setAttribute("aria-pressed", "false");
      const group =
        a.cluster >= 0 && snap.clusters[a.cluster]
          ? `, in the ${snap.clusters[a.cluster].label} group`
          : ", not close to any group";
      btn.textContent = `${a.name}, ${plural(a.plays, "play")}${group}`;
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
        li.append(el("span", "finder__plays", plural(a.plays, "play")));
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

  search.addEventListener("input", runSearch);
  search.addEventListener("focus", () => {
    if (search.value.trim()) runSearch();
  });
  search.addEventListener("blur", () => window.setTimeout(closeResults, 120));
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
  });

  /* ── zoom / reset controls (REQ-17, REQ-18) ─────────────────────── */

  $<HTMLButtonElement>("zoom-in").addEventListener("click", () =>
    zoomAbout(width / 2, height / 2, 1.45),
  );
  $<HTMLButtonElement>("zoom-out").addEventListener("click", () =>
    zoomAbout(width / 2, height / 2, 1 / 1.45),
  );
  $<HTMLButtonElement>("reset").addEventListener("click", () => {
    matches = null;
    search.value = "";
    closeResults();
    resetView();
  });

  window.addEventListener("keydown", (e) => {
    const inField =
      e.target instanceof HTMLElement &&
      (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA");
    if (e.key === "Escape") {
      if (selected) deselect();
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
  });

  /* ── legend (OQ-4/OQ-8) ─────────────────────────────────────────── */

  const legend = $<HTMLDivElement>("legend");
  const legendToggle = $<HTMLButtonElement>("legend-toggle");
  const legendBody = $<HTMLDivElement>("legend-body");
  const legendList = $<HTMLUListElement>("legend-list");

  if (snap.clusters.length) {
    legend.hidden = false;
    for (const c of snap.clusters) {
      const li = el("li", "legend__item");
      const btn = el("button", "legend__btn");
      btn.type = "button";
      const dot = el("span", "legend__dot");
      dot.style.background = c.color;
      dot.setAttribute("aria-hidden", "true");
      btn.append(dot, el("span", "legend__label", c.label));
      btn.append(el("span", "legend__count", String(c.size)));
      btn.title = `${c.size} artists, anchored by ${c.anchor}`;
      btn.setAttribute(
        "aria-label",
        `Highlight the ${c.label} group — ${c.size} artists, most played is ${c.anchor}`,
      );
      btn.addEventListener("click", () => {
        const ids = artists.filter((a) => a.cluster === c.id).map((a) => a.id);
        const already = matches && ids.every((id) => matches!.has(id)) &&
          matches!.size === ids.length;
        matches = already ? null : new Set(ids);
        legendList.querySelectorAll(".legend__btn").forEach((b) => {
          b.classList.remove("is-on");
        });
        if (!already) btn.classList.add("is-on");
        draw();
      });
      li.append(btn);
      legendList.append(li);
    }
    // Roomy screens can afford the legend open; it is what explains the
    // colours, and a collapsed panel just hides that.
    if (window.matchMedia("(min-width: 60rem)").matches) {
      legendToggle.setAttribute("aria-expanded", "true");
      legendBody.hidden = false;
    }
    legendToggle.addEventListener("click", () => {
      const open = legendToggle.getAttribute("aria-expanded") === "true";
      legendToggle.setAttribute("aria-expanded", open ? "false" : "true");
      legendBody.hidden = open;
    });
  }

  /* ── caption + method note (REQ-3, REQ-25) ──────────────────────── */

  $<HTMLParagraphElement>("caption-scope").textContent =
    snap.selection.description;
  $<HTMLElement>("about-scope").textContent = snap.selection.description;

  const asOf = formatDate(snap.generatedAt);
  const ago = agoWords(snap.generatedAt);
  $<HTMLSpanElement>("caption-asof").textContent = asOf
    ? `Snapshot as of ${asOf}`
    : "Snapshot date unknown";
  $<HTMLElement>("about-fresh").textContent = asOf
    ? `This is a snapshot, not a live feed — it was taken on ${asOf} (${ago}) and is rebuilt from Last.fm on a schedule. A track played this morning won't be on it.`
    : "This is a snapshot rebuilt from Last.fm on a schedule, not a live feed.";

  const profile = $<HTMLAnchorElement>("about-profile");
  profile.href = snap.profileUrl;
  profile.textContent = `${snap.user} on Last.fm ↗`;

  const aboutToggle = $<HTMLButtonElement>("about-toggle");
  const about = $<HTMLElement>("about");
  aboutToggle.addEventListener("click", () => {
    const open = aboutToggle.getAttribute("aria-expanded") === "true";
    aboutToggle.setAttribute("aria-expanded", open ? "false" : "true");
    about.hidden = open;
    if (!open) about.scrollIntoView({ behavior: "smooth", block: "nearest" });
  });

  /* ── go ─────────────────────────────────────────────────────────── */

  const observer = new ResizeObserver(resize);
  observer.observe(stage);
  window.addEventListener("orientationchange", () =>
    window.setTimeout(resize, 200),
  );

  resize();
  prefetchArtwork();
  stage.dataset.state = "ready";
  veil.hidden = true;
  canvas.style.cursor = "grab";
}
