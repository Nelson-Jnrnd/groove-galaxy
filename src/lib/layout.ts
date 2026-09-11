/**
 * Turning an artist-similarity graph into 2D coordinates, in the browser.
 *
 * Two stages, both deterministic (fixed seed → the same map for the same
 * listening history, so a reload doesn't reshuffle it):
 *
 *   1. classical MDS on graph-hop distances, for global structure;
 *   2. a force simulation (attraction along similarity edges, global
 *      repulsion, weak gravity) that refines it and separates bubbles.
 *
 * Neither stage assigns any meaning to the resulting x/y axes — the output
 * is rotation-arbitrary, and only *relative distance* is claimed to mean
 * anything (SPEC REQ-11 / G7).
 *
 * The difference from a build-time version is that the force stage is a
 * stepper rather than a loop: the map is on screen while it is still
 * settling, so it has to yield the thread back between passes.
 */

export interface Point {
  x: number;
  y: number;
}

export interface Edge {
  a: number;
  b: number;
  w: number;
}

export interface Neighbour {
  j: number;
  w: number;
}

/** Small deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
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
export function adjacency(n: number, edges: Edge[]): Neighbour[][] {
  const adj: Neighbour[][] = Array.from({ length: n }, () => []);
  for (const { a, b, w } of edges) {
    adj[a].push({ j: b, w });
    adj[b].push({ j: a, w });
  }
  return adj;
}

/** Unweighted BFS hop distance from `src` over the adjacency lists. */
function hops(adj: Neighbour[][], src: number, out: Int32Array): Int32Array {
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
export function mdsSeed(n: number, adj: Neighbour[][], seed = 1): Point[] {
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
  const vectors: { vec: Float64Array; val: number }[] = [];
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

  const points: Point[] = [];
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
 * Louvain community detection over the weighted similarity graph — the
 * emergent grouping behind cluster colour. Each pass moves every node into
 * whichever neighbouring community raises modularity the most (edge weight
 * inside communities relative to what the nodes' degrees alone would
 * predict), then collapses each community into one node of a smaller graph
 * and repeats — so it keeps merging at coarser and coarser scales for as
 * long as merging is still an improvement, rather than settling on
 * whatever first, single-scale grouping a flatter algorithm finds.
 * Deterministic: nodes are visited in a fixed shuffled order and ties break
 * on the lowest community id.
 *
 * Nothing here reads a genre, a tag or any human-authored category; the
 * groups fall out of who-is-similar-to-whom alone (REQ-10).
 */
export function louvain(
  n: number,
  adj: Neighbour[][],
  { seed = 11 }: { seed?: number } = {},
): Int32Array {
  const membership = new Int32Array(n);
  for (let i = 0; i < n; i++) membership[i] = i;
  if (n === 0) return membership;

  const random = rng(seed);
  let levelAdj = adj;
  let levelN = n;
  let levelSelf: Float64Array = new Float64Array(n);

  // Each pass works on a smaller graph than the last (one node per
  // community found so far), so this converges quickly even though the
  // cap looks generous relative to the original artist count.
  for (let level = 0; level < 20; level++) {
    const localLabels = localMove(levelN, levelAdj, levelSelf, random);

    const compact = new Map<number, number>();
    for (const label of localLabels) {
      if (!compact.has(label)) compact.set(label, compact.size);
    }
    for (let i = 0; i < n; i++) {
      membership[i] = compact.get(localLabels[membership[i]])!;
    }
    if (compact.size === levelN) break; // nothing merged this pass

    const next = aggregate(levelN, levelAdj, levelSelf, localLabels, compact);
    levelAdj = next.adj;
    levelSelf = next.self;
    levelN = compact.size;
  }

  return membership;
}

/**
 * One Louvain local-moving phase: repeatedly relocate each node to whichever
 * community (its own current one, or a neighbour's) most increases
 * modularity, until a full pass moves nothing.
 */
function localMove(
  n: number,
  adj: Neighbour[][],
  selfWeight: Float64Array,
  random: () => number,
): Int32Array {
  const label = new Int32Array(n);
  const degree = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    label[i] = i;
    let d = 2 * selfWeight[i];
    for (const { w } of adj[i]) d += w;
    degree[i] = d;
  }
  // Σ_tot per community, communities keyed by the node id that seeded them.
  const commWeight = degree.slice();
  const twoM = degree.reduce((s, d) => s + d, 0) || 1;

  const order = Array.from({ length: n }, (_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }

  for (let pass = 0; pass < 40; pass++) {
    let moved = 0;
    for (const i of order) {
      const current = label[i];
      commWeight[current] -= degree[i];

      const linkTo = new Map<number, number>();
      for (const { j, w } of adj[i]) {
        linkTo.set(label[j], (linkTo.get(label[j]) || 0) + w);
      }

      let best = current;
      let bestGain =
        (linkTo.get(current) || 0) - (degree[i] * commWeight[current]) / twoM;
      for (const [comm, weight] of linkTo) {
        if (comm === current) continue;
        const gain = weight - (degree[i] * commWeight[comm]) / twoM;
        if (gain > bestGain || (gain === bestGain && comm < best)) {
          best = comm;
          bestGain = gain;
        }
      }

      commWeight[best] += degree[i];
      if (best !== current) {
        label[i] = best;
        moved++;
      }
    }
    if (!moved) break;
  }
  return label;
}

/**
 * Collapse the communities `localMove` found into single nodes: internal
 * edges become self-weight (kept for the next level's modularity maths),
 * and edges crossing communities are summed onto the pair of new nodes.
 */
function aggregate(
  n: number,
  adj: Neighbour[][],
  selfWeight: Float64Array,
  label: Int32Array,
  compact: Map<number, number>,
): { adj: Neighbour[][]; self: Float64Array } {
  const size = compact.size;
  const self = new Float64Array(size);
  const cross = new Map<string, number>();

  for (let i = 0; i < n; i++) {
    const ci = compact.get(label[i])!;
    self[ci] += selfWeight[i];
    for (const { j, w } of adj[i]) {
      if (j <= i) continue; // each undirected edge counted from one side only
      const cj = compact.get(label[j])!;
      if (ci === cj) {
        self[ci] += w;
      } else {
        const key = ci < cj ? `${ci}:${cj}` : `${cj}:${ci}`;
        cross.set(key, (cross.get(key) || 0) + w);
      }
    }
  }

  const nextAdj: Neighbour[][] = Array.from({ length: size }, () => []);
  for (const [key, w] of cross) {
    const [a, b] = key.split(":").map(Number);
    nextAdj[a].push({ j: b, w });
    nextAdj[b].push({ j: a, w });
  }
  return { adj: nextAdj, self };
}

/**
 * The force stage, as a stepper.
 *
 * Same forces as a batch Fruchterman–Reingold run — repulsion between every
 * pair, attraction along similarity edges, weak gravity toward the middle —
 * but `step()` does a bounded amount of work and returns, so the caller can
 * render between passes and the map visibly settles instead of appearing
 * fully formed after a freeze.
 *
 * Nodes and edges can be added while it is running: the map starts with
 * every artist and no edges at all, and the edges arrive over the next few
 * seconds as Last.fm answers.
 */
export class ForceLayout {
  readonly pos: Point[] = [];
  private radii: number[] = [];
  private edges: Edge[] = [];
  private fx = new Float64Array(0);
  private fy = new Float64Array(0);
  private temperature = 0;
  private k = 1;
  private random = rng(7);
  private cooled = 0;

  private readonly iterations: number;
  private readonly gravity: number;
  private readonly padding: number;

  constructor(iterations = 900, gravity = 0.6, padding = 6) {
    this.iterations = iterations;
    this.gravity = gravity;
    this.padding = padding;
  }

  /** Seed positions and sizes. Safe to call again as artists arrive. */
  reset(points: Point[], radii: number[]) {
    const n = points.length;
    this.radii = radii;
    const meanRadius = radii.reduce((s, r) => s + r, 0) / (n || 1);
    this.k = meanRadius * 6;

    let span = 1e-9;
    for (const p of points) {
      span = Math.max(span, Math.abs(p.x), Math.abs(p.y));
    }
    const target = this.k * Math.sqrt(n) * 0.5;
    this.pos.length = 0;
    for (const p of points) {
      this.pos.push({
        x: (p.x / span) * target + (this.random() - 0.5) * meanRadius,
        y: (p.y / span) * target + (this.random() - 0.5) * meanRadius,
      });
    }
    this.fx = new Float64Array(n);
    this.fy = new Float64Array(n);
    this.temperature = this.k * 1.2;
    this.cooled = 0;
  }

  setEdges(edges: Edge[]) {
    this.edges = edges;
    // New information — let the map loosen up enough to act on it, without
    // throwing away the arrangement it has already found.
    this.temperature = Math.max(this.temperature, this.k * 0.35);
  }

  get settled() {
    return this.cooled >= this.iterations;
  }

  /** Fraction of the way to a settled layout, for the progress readout. */
  get progress() {
    return Math.min(this.cooled / this.iterations, 1);
  }

  /** Run passes until `budgetMs` is spent. Returns how many it managed. */
  step(budgetMs = 8): number {
    const started = performance.now();
    let passes = 0;
    const cool = Math.pow(0.02, 1 / this.iterations);
    while (
      this.cooled < this.iterations &&
      performance.now() - started < budgetMs
    ) {
      this.pass();
      this.temperature *= cool;
      this.cooled++;
      passes++;
    }
    if (this.settled) this.separate(4);
    return passes;
  }

  private pass() {
    const { pos, radii, fx, fy, k } = this;
    const n = pos.length;
    fx.fill(0);
    fy.fill(0);

    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = pos[i].x - pos[j].x;
        let dy = pos[i].y - pos[j].y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1e-9) {
          dx = (this.random() - 0.5) * 0.01;
          dy = (this.random() - 0.5) * 0.01;
          d2 = dx * dx + dy * dy;
        }
        const d = Math.sqrt(d2);
        const touch = radii[i] + radii[j] + this.padding;
        let f = (k * k) / d;
        if (d < touch) f += (touch - d) * k * 0.6;
        const ux = dx / d;
        const uy = dy / d;
        fx[i] += ux * f;
        fy[i] += uy * f;
        fx[j] -= ux * f;
        fy[j] -= uy * f;
      }
    }

    for (const { a, b, w } of this.edges) {
      const dx = pos[a].x - pos[b].x;
      const dy = pos[a].y - pos[b].y;
      const d = Math.hypot(dx, dy) || 1e-6;
      const f = (w * d * d) / k;
      const ux = (dx / d) * f;
      const uy = (dy / d) * f;
      fx[a] -= ux;
      fy[a] -= uy;
      fx[b] += ux;
      fy[b] += uy;
    }

    for (let i = 0; i < n; i++) {
      fx[i] -= pos[i].x * this.gravity * k * 0.05;
      fy[i] -= pos[i].y * this.gravity * k * 0.05;
    }

    for (let i = 0; i < n; i++) {
      const d = Math.hypot(fx[i], fy[i]) || 1e-9;
      const step = Math.min(d, this.temperature);
      pos[i].x += (fx[i] / d) * step;
      pos[i].y += (fy[i] / d) * step;
    }
  }

  /** Nudge any still-overlapping bubbles apart. */
  private separate(passes: number) {
    const { pos, radii } = this;
    const n = pos.length;
    for (let pass = 0; pass < passes; pass++) {
      let moved = 0;
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const dx = pos[j].x - pos[i].x;
          const dy = pos[j].y - pos[i].y;
          const need = radii[i] + radii[j] + this.padding;
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
  }

  /** Recentre on the centroid, so the default view is the middle of the map. */
  centre() {
    const n = this.pos.length;
    if (!n) return;
    let cx = 0;
    let cy = 0;
    for (const p of this.pos) {
      cx += p.x;
      cy += p.y;
    }
    cx /= n;
    cy /= n;
    for (const p of this.pos) {
      p.x -= cx;
      p.y -= cy;
    }
  }
}

/**
 * A phyllotaxis spiral — the arrangement every artist starts in, before any
 * similarity has arrived. It fills a disc evenly with no clumping, so the
 * very first frame already looks like a map rather than a pile.
 */
export function spiral(n: number, spacing: number): Point[] {
  const golden = Math.PI * (3 - Math.sqrt(5));
  const points: Point[] = [];
  for (let i = 0; i < n; i++) {
    const r = spacing * Math.sqrt(i + 0.5);
    const a = i * golden;
    points.push({ x: Math.cos(a) * r, y: Math.sin(a) * r });
  }
  return points;
}
