// Tiny in-memory TTL cache. Leaderboard data only changes when the
// settlement crons run (4x/day), so a short TTL keeps the ranking RPCs
// off the hot path without any staleness users would notice.
const store = new Map();

function get(key) {
  const entry = store.get(key);
  if (!entry) return undefined;
  if (entry.expires < Date.now()) {
    store.delete(key);
    return undefined;
  }
  return entry.data;
}

function set(key, data, ttlMs) {
  // Crude bound: per-user keys could otherwise grow without limit
  if (store.size > 500) store.clear();
  store.set(key, { data, expires: Date.now() + ttlMs });
}

module.exports = { get, set };
