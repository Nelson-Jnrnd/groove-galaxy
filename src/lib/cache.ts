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
} as const;

export type Kind = keyof typeof TTL;

interface Entry<T> {
  key: string;
  kind: Kind;
  value: T;
  storedAt: number;
  /** Last read, for eviction — the useful entries are the re-read ones. */
  usedAt: number;
}

/** Above this, the least recently used entries are dropped. */
const MAX_ENTRIES = 4000;

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
    s.put({ key: keyOf(kind, id), kind, value, storedAt: now, usedAt: now }),
  );
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
      if (live.length > MAX_ENTRIES) {
        live.sort((a, b) => a.usedAt - b.usedAt);
        for (const e of live.slice(0, live.length - MAX_ENTRIES)) {
          store.delete(e.key);
        }
      }
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
