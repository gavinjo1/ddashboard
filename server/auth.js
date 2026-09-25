import crypto from 'node:crypto';
import { query } from './db.js';

/* ------------------------------------------------------------------ *
 * Passwords and sessions, on Node's own crypto — no extra dependency.
 * ------------------------------------------------------------------ */

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

const scrypt = (pass, salt) => new Promise((ok, fail) =>
  crypto.scrypt(pass, salt, SCRYPT.keylen, SCRYPT,
    (err, key) => (err ? fail(err) : ok(key.toString('hex')))));

export async function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: await scrypt(plain, salt) };
}

/** Constant-time compare, so a wrong password cannot be found by timing. */
export async function verifyPassword(plain, salt, expected) {
  const got = Buffer.from(await scrypt(plain, salt), 'hex');
  const want = Buffer.from(expected, 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

/* ---- session cookie: username.expiry.signature ---- */

const SECRET = process.env.SESSION_SECRET || '';
const COOKIE = 'mr_session';
const MAX_AGE_MS = 12 * 60 * 60 * 1000;   // one working day

const sign = (data) => crypto.createHmac('sha256', SECRET).update(data).digest('base64url');

export function makeToken(username) {
  const data = `${Buffer.from(username).toString('base64url')}.${Date.now() + MAX_AGE_MS}`;
  return `${data}.${sign(data)}`;
}

export function readToken(token) {
  if (!token || !SECRET) return null;
  const at = token.lastIndexOf('.');
  if (at < 0) return null;
  const data = token.slice(0, at);
  const got = Buffer.from(token.slice(at + 1));
  const want = Buffer.from(sign(data));
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;

  const [user64, expiry] = data.split('.');
  if (!(Number(expiry) > Date.now())) return null;
  return Buffer.from(user64, 'base64url').toString();
}

const parseCookies = (header = '') => Object.fromEntries(
  header.split(';').map((p) => p.trim()).filter(Boolean).map((p) => {
    const i = p.indexOf('=');
    return i < 0 ? [p, ''] : [p.slice(0, i), decodeURIComponent(p.slice(i + 1))];
  }));

export function setSession(res, username) {
  const secure = process.env.COOKIE_SECURE === '1' ? '; Secure' : '';
  res.setHeader('Set-Cookie',
    `${COOKIE}=${makeToken(username)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${MAX_AGE_MS / 1000}${secure}`);
}

export const clearSession = (res) =>
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);

/** Puts the signed-in username on req.user, or null. */
export function readSession(req) {
  return readToken(parseCookies(req.headers.cookie)[COOKIE]);
}

/* ---- guard ---- */

const OPEN = new Set(['/api/auth/login', '/api/auth/register', '/api/auth/me', '/api/auth/captcha']);

/**
 * Guards the API only. Registered globally so it sits ahead of every route,
 * including the loom router mounted later; the static files fall through, and
 * the page itself sends anyone without a session to the sign-in screen.
 *
 * The cookie alone only proves who someone was when they signed in, so the
 * account is looked up on every request: deleting it, or changing its role,
 * takes effect on that person's next click rather than when the cookie runs
 * out twelve hours later.
 */
export async function requireLogin(req, res, next) {
  const path = req.path;
  if (!path.startsWith('/api') || OPEN.has(path)) return next();

  const user = readSession(req);
  if (!user) return res.status(401).json({ error: 'Belum masuk.' });
  try {
    const { rows: [u] } = await query('SELECT role FROM app_user WHERE username = $1', [user]);
    if (!u) {
      clearSession(res);
      return res.status(401).json({ error: 'Belum masuk.' });
    }
    req.user = user;
    req.role = u.role;
    next();
  } catch (err) { next(err); }
}

/* ---- roles ---- */

const RANK = { viewer: 1, operator: 2, admin: 3 };

/** Reads the role requireLogin looked up for this same request. */
export function requireRole(min) {
  return (req, res, next) => {
    if ((RANK[req.role] ?? 0) < RANK[min]) {
      return res.status(403).json({ error: 'Akun Anda tidak punya hak untuk tindakan ini.' });
    }
    next();
  };
}

/** True while no account exists yet, so the first person can create one. */
export async function noUsersYet() {
  const { rows: [r] } = await query('SELECT count(*)::int AS n FROM app_user');
  return r.n === 0;
}
