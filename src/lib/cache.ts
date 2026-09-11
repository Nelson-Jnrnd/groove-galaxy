/**
 * A small persistent cache for Last.fm responses.
 *
 * The point of it is one observation: **similarity is not personal.** That
 * Daft Punk is close to Justice is true of everybody's map, so those entries
 * are worth keeping for a long time and are equally useful to whoever's
 * listening history is being drawn next. The same goes for an artist's tags
 * and their cover art. Only the play counts belong to one person, and those
 * are the one thing that goes stale quickly.
 *
 * So entries are filed by kind, each kind with its own lifetime, in
 * IndexedDB — localStorage is synchronous (it would jank the map mid-layout)
 * and caps out around 5 MB, which a few hundred artists can approach.
 *
 * Everything degrades quietly: private-browsing modes, disabled storage and
 * eviction all end up at "no cached value", which is a cache miss and
 * nothing worse.
 */

const DB_NAME = "groove-galaxy";
/** Bump to invalidate every cached entry after a shape change. */
const DB_VERSION = 1;
const STORE = "lastfm";

/** How long each kind of entry stays trustworthy. */
export const TTL = {
  /** Who sounds like whom barely moves, and is the expensive thing to fetch. */
  similar: 30 * 24 * 3600e3,
  /** Tags drift slowly and only decide a group's name. */
  tags: 30 * 24 * 3600e3,
  /** An artist's cover art changes about as often as their discography. */
  art: 30 * 24 * 3600e3,
  /** Play counts are the whole point of the map being current. */
  top: 6 * 3600e3,
  /**
   * Which weeks Last.fm has charts for. It grows by one entry a week, so a
   * day-old copy is wrong only about the week currently in progress.
   */
  charts: 24 * 3600e3,
  /**
   * A weekly chart whose week has ended can never change again (TE-REQ-19),
   * so this is "forever" in every sense that matters to a browser cache —
   * the LRU sweep will reclaim it long before it expires.
   */
  chart: 10 * 365 * 24 * 3600e3,
  /** …whereas the week in progress is still being scrobbled into. */
  chartLive: 30 * 60e3,
  /**
   * A whole year, already added up out of its weeks. Derived rather than
   * fetched, but derived from weeks that can never change again — so it is
   * worth keeping for the same long time, and it saves re-reading and
   * re-summing fifty-two entries to learn the same thing twice.
   */
  frame: 10 * 365 * 24 * 3600e3,
  /**
   * When an account's listening started. It can only ever move earlier by
   * someone importing old scrobbles, and a week either way costs nothing, so
   * a week is a fine life for it.
   */
  first: 7 * 24 * 3600e3,
} as const;

export type Kind = keyof typeof TTL;

export interface Entry<T> {
  key: string;
  kind: Kind;
  value: T;
  storedAt: number;
  /** Last read, for eviction — the useful entries are the re-read ones. */
  usedAt: number;
  /** Roughly how much room this takes, measured when it was written. */
  bytes?: number;
}

/**
 * What a cached entry is worth keeping, highest first.
 *
 * Counting entries alone treats a 40-name similarity list and a 15 kB weekly
 * chart as the same thing, and least-recently-used alone would let one
 * account's decade of history evict the similarity data every map in this
 * browser is built on — which costs one cheap request to refetch versus three
 * hundred expensive ones. So eviction spends the cheap entries first.
 */
const KEEP: Record<Kind, number> = {
  /** The week in progress is stale within the hour anyway. */
  chartLive: 0,
  /** One request each, and once a year has been added up, redundant. */
  chart: 1,
  /** One request each, and the ones that must stay current regardless. */
  top: 2,
  charts: 2,
  /** Two requests, and it saves hundreds of them. */
  first: 5,
  /** Enrichment: a map is perfectly usable without it. */
  art: 3,
  tags: 4,
  /** Fifty-two charts, already added up. */
  frame: 5,
  /** The expensive one, and the same answer for every account. */
  similar: 6,
};

/**
 * Two budgets, because entries differ in size by two orders of magnitude. A
 * single account's timeline is already ~1,100 weekly charts, so the old
 * 4,000-entry ceiling was one account away from evicting everything else.
 */
const MAX_ENTRIES = 8000;
const MAX_BYTES = 40 * 1024 * 1024;
/** What to assume for entries written before sizes were recorded. */
const ASSUMED_BYTES = 2048;

let dbPromise: Promise<IDBDatabase | null> | null = null;

