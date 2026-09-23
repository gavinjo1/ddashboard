import express from 'express';
import multer from 'multer';
import XLSX from 'xlsx';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { query, pool } from './db.js';
import { importBuffer, previewBuffer, isSupported } from './importer.js';
import { loomRouter } from './loom-routes.js';
import {
  hashPassword, verifyPassword, setSession, clearSession,
  readSession, requireLogin, noUsersYet
} from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

if (!process.env.SESSION_SECRET) {
  console.error('SESSION_SECRET is not set — sign-in cannot work. Add it to .env.');
  process.exit(1);
}

// Ahead of every route, so nothing under /api can be reached without a session.
app.use(requireLogin);

/* ------------------------------------------------------------------ *
 * Accounts
 *
 * One account per person, because the point is to be able to say who
 * entered a figure. Passwords are scrypt-hashed in auth.js.
 * ------------------------------------------------------------------ */

const USERNAME = /^[a-z0-9._-]{3,32}$/i;

app.get('/api/auth/me', (req, res) => send(res, async () => {
  const username = readSession(req);
  if (!username) return res.json({ user: null, first_run: await noUsersYet() });
  const { rows: [u] } = await query(
    'SELECT username, nama FROM app_user WHERE username = $1', [username]);
  // The account was removed while the cookie was still valid.
  if (!u) { clearSession(res); return res.json({ user: null, first_run: await noUsersYet() }); }
  res.json({ user: u, first_run: false });
}));

