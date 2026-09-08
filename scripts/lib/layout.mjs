/**
 * Turning an artist-similarity graph into 2D coordinates.
 *
 * Two stages, both deterministic (fixed seed → identical snapshot for
 * identical input, so a re-run doesn't reshuffle the map for no reason):
 *
 *   1. classical MDS on graph-hop distances, for global structure;
 *   2. a force simulation (attraction along similarity edges, global
 *      repulsion, weak gravity) that refines it and separates bubbles.
 *
 * Neither stage assigns any meaning to the resulting x/y axes — the output is
 * rotation-arbitrary, and only *relative distance* is claimed to mean
 * anything (SPEC REQ-11 / G7).
 */

/** Small deterministic PRNG (mulberry32). */
export function rng(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Adjacency lists (index → [{j, w}]) from a flat edge list. */
export function adjacency(n, edges) {
  const adj = Array.from({ length: n }, () => []);
  for (const { a, b, w } of edges) {
    adj[a].push({ j: b, w });
    adj[b].push({ j: a, w });
  }
  return adj;
}

/** Unweighted BFS hop distance from `src` over the adjacency lists. */
function hops(adj, src, out) {
  out.fill(-1);
  out[src] = 0;
  const queue = [src];
  for (let head = 0; head < queue.length; head++) {
    const u = queue[head];
    const d = out[u] + 1;
    for (const { j } of adj[u]) {
      if (out[j] === -1) {
        out[j] = d;
        queue.push(j);
      }
    }
  }
  return out;
}

/**
 * Classical multidimensional scaling on the hop-distance matrix, solved by
 * power iteration for the top two eigenvectors. Disconnected pairs get a
 * distance beyond the graph's diameter so isolated artists drift outward
 * instead of piling on the origin or vanishing (REQ-12).
 */
export function mdsSeed(n, adj, seed = 1) {
  if (n === 0) return [];
  const dist = new Float64Array(n * n);
  const row = new Int32Array(n);
  let diameter = 1;
  for (let i = 0; i < n; i++) {
    hops(adj, i, row);
    for (let j = 0; j < n; j++) {
      const d = row[j];
      if (d > diameter) diameter = d;
      dist[i * n + j] = d; // -1 (unreachable) is patched below
    }
  }
  const far = diameter * 1.6;
  for (let k = 0; k < dist.length; k++) if (dist[k] < 0) dist[k] = far;

  // Double-centre the squared distances: B = -0.5 · J D² J.
  const sq = new Float64Array(n * n);
  for (let k = 0; k < sq.length; k++) sq[k] = dist[k] * dist[k];
  const rowMean = new Float64Array(n);
  let grand = 0;
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < n; j++) s += sq[i * n + j];
    rowMean[i] = s / n;
    grand += s;
  }
  grand /= n * n;
  const B = sq; // reuse the buffer
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      B[i * n + j] = -0.5 * (sq[i * n + j] - rowMean[i] - rowMean[j] + grand);
    }
  }

  const random = rng(seed);
  const vectors = [];
  for (let comp = 0; comp < 2; comp++) {
    let v = new Float64Array(n);
    for (let i = 0; i < n; i++) v[i] = random() * 2 - 1;
    let eigenvalue = 0;
    for (let iter = 0; iter < 200; iter++) {
      // Deflate against the components already found.
      for (const { vec, val } of vectors) {
        let dot = 0;
        for (let i = 0; i < n; i++) dot += v[i] * vec[i];
        for (let i = 0; i < n; i++) v[i] -= dot * vec[i];
        void val;
      }
      const next = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        let s = 0;
        const off = i * n;
        for (let j = 0; j < n; j++) s += B[off + j] * v[j];
        next[i] = s;
      }
      let norm = 0;
      for (let i = 0; i < n; i++) norm += next[i] * next[i];
      norm = Math.sqrt(norm);
      if (norm < 1e-12) break;
      for (let i = 0; i < n; i++) next[i] /= norm;
      eigenvalue = norm;
      v = next;
    }
    vectors.push({ vec: v, val: eigenvalue });
  }

  const points = [];
  for (let i = 0; i < n; i++) {
    const sx = Math.sqrt(Math.max(vectors[0].val, 0));
    const sy = Math.sqrt(Math.max(vectors[1].val, 0));
    points.push({
      x: vectors[0].vec[i] * sx,
      y: vectors[1].vec[i] * sy,
    });
  }
  return points;
}

/**
 * Force-directed refinement.
 *
 * @param {{x:number,y:number}[]} points  starting positions (mutated copy returned)
 * @param {number[]} radii                bubble radii, in the same units
 * @param {{a:number,b:number,w:number}[]} edges
 * @param {object} [opts]
 */
