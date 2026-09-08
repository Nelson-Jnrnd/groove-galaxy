/**
 * Minimal Last.fm REST client for the snapshot build.
 *
 * Everything here runs at build/snapshot time, never in a visitor's browser,
 * so it is the one place that has to be careful about Last.fm's terms and
 * rate limits (REQ-31): calls are serialised behind a fixed delay, retried
 * with backoff on 429/5xx, and cached on disk so re-running the layout does
 * not re-hit the API.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

const ENDPOINT = "https://ws.audioscrobbler.com/2.0/";

/** Last.fm serves this image hash when there is no real art. Same constant
 *  the personal site's /music page uses (REQ-7). */
export const PLACEHOLDER = "2a96cbd8b46e442fc41c2b86b821562f";

/** Pick the largest usable image URL, or "" if there is none / only the
 *  placeholder. Mirrors `coverUrl()` in the personal site's music.astro. */
export function pickImage(images) {
  if (!Array.isArray(images)) return "";
  for (let i = images.length - 1; i >= 0; i--) {
    const url = images[i] && images[i]["#text"];
    if (url && !url.includes(PLACEHOLDER)) return url;
  }
  return "";
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class LastFm {
  /**
   * @param {object} opts
   * @param {string} opts.apiKey
   * @param {string} [opts.cacheDir]  disk cache location ("" disables it)
   * @param {number} [opts.minIntervalMs]  floor between two outbound calls
   */
  constructor({ apiKey, cacheDir = ".cache/lastfm", minIntervalMs = 250 }) {
    if (!apiKey) throw new Error("LastFm: apiKey is required");
    this.apiKey = apiKey;
    this.cacheDir = cacheDir;
    this.minIntervalMs = minIntervalMs;
    this.queue = Promise.resolve();
    this.calls = 0;
    this.cacheHits = 0;
  }

  #cachePath(params) {
    const key = createHash("sha1")
      .update(JSON.stringify(params))
      .digest("hex")
      .slice(0, 20);
    return path.join(this.cacheDir, `${params.method}.${key}.json`);
  }

  /**
   * One API call. Results are cached by parameter hash; `offline: true` makes
   * a cache miss return null instead of hitting the network.
   */
  async call(params, { offline = false } = {}) {
    const file = this.cacheDir ? this.#cachePath(params) : "";
    if (file) {
      try {
        this.cacheHits++;
        return JSON.parse(await readFile(file, "utf8"));
      } catch {
        this.cacheHits--;
      }
    }
    if (offline) return null;

    // Serialise: one outbound request at a time, spaced by minIntervalMs.
    const run = this.queue.then(async () => {
      const data = await this.#fetchWithRetry(params);
      await sleep(this.minIntervalMs);
      return data;
    });
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    const data = await run;

    if (file && data) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(data));
    }
    return data;
  }

  async #fetchWithRetry(params, attempt = 0) {
    const query = new URLSearchParams({
      ...params,
      api_key: this.apiKey,
      format: "json",
    });
    let status = 0;
    let body = null;
    try {
      const res = await fetch(`${ENDPOINT}?${query}`, {
        headers: { "User-Agent": "groove-galaxy/1.0 (+https://github.com/Nelson-Jnrnd/groove-galaxy)" },
      });
      this.calls++;
      status = res.status;
      if (res.ok) {
        body = await res.json();
        // Last.fm reports application-level errors with HTTP 200 sometimes.
        if (body && body.error) {
          const err = new Error(`Last.fm error ${body.error}: ${body.message}`);
          // 29 = rate limit exceeded; anything else is not worth retrying.
          if (body.error !== 29) throw err;
          status = 429;
          body = null;
        } else {
          return body;
        }
      }
    } catch (err) {
      if (attempt >= 4) throw err;
    }

    const retryable = status === 429 || status >= 500 || status === 0;
    if (!retryable || attempt >= 4) {
      throw new Error(`Last.fm ${params.method} failed (HTTP ${status})`);
    }
    await sleep(1000 * 2 ** attempt);
    return this.#fetchWithRetry(params, attempt + 1);
  }
}