function open(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null); // storage disabled entirely
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      // A version bump means the shape changed, so start clean rather than
      // trying to migrate cached third-party payloads.
      if (db.objectStoreNames.contains(STORE)) db.deleteObjectStore(STORE);
      const store = db.createObjectStore(STORE, { keyPath: "key" });
      store.createIndex("usedAt", "usedAt");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
  return dbPromise;
}

function idb<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest,
): Promise<T | null> {
  return open().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) return resolve(null);
        let request: IDBRequest;
        try {
          request = run(db.transaction(STORE, mode).objectStore(STORE));
        } catch {
          return resolve(null);
        }
        request.onsuccess = () => resolve(request.result as T);
        request.onerror = () => resolve(null);
      }),
  );
}

const keyOf = (kind: Kind, id: string) =>
  `${kind}:${id.toLowerCase().normalize("NFKD")}`;

/** Counters, so the page can be honest about where its data came from. */
export const stats = { hits: 0, misses: 0, writes: 0 };

export async function get<T>(kind: Kind, id: string): Promise<T | null> {
  const key = keyOf(kind, id);
  const entry = await idb<Entry<T>>("readonly", (s) => s.get(key));
  if (!entry || Date.now() - entry.storedAt > TTL[kind]) {
    stats.misses++;
    return null;
  }
  stats.hits++;
  // Touch in the background; a stale usedAt only costs eviction accuracy.
  void idb("readwrite", (s) => s.put({ ...entry, usedAt: Date.now() }));
  return entry.value;
}

export async function set<T>(kind: Kind, id: string, value: T): Promise<void> {
  stats.writes++;
  const now = Date.now();
  await idb("readwrite", (s) =>
    s.put({
      key: keyOf(kind, id),
      kind,
      value,
      storedAt: now,
      usedAt: now,
      bytes: sizeOf(value),
    }),
  );
}

/**
 * A rough byte count for the eviction budget. Stringifying is cheap next to
 * the request that produced the value, and being wrong by a factor of two
 * here only shifts when housekeeping runs.
 */
function sizeOf(value: unknown): number {
  try {
    return JSON.stringify(value, (_k, v) =>
      v instanceof Map ? [...v] : v,
    ).length;
  } catch {
    return ASSUMED_BYTES;
  }
}

/**
 * Which entries to drop to get back inside both budgets: cheapest kind
 * first, and within a kind the least recently used. Pure, so the policy can
 * be tested without a browser.
 */
export function evictionOrder(
  entries: Entry<unknown>[],
  { maxEntries = MAX_ENTRIES, maxBytes = MAX_BYTES } = {},
): string[] {
  let count = entries.length;
  let bytes = entries.reduce((s, e) => s + (e.bytes ?? ASSUMED_BYTES), 0);
  if (count <= maxEntries && bytes <= maxBytes) return [];

  const order = [...entries].sort(
    (a, b) => KEEP[a.kind] - KEEP[b.kind] || a.usedAt - b.usedAt,
  );
  const doomed: string[] = [];
  for (const e of order) {
    if (count <= maxEntries && bytes <= maxBytes) break;
    doomed.push(e.key);
    count--;
    bytes -= e.bytes ?? ASSUMED_BYTES;
  }
  return doomed;
}

/**
 * Drop expired entries, then the least recently used ones if the store is
 * still over budget. Called once per load, after the map is interactive —
 * it is housekeeping, never something a visitor waits for.
 */
export async function sweep(): Promise<void> {
  const db = await open();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const store = db.transaction(STORE, "readwrite").objectStore(STORE);
    const all = store.getAll();
    all.onerror = () => resolve();
    all.onsuccess = () => {
      const entries = (all.result || []) as Entry<unknown>[];
      const now = Date.now();
      const live: Entry<unknown>[] = [];
      for (const e of entries) {
        if (now - e.storedAt > (TTL[e.kind] ?? 0)) store.delete(e.key);
        else live.push(e);
      }
      for (const key of evictionOrder(live)) store.delete(key);
      resolve();
    };
  });
}

/** For the method note: how much of this map came out of the cache. */
export function summary(): string {
  const total = stats.hits + stats.misses;
  // Nothing to say on a first visit; "0 of 301" is noise, not information.
  if (!total || !stats.hits) return "";
  return stats.hits === total
    ? "served entirely from this browser's cache"
    : `${stats.hits} of ${total} lookups came from this browser's cache`;
}
