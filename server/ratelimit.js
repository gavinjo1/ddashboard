/**
 * Sliding-window counters, in memory.
 *
 * In memory is the right scope here: one container, one process. It resets on
 * restart, which an attacker cannot trigger, and it does not survive scaling
 * to a second instance — if that ever happens this belongs in Postgres or
 * Redis instead.
 */

const buckets = new Map();      // key -> number[] of timestamps
let lastSweep = 0;

/** Drops timestamps older than the window, and empty keys with them. */
function prune(key, windowMs, now) {
  const hits = buckets.get(key);
  if (!hits) return [];
  const cutoff = now - windowMs;
  let i = 0;
  while (i < hits.length && hits[i] <= cutoff) i++;
  const kept = i ? hits.slice(i) : hits;
  if (kept.length) buckets.set(key, kept); else buckets.delete(key);
  return kept;
}

/** Bounded memory: nothing here is worth an unbounded Map. */
function sweep(now) {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  const cutoff = now - 60 * 60 * 1000;
  for (const [key, hits] of buckets) {
    if (!hits.length || hits[hits.length - 1] <= cutoff) buckets.delete(key);
  }
}

/** Records one event and returns how many fall inside the window. */
export function note(key, windowMs) {
  const now = Date.now();
  sweep(now);
  const hits = prune(key, windowMs, now);
  hits.push(now);
  buckets.set(key, hits);
  return hits.length;
}

/** How many events are inside the window, without recording another. */
export function countOf(key, windowMs) {
  return prune(key, windowMs, Date.now()).length;
}

/** Seconds until the oldest event leaves the window. */
export function retryAfter(key, windowMs) {
  const hits = buckets.get(key);
  if (!hits?.length) return 0;
  return Math.max(1, Math.ceil((hits[0] + windowMs - Date.now()) / 1000));
}

export function forget(key) {
  buckets.delete(key);
}

/**
 * Generic per-IP limiter. `keyOf` lets a route count something narrower than
 * the whole route, such as one username.
 */
export function limit({ windowMs, max, prefix, message }) {
  return (req, res, next) => {
    const key = `${prefix}:${req.ip}`;
    if (note(key, windowMs) > max) {
      const wait = retryAfter(key, windowMs);
      res.setHeader('Retry-After', String(wait));
      return res.status(429).json({ error: message ?? `Terlalu banyak permintaan. Coba lagi dalam ${wait} detik.` });
    }
    next();
  };
}
