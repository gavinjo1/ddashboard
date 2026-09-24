import XLSX from 'xlsx';
import { AppError } from './errors.js';
// SheetJS 0.20 ships the codepage tables separately and warns without them.
// Legacy .xls and non-UTF-8 CSV carry a codepage, and the mill's loom export
// is .xls — without this, any non-ASCII byte in it decodes wrongly.
import * as cptable from 'xlsx/dist/cpexcel.full.mjs';
XLSX.set_cptable(cptable);
import { loomPool } from './loom-db.js';

/* ------------------------------------------------------------------ *
 * Shift rotation
 *
 * The loom writes a fixed time slot: A = pagi, B = siang, C = malam.
 * The mill's own paperwork labels the same shift by crew, and crews move on
 * one slot every Friday. So the two systems can carry different letters for
 * the same eight hours, and joining them on the letter alone is wrong.
 *
 * Anchored on the week beginning Friday 11 September 2026, verified against
 * the daily report for 16 and 17 September: matching on this rotation lines
 * the two sources up to 0.00 and 0.17 metres per machine-shift, where the
 * other two rotations are out by 18-26 metres.
 * ------------------------------------------------------------------ */

const SLOT_TIME = { A: 'pagi', B: 'siang', C: 'malam' };

// Which time slot each crew works, per rotation state.
const ROTATION = [
  { A: 'pagi',  B: 'siang', C: 'malam' },
  { A: 'siang', B: 'malam', C: 'pagi'  },
  { A: 'malam', B: 'pagi',  C: 'siang' }
];

const ANCHOR_FRIDAY = Date.UTC(2026, 8, 11);   // rotation state 1
const ANCHOR_STATE = 1;
const DAY = 86400000;

/** The Friday that opens the working week containing `iso`. */
function weekFriday(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d);
  const dow = new Date(t).getUTCDay();          // 0 Sun … 5 Fri
  return t - ((dow - 5 + 7) % 7) * DAY;
}

export function rotationFor(iso) {
  const weeks = Math.round((weekFriday(iso) - ANCHOR_FRIDAY) / (7 * DAY));
  return ROTATION[(((ANCHOR_STATE + weeks) % 3) + 3) % 3];
}

/** The mill's crew letter for a loom time slot on a given date. */
export function crewFor(iso, slot) {
  const waktu = SLOT_TIME[slot];
  if (!waktu) return null;
  const state = rotationFor(iso);
  return Object.keys(state).find((crew) => state[crew] === waktu) ?? null;
}

export const timeOfSlot = (slot) => SLOT_TIME[slot] ?? null;

/* ------------------------------------------------------------------ *
 * Reading the export
 * ------------------------------------------------------------------ */

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};

/** "2026/09/17.A" -> { tgl: '2026-09-17', slot: 'A' } */
function parseShiftName(v) {
  const m = /^(\d{4})\/(\d{2})\/(\d{2})\.([ABC])$/.exec(String(v ?? '').trim());
  return m ? { tgl: `${m[1]}-${m[2]}-${m[3]}`, slot: m[4] } : null;
}

// Column positions in the export's Data sheet. They are fixed by the report
// generator, and the header row is checked below before any of this is used.
const COL = {
  shiftname: 1, style: 2, loom: 3, beam: 4, rpm: 5, effic: 6, run: 7, stop: 8,
  pick: 9, meter: 10, air_flow: 13, tension: 17, start_miss: 18,
  sys_press: 19, main_press: 20, sub_press: 21, mttr_warp: 24,
  wapout_cnt: 25, wapout_min: 26, doff_cnt: 27, doff_min: 28,
  manual_cnt: 29, manual_min: 30, other_cnt: 31, other_min: 32,
  warp_cnt: 33, warp_min: 34, weft_cnt: 38, weft_min: 39,
  false_cnt: 43, false_min: 44, leno_cnt: 48, leno_min: 49,
  total_cnt: 55, total_min: 56
};

const EXTS = new Set(['.xls', '.xlsx', '.xlsm', '.xlsb', '.csv', '.tsv', '.txt', '.ods']);
export const isLoomFile = (name) => EXTS.has((name.match(/\.[^.]+$/)?.[0] ?? '').toLowerCase());

/**
 * The export's rows live on a sheet called "Data", but a CSV saved from that
 * sheet arrives as a single unnamed one. So the sheet is found by its SORTKEY
 * header rather than by name, and "Data" is only the preferred starting point.
 */
function findDataSheet(wb) {
  const order = [...new Set(['Data', ...wb.SheetNames])].filter((n) => wb.Sheets[n]);
  for (const name of order) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, blankrows: false, defval: null });
    const headerRow = rows.findIndex((r) => String(r?.[0] ?? '').trim() === 'SORTKEY');
    if (headerRow >= 0) return { name, rows, headerRow };
  }
  return null;
}

