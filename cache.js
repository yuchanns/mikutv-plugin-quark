// Session-scoped read cache over MikuTV host.cache (host >= 0.1.5).
// Every helper degrades to a no-op when host.cache is unavailable (host 0.1.4),
// so callers always fall back to a live network read.

const KEY_PREFIX = "quark:v1:";

// Folder listings change when files are added from other clients; keep short.
export const TTL_FOLDER_LIST = 120;
// /file/info metadata (name, parent, duration, thumbnails) is stable per fid.
export const TTL_FILE_INFO = 300;
// Global video index and search results: short, mostly for back/forward paging.
export const TTL_INDEX = 60;
// Subtitle file content is immutable per fid.
export const TTL_SUBTITLE_CUES = 1800;

// Each export runs in a fresh runtime, so this module state is per call.
let accountScope = "anon";

function hostCache() {
  try {
    if (typeof host !== "undefined" && host.cache && typeof host.cache.get === "function") {
      return host.cache;
    }
  } catch (_) {}
  return null;
}

export function useCacheScope(req) {
  const secret = req && req.secret;
  const uid = (secret && secret.uid) || (req && req.owner) || "";
  accountScope = uid ? String(uid) : "anon";
}

export function cacheKey(...parts) {
  return KEY_PREFIX + encodeURIComponent(accountScope) + ":" + parts.map((p) => String(p == null ? "" : p)).join(":");
}

export function cacheGetJSON(key) {
  const cache = hostCache();
  if (!cache) return undefined;
  try {
    const raw = cache.get(key);
    if (typeof raw !== "string" || !raw) return undefined;
    return JSON.parse(raw);
  } catch (_) {
    return undefined;
  }
}

export function cacheSetJSON(key, value, ttlSec) {
  const cache = hostCache();
  if (!cache || typeof cache.set !== "function") return;
  try {
    // Oversized entries are rejected by the host; the read simply stays uncached.
    cache.set(key, JSON.stringify(value), ttlSec);
  } catch (_) {}
}

export function cacheClearAll() {
  const cache = hostCache();
  if (!cache || typeof cache.clear !== "function") return;
  try {
    cache.clear();
  } catch (_) {}
}

// Read-through helper: only successful non-null results are stored; errors propagate uncached.
export async function cachedRead(key, ttlSec, load, toCached) {
  const hit = cacheGetJSON(key);
  if (hit !== undefined && hit !== null) return hit;
  const value = await load();
  if (value !== undefined && value !== null) {
    cacheSetJSON(key, toCached ? toCached(value) : value, ttlSec);
  }
  return value;
}
