import { Router } from 'express';
import { send } from './errors.js';
import { requireRole } from './auth.js';
import multer from 'multer';
import { loomQuery } from './loom-db.js';
import { importLoomBuffer, isLoomFile } from './loom-importer.js';

/**
 * Everything the Pabrik panel needs, on its own router against its own
 * database. Nothing here reads or writes the daily-report tables.
 */
export const loomRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 60 * 1024 * 1024 } });

/** Date range plus the filter values, so the panel can populate itself. */
loomRouter.get('/meta', (req, res) => send(res, async () => {
  const { rows: [range] } = await loomQuery(
    `SELECT min(tgl)::text AS min_date, max(tgl)::text AS max_date,
            count(*)::int AS rows, count(DISTINCT loom)::int AS looms
     FROM loom_shift`);
  const col = async (c) => (await loomQuery(
    `SELECT DISTINCT ${c} AS v FROM loom_shift WHERE ${c} IS NOT NULL ORDER BY 1`)).rows.map((r) => r.v);
  res.json({ range, looms: await col('loom'), styles: await col('style'), waktu: await col('waktu') });
}));

function where(q) {
  const clauses = [];
  const params = [];
  const add = (sql, v) => { params.push(v); clauses.push(sql.replace('?', `$${params.length}`)); };
  if (q.from) add('tgl >= ?', q.from);
  if (q.to) add('tgl <= ?', q.to);
  for (const [key, col] of [['loom', 'loom'], ['style', 'style'], ['waktu', 'waktu']]) {
    const vals = String(q[key] ?? '').split(',').map((v) => v.trim()).filter(Boolean);
    if (vals.length) add(`${col} = ANY(?)`, vals);
  }
  // A shift the monitor only caught a few minutes of is not a shift; counting
  // it would drag efficiency down for a reason that is not the mill's.
  const FULL = 'COALESCE(run_min,0) + COALESCE(stop_min,0) > 400';
  const build = (list) => (list.length ? `WHERE ${list.join(' AND ')}` : '');
  return {
    sql: build(q.full === '0' ? clauses : [...clauses, FULL]),
    sqlAll: build(clauses),   // same filters, partial shifts included
    params
  };
}

loomRouter.get('/summary', (req, res) => send(res, async () => {
  const { sql, sqlAll, params } = where(req.query);
  const { rows: [s] } = await loomQuery(`
    SELECT count(*)::int                       AS shifts,
           count(DISTINCT loom)::int           AS looms,
           count(DISTINCT tgl)::int            AS days,
           min(tgl)::text                      AS min_date,
           max(tgl)::text                      AS max_date,
           COALESCE(sum(prod_meter), 0)        AS meter,
           COALESCE(sum(run_min), 0) / 60      AS run_hour,
           COALESCE(sum(stop_min), 0) / 60     AS stop_hour,
           CASE WHEN sum(run_min) + sum(stop_min) > 0
                THEN sum(run_min) / (sum(run_min) + sum(stop_min)) * 100 END AS effic,
           COALESCE(sum(total_cnt), 0)         AS stops,
           avg(rpm)                            AS rpm,
           COALESCE(sum(start_miss), 0)        AS start_miss
    FROM loom_shift ${sql}`, params);

  // How much of the export is usable, said plainly rather than hidden.
  const { rows: [cov] } = await loomQuery(`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE COALESCE(run_min,0) + COALESCE(stop_min,0) > 400)::int AS full,
           count(DISTINCT loom)::int AS looms_seen
    FROM loom_shift ${sqlAll}`, params);
  res.json({ ...s, coverage: cov });
}));

/** Stop minutes and counts by cause — the reason this export is worth having. */
loomRouter.get('/stops', (req, res) => send(res, async () => {
  const { sql, params } = where(req.query);
  const causes = [['Weft', 'weft'], ['Warp', 'warp'], ['Manual', 'manual'], ['Doff', 'doff'],
    ['False', 'false'], ['Other', 'other'], ['Leno', 'leno'], ['Beam change', 'wapout']];
  const { rows: [r] } = await loomQuery(`
    SELECT ${causes.map(([, c]) => `COALESCE(sum(${c}_cnt),0) AS ${c}_cnt, COALESCE(sum(${c}_min),0) AS ${c}_min`).join(', ')}
    FROM loom_shift ${sql}`, params);
  res.json(causes.map(([label, c]) => ({ label, count: Number(r[`${c}_cnt`]), minutes: Number(r[`${c}_min`]) }))
    .filter((x) => x.count || x.minutes)
    .sort((a, b) => b.minutes - a.minutes));
}));