export function readLoomExport(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', raw: true, codepage: 65001 });
  const found = findDataSheet(wb);
  if (!found) {
    throw new AppError('Not a loom export: no sheet with a SORTKEY header row. '
      + 'Expected the Shift Report from the loom monitoring system, or a CSV saved from its Data sheet.');
  }
  const { rows, headerRow } = found;

  const head = rows[headerRow].map((v) => String(v ?? '').replace(/\s+/g, ' ').trim().toLowerCase());
  for (const [name, i] of [['loom', COL.loom], ['run (min)', COL.run], ['stop (min)', COL.stop]]) {
    if (!head[i]?.startsWith(name.split(' ')[0])) {
      throw new AppError(`Loom export has an unexpected layout: column ${i} reads "${head[i]}", expected "${name}".`);
    }
  }

  const periode = rows.slice(0, headerRow)
    .map((r) => String(r?.[0] ?? '').trim())
    .find((v) => /period/i.test(v)) ?? null;
  const out = [];
  for (let i = headerRow + 1; i < rows.length; i++) {
    const r = rows[i];
    const when = parseShiftName(r?.[COL.shiftname]);
    const loom = r?.[COL.loom] ? String(r[COL.loom]).trim() : null;
    if (!when || !loom) continue;

    const rec = { tgl: when.tgl, slot: when.slot, loom,
      crew: crewFor(when.tgl, when.slot), waktu: timeOfSlot(when.slot),
      style: r[COL.style] ? String(r[COL.style]).trim() : null,
      beam: r[COL.beam] ? String(r[COL.beam]).trim() : null };
    for (const [k, c] of Object.entries(COL)) {
      if (['shiftname', 'style', 'loom', 'beam'].includes(k)) continue;
      rec[k] = num(r[c]);
    }
    // The export is macro-driven: only the first row keeps a cached Effic and
    // RPM, the rest are formulas Excel never recalculated. Both are exact
    // functions of values that are present, so they are recomputed here.
    //   Effic = run / (run + stop)          verified against the cached row
    //   RPM   = picks inserted / run minute        likewise
    const t = (rec.run ?? 0) + (rec.stop ?? 0);
    if (rec.effic == null && t > 0) rec.effic = (rec.run / t) * 100;
    if (rec.rpm == null && rec.run > 0 && rec.pick != null) rec.rpm = (rec.pick * 1000) / rec.run;

    out.push(rec);
  }
  return { periode, rows: out };
}

/* ------------------------------------------------------------------ *
 * Writing
 * ------------------------------------------------------------------ */

const FIELDS = ['tgl', 'slot', 'loom', 'crew', 'waktu', 'style', 'beam',
  'rpm', 'effic', 'run_min', 'stop_min', 'prod_pick', 'prod_meter',
  'air_flow', 'tension', 'start_miss', 'sys_press', 'main_press', 'sub_press',
  'mttr_warp',
  'warp_cnt', 'warp_min', 'weft_cnt', 'weft_min', 'false_cnt', 'false_min',
  'leno_cnt', 'leno_min', 'doff_cnt', 'doff_min', 'wapout_cnt', 'wapout_min',
  'manual_cnt', 'manual_min', 'other_cnt', 'other_min', 'total_cnt', 'total_min'];

// Export field name -> column name, where they differ.
const AS = { run: 'run_min', stop: 'stop_min', pick: 'prod_pick', meter: 'prod_meter' };

function toRow(rec) {
  const out = {};
  for (const f of FIELDS) out[f] = rec[f] ?? null;
  for (const [from, to] of Object.entries(AS)) if (rec[from] != null) out[to] = rec[from];
  return out;
}

export async function importLoomBuffer(buffer, fileName) {
  const { periode, rows } = readLoomExport(buffer);
  if (!rows.length) throw new AppError('Loom export parsed but held no shift rows.');

  // One row per loom per slot; a repeated key means the later line wins.
  const unique = [...new Map(rows.map((r) => [`${r.tgl}|${r.slot}|${r.loom}`, r])).values()].map(toRow);

  const client = await loomPool.connect();
  try {
    await client.query('BEGIN');
    let written = 0;
    const CHUNK = 300;
    const updates = FIELDS.filter((f) => !['tgl', 'slot', 'loom'].includes(f));
    for (let i = 0; i < unique.length; i += CHUNK) {
      const batch = unique.slice(i, i + CHUNK);
      const values = [];
      const tuples = batch.map((rec, n) => {
        const ph = [...FIELDS, 'source_file'].map((_, c) => `$${n * (FIELDS.length + 1) + c + 1}`);
        values.push(...FIELDS.map((f) => rec[f]), fileName);
        return `(${ph.join(',')})`;
      });
      const res = await client.query(`
        INSERT INTO loom_shift (${FIELDS.join(',')}, source_file)
        VALUES ${tuples.join(',')}
        ON CONFLICT (tgl, slot, loom) DO UPDATE SET
          ${updates.map((f) => `${f} = EXCLUDED.${f}`).join(', ')},
          source_file = EXCLUDED.source_file, imported_at = now()`, values);
      written += res.rowCount;
    }
    await client.query(
      `INSERT INTO loom_import_log (file_name, rows_read, rows_written, periode, status)
       VALUES ($1,$2,$3,$4,'ok')`, [fileName, rows.length, written, periode]);
    await client.query('COMMIT');
    return { file: fileName, periode, read: rows.length, written };
  } catch (err) {
    await client.query('ROLLBACK');
    await client.query(
      `INSERT INTO loom_import_log (file_name, status, message) VALUES ($1,'error',$2)`,
      [fileName, err.message]).catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