app.post('/api/auth/register', (req, res) => send(res, async () => {
  const username = String(req.body?.username ?? '').trim().toLowerCase();
  const nama = String(req.body?.nama ?? '').trim();
  const password = String(req.body?.password ?? '');

  if (!USERNAME.test(username)) {
    return res.status(400).json({ error: 'Nama pengguna 3–32 karakter: huruf, angka, titik, garis.' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Kata sandi minimal 8 karakter.' });
  }

  const { salt, hash } = await hashPassword(password);
  try {
    await query(
      'INSERT INTO app_user (username, nama, pass_hash, pass_salt) VALUES ($1,$2,$3,$4)',
      [username, nama || null, hash, salt]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Nama pengguna sudah dipakai.' });
    throw err;
  }
  setSession(res, username);
  res.json({ user: { username, nama: nama || null } });
}));

app.post('/api/auth/login', (req, res) => send(res, async () => {
  const username = String(req.body?.username ?? '').trim().toLowerCase();
  const password = String(req.body?.password ?? '');

  const { rows: [u] } = await query(
    'SELECT username, nama, pass_hash, pass_salt FROM app_user WHERE username = $1', [username]);

  // Same message either way: a distinct "no such user" tells an outsider which
  // names exist.
  const ok = u && await verifyPassword(password, u.pass_salt, u.pass_hash);
  if (!ok) return res.status(401).json({ error: 'Nama pengguna atau kata sandi salah.' });

  await query('UPDATE app_user SET last_login = now() WHERE username = $1', [username]);
  setSession(res, u.username);
  res.json({ user: { username: u.username, nama: u.nama } });
}));

app.post('/api/auth/logout', (req, res) => { clearSession(res); res.json({ ok: true }); });

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

/* ------------------------------------------------------------------ *
 * Filters -> SQL
 * ------------------------------------------------------------------ */

const LIST_FILTERS = {
  shift: 'shift',
  machine: 'no_mc',
  group: 'kelompok_mesin',
  type: 'type_mc',
  fabric: 'kode_kain',
  mo: 'mo'
};

/**
 * Turns the query string into SQL clauses. Column names come from the
 * whitelist above, never from the request; values are always bound.
 *
 * `startAt` offsets the placeholder numbers so a second clause set can be
 * appended to the same statement; `dates: false` emits only the dimension
 * filters, which is what the previous-period comparison needs.
 */
/* ------------------------------------------------------------------ *
 * Shift windows
 *
 * The mill runs three: 07:00–15:00, 15:00–23:00, 23:00–07:00. The crew letter
 * on a row is not the window — A/B/C rotate every Friday — so filtering by
 * clock time has to go through the hours actually recorded on the row.
 * ------------------------------------------------------------------ */

const SHIFT_WINDOWS = [
  { value: 'pagi',  label: '07:00–15:00', start: '07:00', end: '15:00' },
  { value: 'siang', label: '15:00–23:00', start: '15:00', end: '23:00' },
  { value: 'malam', label: '23:00–07:00', start: '23:00', end: '07:00' }
];

/**
 * Which window a row belongs to, by whichever of 07:00 / 15:00 / 23:00 its
 * start time is nearest. The boundaries are the midpoints between them, so a
 * week that starts the morning shift at 06:30 or 07:30 still reads as pagi —
 * which matters, because these hours are re-set most weeks.
 *
 * A row with no hours belongs to no window and is simply never matched.
 */
const shiftWindowSql = (prefix) => `CASE
    WHEN ${prefix}jam_mulai >= TIME '03:00' AND ${prefix}jam_mulai < TIME '11:00' THEN 'pagi'
    WHEN ${prefix}jam_mulai >= TIME '11:00' AND ${prefix}jam_mulai < TIME '19:00' THEN 'siang'
    WHEN ${prefix}jam_mulai IS NOT NULL THEN 'malam'
  END`;

function buildFilters(q, { prefix = '', startAt = 0, dates = true } = {}) {
  const clauses = [];
  const params = [];
  const bind = (v) => { params.push(v); return `$${startAt + params.length}`; };

  if (dates && q.from) clauses.push(`${prefix}tgl >= ${bind(q.from)}`);
  if (dates && q.to)   clauses.push(`${prefix}tgl <= ${bind(q.to)}`);

  for (const [key, col] of Object.entries(LIST_FILTERS)) {
    const vals = String(q[key] ?? '').split(',').map((v) => v.trim()).filter(Boolean);
    if (vals.length) clauses.push(`${prefix}${col} = ANY(${bind(vals)})`);
  }

  // Not in LIST_FILTERS: this one is a computed window, not a stored column.
  const jam = String(q.jam ?? '').split(',').map((v) => v.trim()).filter(Boolean);
  if (jam.length) clauses.push(`${shiftWindowSql(prefix)} = ANY(${bind(jam)})`);

  return { clauses, params };
}

/** Builds a WHERE clause from the query string. Multi-values arrive comma-separated. */
function whereFrom(q) {
  const { clauses, params } = buildFilters(q);
  return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

/**
 * How a loom type is shown: the layout band and the mill's name for it, as the
 * workbook header reads them — "AJL TOYOTA 1 | E SHADE". Falls back to the
 * TYPE MC code when a type has no entry in the legend.
 */
const TYPE_LABEL = `COALESCE(NULLIF(concat_ws(' | ', t.band, t.description), ''), p.type_mc)`;

const send = (res, fn) => fn().catch((err) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

/* ------------------------------------------------------------------ *
 * Reference data for the filter controls
 * ------------------------------------------------------------------ */

app.get('/api/filters', (req, res) => send(res, async () => {
  const { rows: [range] } = await query(
    `SELECT min(tgl)::text AS min_date, max(tgl)::text AS max_date, count(*)::int AS total FROM production`
  );
  // How many rows carry hours: without them a window filter matches nothing,
  // and the screen should say so rather than look broken.
  const { rows: [h] } = await query(
    'SELECT count(jam_mulai)::int AS with_hours FROM production');

  const col = async (c) =>
    (await query(`SELECT DISTINCT ${c} AS v FROM production WHERE ${c} IS NOT NULL ORDER BY 1`))
      .rows.map((r) => r.v);

  // Machine types carry the mill's own name for the loom ("AJL 2 AIR TUCKER"),
  // which is what people on the floor actually call them.
  const { rows: types } = await query(`
    SELECT DISTINCT p.type_mc AS value, ${TYPE_LABEL} AS label,
           t.description, t.band, t.sort_order
    FROM production p LEFT JOIN machine_type t USING (type_mc)
    WHERE p.type_mc IS NOT NULL
    ORDER BY t.sort_order NULLS LAST, p.type_mc`);

  res.json({
    range,
    shifts:   await col('shift'),
    groups:   await col('kelompok_mesin'),
    types,
    machines: await col('no_mc'),
    fabrics:  await col('kode_kain'),
    mos:      await col('mo'),
    windows:  SHIFT_WINDOWS,
    with_hours: h.with_hours
  });
}));

/* ------------------------------------------------------------------ *
 * Headline numbers
 * ------------------------------------------------------------------ */

app.get('/api/summary', (req, res) => send(res, async () => {
  const { sql, params } = whereFrom(req.query);

  const { rows: [s] } = await query(`
    SELECT
      COALESCE(sum(produksi), 0)                       AS produksi,
      count(*)::int                                    AS entries,
      count(DISTINCT no_mc)::int                       AS machines,
      count(DISTINCT tgl)::int                         AS days,
      count(DISTINCT mo)::int                          AS orders,
      count(*) FILTER (WHERE ket_bb IS NOT NULL)::int  AS stoppages,
      count(*) FILTER (WHERE COALESCE(produksi,0) = 0)::int AS idle_shifts,
      -- RPM attainment is output-weighted so big runs count for more.
      CASE WHEN sum(rpm_target) > 0
           THEN sum(rpm) / sum(rpm_target) * 100 END   AS rpm_attainment,
      avg(rpm)                                         AS avg_rpm
    FROM production ${sql}`, params);

  // The same period length immediately before this one, under the same
  // dimension filters — comparing a filtered period to an unfiltered one
  // would make the delta meaningless.
  const dims = buildFilters(req.query, { prefix: 'p.', startAt: params.length, dates: false });
  const { rows: [prev] } = await query(`
    WITH bounds AS (
      SELECT min(tgl) AS lo, max(tgl) AS hi FROM production ${sql}
    )
    SELECT COALESCE(sum(p.produksi), 0) AS produksi, count(DISTINCT p.tgl)::int AS days
    FROM production p, bounds b
    WHERE p.tgl < b.lo AND p.tgl >= b.lo - (b.hi - b.lo + 1)
    ${dims.clauses.map((c) => `AND ${c}`).join(' ')}`,
    [...params, ...dims.params]);

  res.json({ ...s, prev });
}));

/* ------------------------------------------------------------------ *
 * Series and breakdowns
 * ------------------------------------------------------------------ */

/**
 * `prod100` is the whole mill's output at 100% efficiency, from the monthly
 * sheet. It is only comparable with an unfiltered day, so it is served only
 * when nothing narrows the machines — see `capacityApplies`.
 */
const NARROWING = ['shift', 'machine', 'group', 'type', 'fabric', 'mo', 'jam'];
const capacityApplies = (q) => !NARROWING.some((k) => String(q[k] ?? '').trim());

app.get('/api/trend', (req, res) => send(res, async () => {
  // Aliased via buildFilters rather than rewriting the clause with a regex —
  // a filter value could contain a column name and get mangled.
  const { clauses, params } = buildFilters(req.query, { prefix: 'p.' });
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const showCapacity = capacityApplies(req.query);

  const { rows } = await query(`
    SELECT p.tgl::text AS date,
           sum(p.produksi)              AS produksi,
           count(DISTINCT p.no_mc)::int AS machines,
           ${showCapacity ? 'max(c.prod100)' : 'NULL::numeric'} AS prod100
    FROM production p
    LEFT JOIN daily_capacity c ON c.tgl = p.tgl
    ${where}
    GROUP BY p.tgl ORDER BY p.tgl`, params);
  res.json(rows);
}));

// dim is whitelisted, never interpolated from raw input.
const DIMS = {
  group: 'kelompok_mesin',
  type: 'type_mc',
  shift: 'shift',
  fabric: 'kode_kain',
  mo: 'mo',
  machine: 'no_mc'
};

app.get('/api/breakdown/:dim', (req, res) => send(res, async () => {
  const col = DIMS[req.params.dim];
  if (!col) return res.status(400).json({ error: `Unknown dimension "${req.params.dim}"` });

  // Aliased, because the machine-type breakdown joins the name lookup.
  const { clauses, params } = buildFilters(req.query, { prefix: 'p.' });
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  params.push(limit);

  // For machine type, show the mill's name and keep the code alongside it.
  const isType = col === 'type_mc';
  const label = isType ? TYPE_LABEL : `p.${col}`;
  const join = isType ? 'LEFT JOIN machine_type t USING (type_mc)' : '';
  const where = [...clauses, `p.${col} IS NOT NULL`].join(' AND ');

  const { rows } = await query(`
    SELECT ${label} AS label,
           ${isType ? 'p.type_mc' : 'NULL'} AS code,
           sum(p.produksi)              AS produksi,
           count(*)::int                AS entries,
           count(DISTINCT p.no_mc)::int AS machines,
           CASE WHEN sum(p.rpm_target) > 0
                THEN sum(p.rpm) / sum(p.rpm_target) * 100 END AS rpm_attainment
    FROM production p ${join}
    WHERE ${where}
    GROUP BY ${label}${isType ? ', p.type_mc' : ''}
    ORDER BY produksi DESC NULLS LAST
    LIMIT $${params.length}`, params);
  res.json(rows);
}));

/* ------------------------------------------------------------------ *
 * Per-machine table
 * ------------------------------------------------------------------ */

const MACHINE_SORTS = {
  machine: 'no_mc', produksi: 'produksi', avg_day: 'avg_day',
  rpm: 'avg_rpm', attainment: 'rpm_attainment', stoppages: 'stoppages'
};

app.get('/api/machines', (req, res) => send(res, async () => {
  const { sql, params } = whereFrom(req.query);
  const sortCol = MACHINE_SORTS[req.query.sort] || 'produksi';
  const dir = req.query.dir === 'asc' ? 'ASC' : 'DESC';

  const { rows } = await query(`
    SELECT no_mc                                     AS machine,
           max(kelompok_mesin)                       AS grp,
           max(type_mc)                              AS type,
           max(COALESCE(NULLIF(concat_ws(' | ', t.band, t.description), ''), p.type_mc)) AS type_name,
           sum(produksi)                             AS produksi,
           count(DISTINCT tgl)::int                  AS days,
           sum(produksi) / NULLIF(count(DISTINCT tgl), 0) AS avg_day,
           avg(rpm)                                  AS avg_rpm,
           CASE WHEN sum(rpm_target) > 0
                THEN sum(rpm) / sum(rpm_target) * 100 END AS rpm_attainment,
           count(*) FILTER (WHERE ket_bb IS NOT NULL)::int AS stoppages,
           count(*) FILTER (WHERE COALESCE(produksi,0) = 0)::int AS idle,
           string_agg(DISTINCT kode_kain, ', ' ORDER BY kode_kain) AS fabrics
    FROM production p LEFT JOIN machine_type t USING (type_mc) ${sql}
    GROUP BY no_mc
    ORDER BY ${sortCol} ${dir} NULLS LAST, no_mc`, params);
  res.json(rows);
}));

/**
 * Every shift line for one machine — the drill-down behind a table row.
 *
 * PICK comes from the order header on that day's sheet, joined on order *and*
 * date rather than order alone: it is a property of the order as it stood that
 * day, so a change part-way through the month would show on the right rows.
 */
app.get('/api/machine/:no', (req, res) => send(res, async () => {
  const { clauses, params } = buildFilters(req.query, { prefix: 'p.' });
  params.push(req.params.no);
  const where = [...clauses, `p.no_mc = $${params.length}`].join(' AND ');

  const { rows } = await query(`
    SELECT p.tgl::text AS date, p.shift, p.mo, p.kode_kain, o.pick,
           p.rpm, p.rpm_target, p.produksi, p.ket_bb, p.edited_by,
           to_char(p.jam_mulai, 'HH24:MI')   AS jam_mulai,
           to_char(p.jam_selesai, 'HH24:MI') AS jam_selesai
    FROM production p
    LEFT JOIN order_info o ON o.mo = p.mo AND o.as_of = p.tgl
    WHERE ${where}
    ORDER BY p.tgl, p.shift`, params);
  res.json(rows);
}));

/* ------------------------------------------------------------------ *
 * Global search
 *
 * One box over everything — customer, order, fabric, machine, machine type,
 * stoppage note — but the answer is always a list of orders, because that is
 * the level the mill plans and ships at.
 * ------------------------------------------------------------------ */

/** "A1" must not match A10/A11/A12, so machine numbers match as whole tokens. */
const MACHINE_SHAPED = /^[A-Za-z]{1,2}\d{1,2}$/;

app.get('/api/search', (req, res) => send(res, async () => {
  const q = String(req.query.q ?? '').trim();
  if (q.length < 2) return res.json({ query: q, rows: [] });

  const like = `%${q.replace(/[%_\\]/g, (c) => '\\' + c)}%`;
  const machineToken = MACHINE_SHAPED.test(q) ? q : null;

  const { rows } = await query(`
    WITH mos AS (
      SELECT mo FROM order_info
      UNION
      SELECT mo FROM production WHERE mo IS NOT NULL AND mo <> '0'
    ),
    latest AS (
      SELECT DISTINCT ON (mo) mo, customer, kode_kain, total_order, akumulasi, sisa_order, as_of
      FROM order_info ORDER BY mo, as_of DESC
    ),
    prod AS (
      SELECT p.mo,
             sum(p.produksi)                                        AS produksi,
             count(DISTINCT p.no_mc)::int                           AS n_machines,
             min(p.tgl)::text                                       AS mulai,
             max(p.tgl)::text                                       AS terakhir,
             string_agg(DISTINCT p.no_mc, ' ')                      AS machines,
             string_agg(DISTINCT p.kode_kain, ', ')                 AS fabrics,
             string_agg(DISTINCT COALESCE(t.band || ' | ', '') || COALESCE(t.description, p.type_mc), ' · ') AS types,
             string_agg(DISTINCT p.ket_bb, ', ')                    AS notes
      FROM production p LEFT JOIN machine_type t USING (type_mc)
      WHERE p.mo IS NOT NULL AND p.mo <> '0'
      GROUP BY p.mo
    )
    SELECT m.mo,
           l.customer,
           COALESCE(pr.fabrics, l.kode_kain)                        AS kode_kain,
           pr.types                                                 AS type_mc,
           l.total_order, l.akumulasi, l.sisa_order,
           pr.produksi, pr.n_machines, pr.mulai, pr.terakhir,
           CASE
             WHEN l.customer ILIKE $1                                        THEN 'customer'
             WHEN m.mo ILIKE $1                                              THEN 'order'
             WHEN pr.fabrics ILIKE $1 OR l.kode_kain ILIKE $1                THEN 'fabric'
             WHEN pr.types ILIKE $1                                          THEN 'machine type'
             WHEN $2::text IS NOT NULL AND pr.machines ~* ('\\m' || $2 || '\\M') THEN 'machine'
             WHEN pr.notes ILIKE $1                                          THEN 'note'
           END AS matched
    FROM mos m
    LEFT JOIN latest l ON l.mo = m.mo
    LEFT JOIN prod  pr ON pr.mo = m.mo
    WHERE l.customer ILIKE $1
       OR m.mo ILIKE $1
       OR pr.fabrics ILIKE $1
       OR l.kode_kain ILIKE $1
       OR pr.types ILIKE $1
       OR pr.notes ILIKE $1
       OR ($2::text IS NOT NULL AND pr.machines ~* ('\\m' || $2 || '\\M'))
    ORDER BY pr.produksi DESC NULLS LAST, m.mo
    LIMIT 60`, [like, machineToken]);

  res.json({ query: q, rows });
}));

/* ------------------------------------------------------------------ *
 * Order header — shown when the view is narrowed to an order or a fabric
 * ------------------------------------------------------------------ */

app.get('/api/order-info', (req, res) => send(res, async () => {
  const mos = String(req.query.mo ?? '').split(',').map((v) => v.trim()).filter(Boolean);
  const fabrics = String(req.query.fabric ?? '').split(',').map((v) => v.trim()).filter(Boolean);
  if (!mos.length && !fabrics.length) return res.json([]);

  // Only the order and fabric filters apply: an order header describes the
  // whole order, not one machine-shift, so a machine or shift filter would
  // narrow the production figure without narrowing the order it sits beside.
  const clauses = [];
  const params = [];
  if (mos.length)     { params.push(mos);     clauses.push(`o.mo = ANY($${params.length})`); }
  if (fabrics.length) { params.push(fabrics); clauses.push(`o.kode_kain = ANY($${params.length})`); }

  const { rows } = await query(`
    SELECT DISTINCT ON (o.mo)
           o.mo, o.kode_kain, o.customer, o.pick, o.total_order, o.akumulasi, o.sisa_order,
           o.as_of::text AS as_of,
           COALESCE(p.periode, 0)   AS periode,
           COALESCE(p.machines, 0)  AS machines,
           p.terakhir::text         AS terakhir
    FROM order_info o
    LEFT JOIN (
      SELECT mo, sum(produksi) AS periode, count(DISTINCT no_mc)::int AS machines,
             max(tgl) AS terakhir
      FROM production GROUP BY mo
    ) p ON p.mo = o.mo
    WHERE ${clauses.join(' OR ')}
    ORDER BY o.mo, o.as_of DESC`, params);

  rows.sort((a, b) => (Number(b.akumulasi) || 0) - (Number(a.akumulasi) || 0));
  res.json(rows);
}));

/**
 * The day-by-day progression for one order, as each daily sheet recorded it,
 * with that day's loom output from the source sheet alongside.
 */
app.get('/api/order-history', (req, res) => send(res, async () => {
  const mo = String(req.query.mo ?? '').trim();
  if (!mo) return res.json([]);

  const { rows } = await query(`
    SELECT o.as_of::text AS date, o.total_order, o.akumulasi, o.sisa_order,
           COALESCE(p.produksi, 0) AS produksi
    FROM order_info o
    LEFT JOIN (
      SELECT tgl, sum(produksi) AS produksi FROM production WHERE mo = $1 GROUP BY tgl
    ) p ON p.tgl = o.as_of
    WHERE o.mo = $1
    ORDER BY o.as_of`, [mo]);
  res.json(rows);
}));

/* ------------------------------------------------------------------ *
 * Orders
 * ------------------------------------------------------------------ */

const ORDER_SORTS = {
  mo: 'mo', saldo: 'saldo', period: 'periode', total: 'kumulatif',
  machines: 'machines', last: 'terakhir'
};

/**
 * Per order, from the source sheet alone: the SALDO opening balance, what was
 * woven in the selected period, and the two added together.
 */
app.get('/api/orders', (req, res) => send(res, async () => {
  const { clauses, params } = buildFilters(req.query, { prefix: 'p.' });
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const sortCol = ORDER_SORTS[req.query.sort] || 'kumulatif';
  const dir = req.query.dir === 'asc' ? 'ASC' : 'DESC';

  const { rows } = await query(`
    SELECT p.mo,
           max(p.kode_kain)                              AS kode_kain,
           COALESCE(max(s.produksi), 0)                  AS saldo,
           sum(p.produksi)                               AS periode,
           COALESCE(max(s.produksi), 0) + sum(p.produksi) AS kumulatif,
           count(DISTINCT p.no_mc)::int                  AS machines,
           count(DISTINCT p.tgl)::int                    AS days,
           min(p.tgl)::text                              AS mulai,
           max(p.tgl)::text                              AS terakhir
    FROM production p
    LEFT JOIN saldo s ON s.mo = p.mo
    ${where}
    ${where ? 'AND' : 'WHERE'} p.mo IS NOT NULL
    GROUP BY p.mo
    ORDER BY ${sortCol} ${dir} NULLS LAST, p.mo`, params);

  // Orders carried over but not woven at all in this period.
  const { rows: [dormant] } = await query(`
    SELECT count(*)::int AS n, COALESCE(sum(s.produksi), 0) AS produksi
    FROM saldo s
    WHERE NOT EXISTS (SELECT 1 FROM production p WHERE p.mo = s.mo)`);

  res.json({ rows, dormant });
}));

/* ------------------------------------------------------------------ *
 * Stoppages and quality
 * ------------------------------------------------------------------ */

app.get('/api/stoppages', (req, res) => send(res, async () => {
  const { sql, params } = whereFrom(req.query);
  const { rows } = await query(`
    SELECT ket_bb AS label, count(*)::int AS entries,
           count(DISTINCT no_mc)::int AS machines,
           COALESCE(sum(produksi), 0) AS produksi
    FROM production ${sql}
    ${sql ? 'AND' : 'WHERE'} ket_bb IS NOT NULL
    GROUP BY ket_bb ORDER BY entries DESC`, params);
  res.json(rows);
}));

app.get('/api/quality', (req, res) => send(res, async () => {
  // Grades are reported per MO, so only the date / MO / fabric filters apply.
  const q = { from: req.query.from, to: req.query.to, mo: req.query.mo, fabric: req.query.fabric };
  const clauses = [];
  const params = [];
  if (q.from) { params.push(q.from); clauses.push(`tgl >= $${params.length}`); }
  if (q.to)   { params.push(q.to);   clauses.push(`tgl <= $${params.length}`); }
  if (q.mo)   { params.push(String(q.mo).split(',')); clauses.push(`mo = ANY($${params.length})`); }
  if (q.fabric) { params.push(String(q.fabric).split(',')); clauses.push(`kode_kain = ANY($${params.length})`); }
  const sql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const { rows: [totals] } = await query(`
    SELECT COALESCE(sum(grade_a),0) AS a, COALESCE(sum(grade_b),0) AS b,
           COALESCE(sum(bs),0) AS bs, COALESCE(sum(rk),0) AS rk,
           COALESCE(sum(total),0) AS total, count(*)::int AS rows
    FROM grade ${sql}`, params);

  const { rows: daily } = await query(`
    SELECT tgl::text AS date, sum(grade_a) AS a, sum(grade_b) AS b,
           sum(bs) AS bs, sum(rk) AS rk, sum(total) AS total
    FROM grade ${sql} GROUP BY tgl ORDER BY tgl`, params);

  const { rows: byFabric } = await query(`
    SELECT kode_kain AS label, sum(total) AS total, sum(grade_a) AS a,
           sum(bs) + sum(rk) AS defect
    FROM grade ${sql}
    ${sql ? 'AND' : 'WHERE'} kode_kain IS NOT NULL
    GROUP BY kode_kain ORDER BY total DESC LIMIT 15`, params);

  res.json({ totals, daily, byFabric });
}));

/* ------------------------------------------------------------------ *
 * Manual entry — one shift at a time, without a file
 * ------------------------------------------------------------------ */

/**
 * Sensible values for the fields the operator should not have to retype.
 * Machine type and fabric count never vary per machine in the data, and a
 * fabric code never varies per order, so those are safe to fill in. Machine
 * group and target RPM do drift, so the most recent value is offered as a
 * starting point and stays editable.
 */
app.get('/api/entry/defaults', (req, res) => send(res, async () => {
  const out = { machine: null, order: null, hours: null };

  // Shift hours are re-set most weeks, so the form offers the last ones used
  // for this shift rather than a fixed clock. Only rows that actually carry
  // hours count, which means the pre-2026-09 backlog never answers.
  if (req.query.shift) {
    const { rows: [h] } = await query(`
      SELECT to_char(jam_mulai, 'HH24:MI')   AS jam_mulai,
             to_char(jam_selesai, 'HH24:MI') AS jam_selesai
      FROM production
      WHERE shift = $1 AND jam_mulai IS NOT NULL
      ORDER BY tgl DESC LIMIT 1`, [String(req.query.shift).toUpperCase()]);
    out.hours = h ?? null;
  }

  if (req.query.no_mc) {
    const { rows: [m] } = await query(`
      SELECT type_mc, kelompok_mesin, jml_kain, rpm, rpm_target
      FROM production WHERE no_mc = $1 ORDER BY tgl DESC, shift DESC LIMIT 1`, [req.query.no_mc]);
    out.machine = m ?? null;
  }
  if (req.query.mo) {
    const { rows: [o] } = await query(`
      SELECT kode_kain, rpm_target FROM production
      WHERE mo = $1 ORDER BY tgl DESC LIMIT 1`, [req.query.mo]);
    const { rows: [i] } = await query(
      `SELECT customer, pick FROM order_info WHERE mo = $1 ORDER BY as_of DESC LIMIT 1`, [req.query.mo]);
    out.order = o ? { ...o, ...(i ?? {}) } : null;
  }
  res.json(out);
}));

const ENTRY_NUM = ['jml_kain', 'rpm', 'rpm_target', 'produksi'];

app.post('/api/entry', (req, res) => send(res, async () => {
  const b = req.body ?? {};
  const tgl = String(b.tgl ?? '').trim();
  const shift = String(b.shift ?? '').trim().toUpperCase();
  const no_mc = String(b.no_mc ?? '').trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(tgl)) return res.status(400).json({ error: 'Date must be YYYY-MM-DD.' });
  if (!['A', 'B', 'C'].includes(shift)) return res.status(400).json({ error: 'Shift must be A, B or C.' });
  if (!no_mc) return res.status(400).json({ error: 'Machine is required.' });

  // Shift hours are optional — left empty the row simply carries none, which is
  // how every row from before this field existed already reads.
  const hour = (v) => {
    const t = String(v ?? '').trim();
    if (!t) return null;
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) return false;
    return t;
  };
  const jam_mulai = hour(b.jam_mulai);
  const jam_selesai = hour(b.jam_selesai);
  if (jam_mulai === false || jam_selesai === false) {
    return res.status(400).json({ error: 'Jam shift harus format 24 jam, contoh 07:00.' });
  }

  const num = {};
  for (const k of ENTRY_NUM) {
    const raw = b[k];
    if (raw === '' || raw === null || raw === undefined) { num[k] = null; continue; }
    const v = Number(raw);
    if (!Number.isFinite(v) || v < 0) return res.status(400).json({ error: `${k} must be a number, not "${raw}".` });
    num[k] = v;
  }

  // Derived exactly as the workbook derives them, so a hand-entered row and an
  // imported one cannot disagree.
  const jml = num.jml_kain || null;
  const hit_rpm = num.rpm != null && jml ? num.rpm * jml : null;
  const ketik_prod = num.produksi != null && jml ? num.produksi / jml : null;

  const { rows: [row] } = await query(`
    INSERT INTO production
      (tgl, shift, no_mc, mo, kode_kain, type_mc, kelompok_mesin, jml_kain,
       rpm, rpm_target, hit_rpm, produksi, ketik_rpm, ketik_prod, ket_bb, source_file,
       jam_mulai, jam_selesai, edited_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$9,$13,$14,'manual entry',$15,$16,$17)
    ON CONFLICT (tgl, shift, no_mc) DO UPDATE SET
      mo = EXCLUDED.mo, kode_kain = EXCLUDED.kode_kain, type_mc = EXCLUDED.type_mc,
      kelompok_mesin = EXCLUDED.kelompok_mesin, jml_kain = EXCLUDED.jml_kain,
      rpm = EXCLUDED.rpm, rpm_target = EXCLUDED.rpm_target, hit_rpm = EXCLUDED.hit_rpm,
      produksi = EXCLUDED.produksi, ketik_rpm = EXCLUDED.ketik_rpm,
      ketik_prod = EXCLUDED.ketik_prod, ket_bb = EXCLUDED.ket_bb,
      jam_mulai = EXCLUDED.jam_mulai, jam_selesai = EXCLUDED.jam_selesai,
      edited_by = EXCLUDED.edited_by,
      source_file = 'manual entry', imported_at = now()
    RETURNING (xmax = 0) AS inserted, tgl::text, shift, no_mc, produksi, edited_by,
              to_char(jam_mulai, 'HH24:MI') AS jam_mulai,
              to_char(jam_selesai, 'HH24:MI') AS jam_selesai`,
    [tgl, shift, no_mc, b.mo || null, b.kode_kain || null, b.type_mc || null,
     b.kelompok_mesin || null, jml, num.rpm, num.rpm_target, hit_rpm, num.produksi,
     ketik_prod, (b.ket_bb || '').trim() || null, jam_mulai, jam_selesai, req.user]);

  res.json({ ...row, ketik_prod, hit_rpm });
}));

/* ------------------------------------------------------------------ *
 * Import
 * ------------------------------------------------------------------ */

app.post('/api/preview', upload.single('file'), (req, res) => send(res, async () => {
  if (!req.file) return res.status(400).json({ error: 'No file received' });
  if (!isSupported(req.file.originalname)) {
    return res.status(400).json({ error: `Unsupported file type: ${req.file.originalname}` });
  }
  res.json({ file: req.file.originalname, sheets: previewBuffer(req.file.buffer, req.file.originalname) });
}));

app.post('/api/import', upload.single('file'), (req, res) => send(res, async () => {
  if (!req.file) return res.status(400).json({ error: 'No file received' });
  if (!isSupported(req.file.originalname)) {
    return res.status(400).json({ error: `Unsupported file type: ${req.file.originalname}` });
  }
  const only = req.body.sheets ? String(req.body.sheets).split(',').filter(Boolean) : null;
  const results = await importBuffer(req.file.buffer, req.file.originalname,
    { only, editedBy: req.user });
  res.json({ file: req.file.originalname, results });
}));

app.get('/api/imports', (req, res) => send(res, async () => {
  const { rows } = await query(
    `SELECT file_name, sheet_name, dataset, rows_read, rows_written, rows_skipped,
            status, message, imported_by, to_char(created_at, 'YYYY-MM-DD HH24:MI') AS at
     FROM import_log ORDER BY created_at DESC LIMIT 25`
  );
  res.json(rows);
}));

/* ------------------------------------------------------------------ *
 * Export
 *
 * The .xlsx export rebuilds the workbook's own SOURCE DATA sheet, column for
 * column — including the six ID columns the dashboard does not otherwise
 * store, because every formula elsewhere in that workbook looks rows up by
 * them. Paste the result over SOURCE DATA and the daily sheets, BULANAN and
 * GRADE recalculate on their own.
 *
 * Reproducing those sheets and their ~50,000 formulas here would be the wrong
 * way round: they already exist and already work.
 * ------------------------------------------------------------------ */

const SOURCE_HEADERS = ['TGL', 'ID PERSHIFT', 'ID LAP MO', 'ID RPM REAL', 'ID KELOMPOK MESIN',
  'ID LAY OUT', 'ID BB', 'SHIFT', 'NO MC', 'MO', 'KODE KAIN', 'TYPE MC', 'KELOMPOK MESIN',
  'JML KAIN', 'RPM', 'EFF', 'PRODUKSI', 'HIT RPM', 'RPM TARGET', 'KETIK RPM', 'KETIK PROD', 'KET BB',
  // Appended after column V, never inserted among it: the workbook's formulas
  // address SOURCE DATA by column, so A:V has to stay exactly as it was.
  // Rows written before these fields existed leave all three empty.
  'JAM MULAI', 'JAM SELESAI', 'DIINPUT OLEH'];

/** Excel's own day number, which the ID columns are built from. */
const excelSerial = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000);
};

function sourceRow(r) {
  const ser = excelSerial(r.tgl);
  const shift = r.shift ?? '';
  const type = r.type_mc ?? '';
  return [
    null,                                               // TGL, written below
    `${shift}${ser}`,                                   // ID PERSHIFT
    `${ser}${r.mo ?? ''}${type}`,                       // ID LAP MO
    `${type}${ser}`,                                    // ID RPM REAL
    `${r.kelompok_mesin ?? ''}${shift}${ser}`,          // ID KELOMPOK MESIN
    `${r.no_mc ?? ''}${shift}${ser}`,                   // ID LAY OUT
    `${r.ket_bb ?? ''}${type}${ser}`,                   // ID BB
    shift, r.no_mc,
    // The source writes a numeric 0 for a machine with no order, and the
    // importer keeps it as text; put the number back.
    r.mo === '0' ? 0 : r.mo,
    r.kode_kain, type, r.kelompok_mesin,
    r.jml_kain, r.rpm, null,                            // EFF is empty in the source too
    r.produksi, r.hit_rpm, r.rpm_target, r.ketik_rpm, r.ketik_prod, r.ket_bb,
    r.jam_mulai, r.jam_selesai, r.edited_by
  ];
}

async function exportRows(q) {
  const { clauses, params } = buildFilters(q, { prefix: 'p.' });
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await query(`
    SELECT p.tgl::text AS tgl, p.shift, p.no_mc, p.mo, p.kode_kain, p.type_mc,
           p.kelompok_mesin, p.jml_kain, p.rpm, p.rpm_target, p.hit_rpm,
           p.produksi, p.ketik_rpm, p.ketik_prod, p.ket_bb, o.pick,
           p.edited_by,
           to_char(p.jam_mulai, 'HH24:MI')   AS jam_mulai,
           to_char(p.jam_selesai, 'HH24:MI') AS jam_selesai,
           t.band AS kelompok_layout, t.description AS nama_mesin
    FROM production p
    LEFT JOIN machine_type t ON t.type_mc = p.type_mc
    LEFT JOIN order_info o ON o.mo = p.mo AND o.as_of = p.tgl
    ${where} ORDER BY p.tgl, p.no_mc, p.shift`, params);
  return rows;
}

app.get('/api/export.xlsx', (req, res) => send(res, async () => {
  const rows = await exportRows(req.query);
  const sheet = XLSX.utils.aoa_to_sheet([SOURCE_HEADERS, ...rows.map(sourceRow)]);

  // The date column is written as Excel's own serial with a date format, not
  // as a JS Date: converting a Date lands it a few seconds off midnight, which
  // is invisible on screen but makes an equality test against a date fail.
  const NA = 0x2a;   // SheetJS error code for #N/A

  rows.forEach((r, i) => {
    sheet[XLSX.utils.encode_cell({ r: i + 1, c: 0 })] =
      { t: 'n', v: excelSerial(r.tgl), z: '[$-409]d\\-mmm\\-yy;@' };

    // Every row without a fabric code carries a literal #N/A in the sheet —
    // 72 of them, matching exactly the rows the importer reads as empty.
    // Writing a blank instead would change how the workbook's lookups behave.
    if (r.kode_kain == null) {
      sheet[XLSX.utils.encode_cell({ r: i + 1, c: 10 })] = { t: 'e', v: NA };
    }
  });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, 'SOURCE DATA');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  const span = rows.length ? `${rows[0].tgl}_${rows[rows.length - 1].tgl}` : 'kosong';
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="SOURCE DATA ${span}.xlsx"`);
  res.send(buf);
}));

/* ------------------------------------------------------------------ *
 * CSV export of the current view
 * ------------------------------------------------------------------ */

app.get('/api/export.csv', (req, res) => send(res, async () => {
  // Aliased and fully qualified: order_info also has mo and kode_kain, so a
  // bare column name here is ambiguous once it is joined in.
  const { clauses, params } = buildFilters(req.query, { prefix: 'p.' });
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await query(`
    SELECT p.tgl::text AS tgl, p.shift, p.no_mc, p.kelompok_mesin, p.type_mc,
           t.band AS kelompok_layout, t.description AS nama_mesin,
           p.mo, p.kode_kain, o.pick, p.rpm, p.rpm_target, p.produksi, p.ket_bb,
           to_char(p.jam_mulai, 'HH24:MI')   AS jam_mulai,
           to_char(p.jam_selesai, 'HH24:MI') AS jam_selesai,
           p.edited_by
    FROM production p
    LEFT JOIN machine_type t ON t.type_mc = p.type_mc
    LEFT JOIN order_info o ON o.mo = p.mo AND o.as_of = p.tgl
    ${where} ORDER BY p.tgl, p.no_mc, p.shift`, params);

  // A value starting with = + - or @ is run as a formula when the CSV is opened
  // in Excel. The data comes from a spreadsheet, so it can carry one; prefixing
  // an apostrophe makes Excel treat it as text.
  const cell = (v) => {
    if (v === null || v === undefined) return '';
    let s = String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = ['tgl', 'shift', 'no_mc', 'kelompok_mesin', 'type_mc', 'kelompok_layout',
    'nama_mesin', 'mo', 'kode_kain', 'pick', 'rpm', 'rpm_target', 'produksi', 'ket_bb',
    'jam_mulai', 'jam_selesai', 'edited_by'];
  const csv = [head.join(','), ...rows.map((r) => head.map((h) => cell(r[h])).join(','))].join('\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="machine-production.csv"');
  res.send('﻿' + csv);
}));

// The factory's own loom monitoring data, on its own router and its own
// database. Mounted here only so both are served from one port.
app.use('/api/loom', loomRouter);

app.use(express.static(path.join(__dirname, '..', 'public')));

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`Machine dashboard on http://localhost:${port}`));

process.on('SIGINT', async () => { await pool.end(); process.exit(0); });