export function forceLayout(points, radii, edges, opts = {}) {
  const {
    iterations = 900,
    seed = 7,
    gravity = 0.012,
    repulsion = 1.0,
    attraction = 1.0,
    padding = 6,
  } = opts;

  const n = points.length;
  if (n === 0) return [];
  const random = rng(seed);

  // Work in a space scaled to the bubbles: k is the "natural" edge length.
  const meanRadius = radii.reduce((s, r) => s + r, 0) / n;
  const k = meanRadius * 6;

  // Normalise the seed into a disc of a sensible size, jittering coincident
  // points so repulsion has a direction to push along.
  let spanX = 0;
  let spanY = 0;
  for (const p of points) {
    spanX = Math.max(spanX, Math.abs(p.x));
    spanY = Math.max(spanY, Math.abs(p.y));
  }
  const span = Math.max(spanX, spanY, 1e-9);
  const target = k * Math.sqrt(n) * 0.5;
  const pos = points.map((p) => ({
    x: (p.x / span) * target + (random() - 0.5) * meanRadius,
    y: (p.y / span) * target + (random() - 0.5) * meanRadius,
  }));

  const fx = new Float64Array(n);
  const fy = new Float64Array(n);
  let temperature = k * 1.2;
  const cool = Math.pow(0.02, 1 / iterations);

  for (let iter = 0; iter < iterations; iter++) {
    fx.fill(0);
    fy.fill(0);

    // Repulsion — every pair. n is a few hundred (REQ-2 cutoff), so the
    // O(n²) inner loop is a few tens of ms per iteration at build time.
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = pos[i].x - pos[j].x;
        let dy = pos[i].y - pos[j].y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1e-9) {
          dx = (random() - 0.5) * 0.01;
          dy = (random() - 0.5) * 0.01;
          d2 = dx * dx + dy * dy;
        }
        const d = Math.sqrt(d2);
        // Fruchterman–Reingold repulsion, stiffened once bubbles touch so
        // they end up side by side rather than overlapping.
        const touch = radii[i] + radii[j] + padding;
        let f = (repulsion * k * k) / d;
        if (d < touch) f += (touch - d) * k * 0.6;
        const ux = dx / d;
        const uy = dy / d;
        fx[i] += ux * f;
        fy[i] += uy * f;
        fx[j] -= ux * f;
        fy[j] -= uy * f;
      }
    }

    // Attraction along similarity edges, scaled by the similarity weight.
    for (const { a, b, w } of edges) {
      const dx = pos[a].x - pos[b].x;
      const dy = pos[a].y - pos[b].y;
      const d = Math.hypot(dx, dy) || 1e-6;
      const f = (attraction * w * d * d) / k;
      const ux = (dx / d) * f;
      const uy = (dy / d) * f;
      fx[a] -= ux;
      fy[a] -= uy;
      fx[b] += ux;
      fy[b] += uy;
    }

    // Weak pull to the origin — keeps components that share no edge from
    // flying apart forever, without collapsing them together.
    for (let i = 0; i < n; i++) {
      fx[i] -= pos[i].x * gravity * k * 0.05;
      fy[i] -= pos[i].y * gravity * k * 0.05;
    }

    for (let i = 0; i < n; i++) {
      const d = Math.hypot(fx[i], fy[i]) || 1e-9;
      const step = Math.min(d, temperature);
      pos[i].x += (fx[i] / d) * step;
      pos[i].y += (fy[i] / d) * step;
    }
    temperature *= cool;
  }

  // Final overlap relaxation: nudge any bubbles still intersecting apart.
  for (let pass = 0; pass < 60; pass++) {
    let moved = 0;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = pos[j].x - pos[i].x;
        const dy = pos[j].y - pos[i].y;
        const need = radii[i] + radii[j] + padding;
        const d = Math.hypot(dx, dy) || 1e-6;
        if (d >= need) continue;
        const push = (need - d) / 2;
        const ux = dx / d;
        const uy = dy / d;
        pos[i].x -= ux * push;
        pos[i].y -= uy * push;
        pos[j].x += ux * push;
        pos[j].y += uy * push;
        moved++;
      }
    }
    if (!moved) break;
  }

  // Centre on the centroid so the default viewport (REQ-18) is the middle.
  let cx = 0;
  let cy = 0;
  for (const p of pos) {
    cx += p.x;
    cy += p.y;
  }
  cx /= n;
  cy /= n;
  for (const p of pos) {
    p.x -= cx;
    p.y -= cy;
  }
  return pos;
}

/**
 * Label propagation over the weighted similarity graph — the emergent
 * grouping behind cluster colour. Deterministic: nodes are visited in a
 * fixed shuffled order and ties break on the lowest label.
 *
 * Nothing here reads a genre, a tag or any human-authored category; the
 * groups fall out of who-is-similar-to-whom alone (REQ-10).
 */
export function labelPropagation(n, adj, { seed = 11, rounds = 60 } = {}) {
  const labels = new Int32Array(n);
  for (let i = 0; i < n; i++) labels[i] = i;

  const order = Array.from({ length: n }, (_, i) => i);
  const random = rng(seed);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }

  for (let round = 0; round < rounds; round++) {
    let changed = 0;
    for (const i of order) {
      if (!adj[i].length) continue;
      const scores = new Map();
      for (const { j, w } of adj[i]) {
        scores.set(labels[j], (scores.get(labels[j]) || 0) + w);
      }
      let best = labels[i];
      let bestScore = -Infinity;
      for (const [label, score] of scores) {
        if (score > bestScore || (score === bestScore && label < best)) {
          best = label;
          bestScore = score;
        }
      }
      if (best !== labels[i]) {
        labels[i] = best;
        changed++;
      }
    }
    if (!changed) break;
  }
  return labels;
}
