import crypto from 'node:crypto';

/**
 * A small self-contained image challenge — no third-party service, because
 * this runs on a mill LAN and a VPS in another city, and a dependency on
 * Google or Cloudflare is one more thing that can be blocked or go down.
 *
 * It is deliberately modest: it stops scripted login bombing, not a
 * determined human. The rate limiter is the real defence; this is what makes
 * automating one's way past it cost something.
 */

// No 0/O/1/I/L — misread characters turn into support calls.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const LENGTH = 5;
const TTL_MS = 5 * 60 * 1000;
const MAX_LIVE = 5000;          // a cap, so issuing cannot exhaust memory

const live = new Map();          // id -> { code, expires }

const pick = (n) => Array.from(crypto.randomBytes(n))
  .map((b) => ALPHABET[b % ALPHABET.length]).join('');

/** Uniform in [min, max). */
const rand = (min, max) => min + (crypto.randomBytes(2).readUInt16BE() / 65536) * (max - min);

function sweep() {
  const now = Date.now();
  for (const [id, v] of live) if (v.expires <= now) live.delete(id);
}

function draw(code) {
  const W = 160;
  const H = 56;
  const parts = [];

  // Noise first, so it sits behind the glyphs and cannot be cropped away.
  for (let i = 0; i < 5; i++) {
    parts.push(`<path d="M${rand(0, W).toFixed(0)},${rand(0, H).toFixed(0)} Q${
      rand(0, W).toFixed(0)},${rand(0, H).toFixed(0)} ${
      rand(0, W).toFixed(0)},${rand(0, H).toFixed(0)}" stroke="#b9c6d6" stroke-width="${
      rand(1, 2).toFixed(1)}" fill="none"/>`);
  }
  for (let i = 0; i < 24; i++) {
    parts.push(`<circle cx="${rand(0, W).toFixed(0)}" cy="${rand(0, H).toFixed(0)}" r="${
      rand(0.8, 1.8).toFixed(1)}" fill="#c9d4e2"/>`);
  }

  const step = W / (LENGTH + 1);
  [...code].forEach((ch, i) => {
    const x = step * (i + 1) + rand(-4, 4);
    const y = H / 2 + rand(-3, 6);
    const rot = rand(-26, 26);
    const size = rand(25, 31);
    parts.push(`<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="${size.toFixed(1)}" `
      + `font-family="Georgia,serif" font-weight="600" fill="#1f2d3d" text-anchor="middle" `
      + `dominant-baseline="middle" transform="rotate(${rot.toFixed(1)} ${x.toFixed(1)} ${y.toFixed(1)})">${ch}</text>`);
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" `
    + `role="img" aria-label="Kode gambar"><rect width="${W}" height="${H}" fill="#eef2f7"/>${parts.join('')}</svg>`;
}

export function issueCaptcha() {
  sweep();
  if (live.size >= MAX_LIVE) return null;

  const id = crypto.randomBytes(16).toString('hex');
  const code = pick(LENGTH);
  live.set(id, { code, expires: Date.now() + TTL_MS });
  return { id, svg: draw(code), expires_in: TTL_MS / 1000 };
}

/**
 * Single use: the entry is removed whether or not it matched, so a correct
 * answer cannot be replayed across many login attempts.
 */
export function solveCaptcha(id, answer) {
  sweep();
  const entry = live.get(String(id ?? ''));
  if (!entry) return false;
  live.delete(String(id));
  if (entry.expires <= Date.now()) return false;
  return String(answer ?? '').trim().toUpperCase() === entry.code;
}