/** `by=day` for the daily line, `by=shift` for the individual shifts. */
loomRouter.get('/trend', (req, res) => send(res, async () => {
  const { sql, params } = where(req.query);
  const byDay = (req.query.by ?? 'day') === 'day';
  const { rows } = await loomQuery(`
    SELECT tgl::text AS date,
           ${byDay ? `NULL::text AS waktu, NULL::text AS slot, NULL::text AS crew`
                   : `waktu, slot, max(crew) AS crew`},
           count(*)::int AS looms,
           sum(prod_meter) AS meter,
           sum(run_min) / (sum(run_min) + sum(stop_min)) * 100 AS effic,
           sum(stop_min) / 60 AS stop_hour,
           COALESCE(sum(total_cnt), 0) AS stops
    FROM loom_shift ${sql}
    GROUP BY tgl${byDay ? '' : ', waktu, slot'}
    ORDER BY tgl${byDay ? '' : ', slot'}`, params);
  res.json(rows);
}));

/** Average efficiency by time of day — three bars, never truncated. */
loomRouter.get('/by-waktu', (req, res) => send(res, async () => {
  const { sql, params } = where(req.query);
  const { rows } = await loomQuery(`
    SELECT waktu,
           count(*)::int AS shifts,
           sum(run_min) / (sum(run_min) + sum(stop_min)) * 100 AS effic,
           sum(prod_meter) AS meter,
           sum(stop_min) / 60 AS stop_hour
    FROM loom_shift ${sql}
    ${sql ? 'AND' : 'WHERE'} waktu IS NOT NULL
    GROUP BY waktu
    ORDER BY CASE waktu WHEN 'pagi' THEN 1 WHEN 'siang' THEN 2 ELSE 3 END`, params);
  res.json(rows);
}));

const LOOM_SORTS = { loom: 'loom', effic: 'effic', meter: 'meter', stop: 'stop_hour', stops: 'stops', rpm: 'rpm' };

loomRouter.get('/looms', (req, res) => send(res, async () => {
  const { sql, params } = where(req.query);
  const sort = LOOM_SORTS[req.query.sort] || 'effic';
  const dir = req.query.dir === 'desc' ? 'DESC' : 'ASC';
  const { rows } = await loomQuery(`
    SELECT loom,
           string_agg(DISTINCT style, ', ' ORDER BY style) AS styles,
           count(*)::int                   AS shifts,
           sum(prod_meter)                 AS meter,
           avg(rpm)                        AS rpm,
           sum(run_min) / (sum(run_min) + sum(stop_min)) * 100 AS effic,
           sum(stop_min) / 60              AS stop_hour,
           COALESCE(sum(total_cnt), 0)     AS stops,
           COALESCE(sum(weft_cnt), 0)      AS weft,
           COALESCE(sum(warp_cnt), 0)      AS warp
    FROM loom_shift ${sql}
    GROUP BY loom ORDER BY ${sort} ${dir} NULLS LAST, loom`, params);
  res.json(rows);
}));

loomRouter.post('/import', requireRole('operator'), upload.single('file'), (req, res) => send(res, async () => {
  if (!req.file) return res.status(400).json({ error: 'No file received' });
  if (!isLoomFile(req.file.originalname)) {
    return res.status(400).json({ error: `Unsupported file type: ${req.file.originalname}` });
  }
  res.json(await importLoomBuffer(req.file.buffer, req.file.originalname));
}));

loomRouter.get('/imports', (req, res) => send(res, async () => {
  const { rows } = await loomQuery(
    `SELECT file_name, rows_read, rows_written, periode, status, message,
            to_char(created_at,'YYYY-MM-DD HH24:MI') AS at
     FROM loom_import_log ORDER BY created_at DESC LIMIT 15`);
  res.json(rows);
}));
