import XLSX from 'xlsx';
import path from 'node:path';
import { pool } from './db.js';

/* ------------------------------------------------------------------ *
 * Header handling
 * ------------------------------------------------------------------ */

// "Kelompok Mesin" / "KELOMPOK  MESIN" / "kelompok_mesin" all collapse to
// KELOMPOKMESIN, so the sheet can be relabelled without breaking the import.
const normHeader = (h) =>
  String(h ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// field -> accepted header spellings (already normalised)
const PRODUCTION_FIELDS = {
  tgl:            ['TGL', 'TANGGAL', 'DATE', 'TANGGALPRODUKSI', 'TGLPRODUKSI', 'TANGGALLAPORAN'],
  shift:          ['SHIFT', 'REGU', 'GILIRAN'],
  no_mc:          ['NOMC', 'NOMESIN', 'MESIN', 'MACHINE', 'MC', 'MACHINENO',
                   'NOMORMESIN', 'NOMORMC', 'NOMRMESIN', 'MCNO', 'NOLOOM'],
  mo:             ['MO', 'NOMO', 'ORDER', 'NOORDER', 'NOMORMO', 'NOMORORDER', 'MONO'],
  kode_kain:      ['KODEKAIN', 'KODE', 'KAIN', 'FABRIC', 'FABRICCODE', 'JENISKAIN'],
  type_mc:        ['TYPEMC', 'TIPEMC', 'TYPEMESIN', 'MACHINETYPE', 'TIPEMESIN', 'JENISMESIN'],
  kelompok_mesin: ['KELOMPOKMESIN', 'GROUPMESIN', 'MACHINEGROUP', 'KELOMPOK', 'GRUPMESIN', 'GRUP'],
  jml_kain:       ['JMLKAIN', 'JUMLAHKAIN', 'JMLHKAIN', 'JUMLAHLEMBAR', 'LEMBAR'],
  rpm:            ['RPM', 'RPMREAL', 'RPMAKTUAL'],
  rpm_target:     ['RPMTARGET', 'TARGETRPM', 'RPMPLAN'],
  hit_rpm:        ['HITRPM'],
  produksi:       ['PRODUKSI', 'PROD', 'PRODUCTION', 'HASIL', 'HASILPRODUKSI', 'OUTPUT'],
  ketik_rpm:      ['KETIKRPM'],
  ketik_prod:     ['KETIKPROD', 'KETIKPRODUKSI'],
  ket_bb:         ['KETBB', 'KETERANGANBB', 'KETERANGAN', 'KET', 'CATATAN']
};

// The order header block on each daily sheet. Both "MO" and "KODE KAIN" appear
// twice on those sheets; mapColumns takes the first, which is the one carrying
// the full MO/UW/... code rather than the shortened KP reference.
const ORDER_FIELDS = {
  mo:          ['MO'],
  kode_kain:   ['KODEKAIN'],
  pick:        ['PICK'],
  customer:    ['CUSTOMER'],
  total_order: ['ORDER', 'TOTALORDER'],
  akumulasi:   ['COMM', 'AKUMULASIPRODUKSI'],
  sisa_order:  ['SISA', 'SISAORDER']
};

const GRADE_FIELDS = {
  tgl:       ['TGL', 'TANGGAL', 'DATE'],
  mo:        ['MO', 'NOMO'],
  kode_kain: ['KODE', 'KODEKAIN', 'KAIN', 'FABRIC'],
  grade_a:   ['A', 'GRADEA'],
  grade_b:   ['B', 'GRADEB'],
  bs:        ['BS', 'BADSTOCK'],
  rk:        ['RK', 'REJECT'],
  total:     ['TOTAL', 'JUMLAH']
};

/**
 * Map each field to a column index. Headers can repeat (the GRADE sheet has
 * two "BS" columns); first occurrence wins, which is the one that holds data.
 */
function mapColumns(headerRow, fields) {
  const norm = headerRow.map(normHeader);
  const map = {};
  for (const [field, aliases] of Object.entries(fields)) {
    for (const alias of aliases) {
      const idx = norm.indexOf(alias);
      if (idx !== -1) { map[field] = idx; break; }
    }
  }
  return map;
}

/* ------------------------------------------------------------------ *
 * Value coercion
 * ------------------------------------------------------------------ */

const EXCEL_EPOCH = Date.UTC(1899, 11, 30);

/** Returns 'YYYY-MM-DD' or null. Accepts Date, Excel serial, or text. */
export function toDate(v) {
  if (v === null || v === undefined || v === '') return null;

  if (v instanceof Date && !isNaN(v)) {
    // Spreadsheet date cells carry no time of day, but converters land them a
    // few seconds either side of midnight in whatever zone they assumed.
    // Snapping to the nearest whole UTC day recovers the date that was typed.
    return new Date(Math.round(v.getTime() / 86400000) * 86400000).toISOString().slice(0, 10);
  }

  if (typeof v === 'number' && isFinite(v)) {
    // Excel serials below ~20000 are more likely a stray number than a date.
    if (v < 20000 || v > 80000) return null;
    return new Date(EXCEL_EPOCH + Math.floor(v) * 86400000).toISOString().slice(0, 10);
  }

  const s = String(v).trim();
  if (!s || /^(saldo|total|jumlah|grand\s*total)$/i.test(s)) return null;

  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);            // 2026-09-01
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;

  m = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/);   // 01/09/2026 (d/m/y)
  if (m) {
    let [, d, mo, y] = m;
    if (y.length === 2) y = String(2000 + Number(y));
    if (Number(mo) > 12 && Number(d) <= 12) [d, mo] = [mo, d];  // tolerate m/d/y
    return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }

  const parsed = new Date(s);
  return isNaN(parsed) ? null : parsed.toISOString().slice(0, 10);
}

/** Returns a finite number or null. Handles "1.234,5" and "1,234.5". */
export function toNum(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;

  let s = String(v).trim().replace(/\s/g, '');
  if (!s || s === '-') return null;
  if (/^[#]?(N\/A|NA|DIV\/0!|VALUE!|REF!|NULL!|NAME\?)$/i.test(s.replace('#', ''))) return null;

  const neg = /^\(.*\)$/.test(s);
  if (neg) s = s.slice(1, -1);
  s = s.replace(/[^\d.,-]/g, '');

  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma > -1 && lastDot > -1) {
    // whichever separator comes last is the decimal point
    s = lastComma > lastDot
      ? s.replace(/\./g, '').replace(',', '.')
      : s.replace(/,/g, '');
  } else if (lastComma > -1) {
    // "1,234" with exactly 3 trailing digits reads as a thousands separator
    s = /^-?\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
  }

  const n = parseFloat(s);
  if (!isFinite(n)) return null;
  return neg ? -n : n;
}

const toText = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' || s === '#N/A' ? null : s;
};

/* ------------------------------------------------------------------ *
 * Workbook reading
 * ------------------------------------------------------------------ */

const EXTS = new Set(['.xlsx', '.xlsm', '.xlsb', '.xls', '.ods', '.csv', '.tsv', '.txt', '.json']);
export const isSupported = (name) => EXTS.has(path.extname(name).toLowerCase());

/** Spreadsheet containers start with a recognisable signature. */
const SIGNATURES = [
  { magic: [0x50, 0x4b, 0x03, 0x04], kind: 'zip' },                          // xlsx/xlsm/ods
  { magic: [0x50, 0x4b, 0x05, 0x06], kind: 'zip' },                          // empty zip
  { magic: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], kind: 'ole' },  // legacy xls
  { magic: [0x09, 0x08], kind: 'biff' }                                      // very old xls
];

const startsWith = (buf, magic) => magic.every((b, i) => buf[i] === b);

/**
 * Guards the parser against files that are not what their extension claims.
 * An extension is a label anyone can rename; this looks at the bytes.
 *
 * Text formats have no signature, so they are checked the other way round —
 * by ruling out the executable and archive headers a .csv must never have, and
 * by rejecting content that is mostly non-text.
 */
export function checkFileBytes(buffer, fileName) {
  const ext = path.extname(fileName).toLowerCase();
  if (!buffer || !buffer.length) throw new Error('The file is empty.');

  const binaryExt = ['.xlsx', '.xlsm', '.xlsb', '.xls', '.ods'];
  if (binaryExt.includes(ext)) {
    if (!SIGNATURES.some((s) => startsWith(buffer, s.magic))) {
      throw new Error(`${fileName} is not a real spreadsheet — its contents do not match a ${ext} file.`);
    }
    return;
  }

  // .csv / .tsv / .txt / .json must be text.
  const forbidden = [
    { magic: [0x4d, 0x5a], name: 'a Windows program' },
    { magic: [0x7f, 0x45, 0x4c, 0x46], name: 'a Linux program' },
    { magic: [0xcf, 0xfa, 0xed, 0xfe], name: 'a macOS program' },
    { magic: [0x25, 0x50, 0x44, 0x46], name: 'a PDF' },
    { magic: [0x50, 0x4b, 0x03, 0x04], name: 'a zip archive' },
    { magic: [0xd0, 0xcf, 0x11, 0xe0], name: 'an Office binary' }
  ];
  const hit = forbidden.find((f) => startsWith(buffer, f.magic));
  if (hit) throw new Error(`${fileName} is named like a text file but is ${hit.name}.`);

  // A NUL byte early on means binary, whatever the name says.
  const head = buffer.subarray(0, 8192);
  if (head.includes(0)) {
    throw new Error(`${fileName} is named like a text file but contains binary data.`);
  }
}

/** Rows as arrays, with the ragged tail padded so column indexes line up. */
function sheetRows(ws) {
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, blankrows: false, defval: null });
  const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
  return rows.map((r) => (r.length === width ? r : [...r, ...Array(width - r.length).fill(null)]));
}

export function readWorkbook(buffer, fileName) {
  checkFileBytes(buffer, fileName);
  if (path.extname(fileName).toLowerCase() === '.json') {
    const parsed = JSON.parse(buffer.toString('utf8'));
    const arr = Array.isArray(parsed) ? parsed : (parsed.rows ?? parsed.data ?? []);
    if (!Array.isArray(arr) || !arr.length) throw new Error('JSON file holds no array of rows');
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(arr), 'data');
    return wb;
  }
  // Keep date cells as Excel serials: converting them here would apply the
  // host machine's timezone and can shift a report a day backwards.
  return XLSX.read(buffer, { type: 'buffer', cellDates: false, raw: true, codepage: 65001 });
}

/**
 * Find the header row and figure out which dataset a sheet holds.
 * Report sheets often carry a title or two above the real header, so scan down.
 */
export function inspectSheet(ws) {
  const rows = sheetRows(ws);
  let best = null;

  for (let i = 0; i < Math.min(rows.length, 25); i++) {
    for (const [dataset, fields, required] of [
      ['production', PRODUCTION_FIELDS, ['tgl', 'no_mc', 'produksi']],
      ['grade', GRADE_FIELDS, ['tgl', 'mo', 'grade_a']]
    ]) {
      const map = mapColumns(rows[i], fields);
      if (!required.every((f) => f in map)) continue;
      const score = Object.keys(map).length;
      if (!best || score > best.score) best = { dataset, headerRow: i, map, score, rows };
    }
  }
  return best; // null when the sheet is not a recognised report
}

/* ------------------------------------------------------------------ *
 * Daily capacity — the monthly efficiency sheet
 *
 *   row 3   ... | TOTAL AJL 1,2,3,4 |          (merged over the group)
 *   row 4   E SHADE | E SHADE190 | ...         (per-type bands)
 *   row 5   TGL | PROD | % | PICK RATA2 | prod100% | PROD | % | ...
 *   row 7+  one row per day of the month
 *
 * Only the TOTAL group is read. The sheet also carries the same four columns
 * per machine type, but those bands sum to a different number than TOTAL
 * (the total uses its own average pick), so taking both would put two
 * conflicting capacities in the same chart.
 * ------------------------------------------------------------------ */

export function readDailyCapacity(ws) {
  const rows = sheetRows(ws);

  for (let r = 0; r < Math.min(rows.length, 20); r++) {
    const head = rows[r].map(normHeader);
    if (head[0] !== 'TGL') continue;

    // Each group is PROD | % | PICK RATA2 | prod100%, so prod100% closes it.
    const ends = head.map((h, c) => (h === 'PROD100' ? c : -1)).filter((c) => c >= 3);
    if (ends.length < 2) continue;

    // The group labelled TOTAL, from the band row above (row 4) or the one
    // above that (row 3) — whichever carries the word.
    const total = ends.find((c) => [r - 1, r - 2]
      .some((br) => br >= 0 && /TOTAL/i.test(String(rows[br]?.[c - 3] ?? ''))));
    if (total === undefined) continue;

    const [cProd, cEff, cPick, cCap] = [total - 3, total - 2, total - 1, total];
    const out = [];
    for (let i = r + 1; i < rows.length; i++) {
      const tgl = toDate(rows[i][0]);
      const prod100 = toNum(rows[i][cCap]);
      // Days the sheet has not been filled in yet are left out rather than
      // carried forward or guessed.
      if (!tgl || !prod100) continue;
      out.push({
        tgl,
        prod: toNum(rows[i][cProd]),
        prod100,
        pick_rata2: toNum(rows[i][cPick]),
        eff_pct: toNum(rows[i][cEff])
      });
    }
    if (out.length) return out;
  }
  return [];
}

async function upsertCapacity(client, entries, sourceFile) {
  if (!entries.length) return 0;
  const cols = ['tgl', 'prod', 'prod100', 'pick_rata2', 'eff_pct'];
  const values = [];
  const tuples = entries.map((e, i) => {
    values.push(...cols.map((c) => e[c]), sourceFile);
    return `(${cols.map((_, c) => `$${i * 6 + c + 1}`).join(',')},$${i * 6 + 6})`;
  });
  const res = await client.query(`
    INSERT INTO daily_capacity (${cols.join(',')}, source_file)
    VALUES ${tuples.join(',')}
    ON CONFLICT (tgl) DO UPDATE SET
      prod = EXCLUDED.prod, prod100 = EXCLUDED.prod100,
      pick_rata2 = EXCLUDED.pick_rata2, eff_pct = EXCLUDED.eff_pct,
      source_file = EXCLUDED.source_file, imported_at = now()`, values);
  return res.rowCount;
}

/* ------------------------------------------------------------------ *
 * Order header
 *
 * Each daily sheet carries, above its machine grid, one row per order:
 * MO, fabric, customer, ORDER (quantity), COMM (woven so far) and SISA
 * (remaining). It is a running total, so the newest sheet wins.
 * ------------------------------------------------------------------ */

/**
 * The sheet's own date, printed just above the order header.
 *
 * It has to be looked up in the same compacted row list the header was found
 * in: sheetRows drops blank rows, so a raw worksheet coordinate points at the
 * wrong line and the date silently comes back empty — which threw the whole
 * block away without any error.
 */
function sheetDateFrom(rows, headerIdx) {
  for (let r = Math.max(0, headerIdx - 6); r < headerIdx; r++) {
    const row = rows[r] || [];
    for (let c = 0; c < Math.min(row.length, 8); c++) {
      const d = toDate(row[c]);
      if (d) return d;
    }
  }
  return null;
}

export function readOrderInfo(ws) {
  const rows = sheetRows(ws);
  for (let r = 0; r < Math.min(rows.length, 20); r++) {
    const map = mapColumns(rows[r], ORDER_FIELDS);
    if (!['mo', 'total_order', 'akumulasi', 'customer'].every((f) => f in map)) continue;

    const as_of = sheetDateFrom(rows, r);
    const out = [];
    for (let i = r + 1; i < rows.length; i++) {
      const mo = toText(rows[i][map.mo]);
      if (!mo) continue;
      if (!/^MO\//i.test(mo)) continue;      // subtotal or blank line
      out.push({
        mo,
        kode_kain:   toText(rows[i][map.kode_kain]),
        customer:    toText(rows[i][map.customer]),
        pick:        toNum(rows[i][map.pick]),
        total_order: toNum(rows[i][map.total_order]),
        akumulasi:   toNum(rows[i][map.akumulasi]),
        sisa_order:  toNum(rows[i][map.sisa_order]),
        as_of
      });
    }
    if (out.length >= 5) return out;
  }
  return [];
}

/** One row per order per day: the whole progression, not just the last state. */
async function upsertOrderInfo(client, entries, sourceFile) {
  if (!entries.length) return 0;
  const cols = ['mo', 'kode_kain', 'customer', 'pick', 'total_order', 'akumulasi', 'sisa_order', 'as_of'];
  const values = [];
  const tuples = entries.map((e, i) => {
    values.push(...cols.map((c) => e[c]), sourceFile);
    return `(${cols.map((_, c) => `$${i * 9 + c + 1}`).join(',')},$${i * 9 + 9})`;
  });
  const res = await client.query(`
    INSERT INTO order_info (${cols.join(',')}, source_file)
    VALUES ${tuples.join(',')}
    ON CONFLICT (mo, as_of) DO UPDATE SET
      kode_kain   = EXCLUDED.kode_kain,
      customer    = EXCLUDED.customer,
      pick        = EXCLUDED.pick,
      total_order = EXCLUDED.total_order,
      akumulasi   = EXCLUDED.akumulasi,
      sisa_order  = EXCLUDED.sisa_order,
      source_file = EXCLUDED.source_file,
      imported_at = now()`, values);
  return res.rowCount;
}

/**
 * Why a workbook produced nothing. A generic "no sheet found" leaves the user
 * guessing, when almost always one column is simply spelled in a way the alias
 * list does not carry — so name the columns that were found, the ones that are
 * missing, and the headers actually seen.
 */
const FIELD_LABEL = {
  tgl: 'TGL (date)', no_mc: 'NO MC (machine)', produksi: 'PRODUKSI (output)',
  mo: 'MO (order)', grade_a: 'A (grade A)'
};

export function diagnose(wb, only = null) {
  let best = null;
  for (const name of wb.SheetNames) {
    if (only && !only.includes(name)) continue;
    let rows;
    try { rows = sheetRows(wb.Sheets[name]); } catch { continue; }

    for (let i = 0; i < Math.min(rows.length, 25); i++) {
      for (const [dataset, fields, required] of [
        ['production', PRODUCTION_FIELDS, ['tgl', 'no_mc', 'produksi']],
        ['grade', GRADE_FIELDS, ['tgl', 'mo', 'grade_a']]
      ]) {
        const map = mapColumns(rows[i], fields);
        const have = required.filter((f) => f in map);
        if (!have.length) continue;
        const score = have.length + Object.keys(map).length / 100;
        if (!best || score > best.score) {
          best = {
            score, sheet: name, dataset, have,
            missing: required.filter((f) => !(f in map)),
            headers: rows[i].filter((h) => h !== null && String(h).trim() !== '')
              .map((h) => String(h).trim()).slice(0, 25)
          };
        }
      }
    }
  }
  return best;
}

/* ------------------------------------------------------------------ *
 * Machine-type legend
 *
 * The daily report sheets carry a banded header the data rows do not:
 *
 *   row N-1   AJL TOYOTA 1 . . . . . . . . . . . .   (band, merged)
 *   row N     E SHADE | E SHADE 190 | AJL MEKANICAL  (the mill's own name)
 *   row N+1   RUMUS | PICK RATA² | MC JLN | PROD
 *   row N+2   TOYOTA AJL E-SHD 1 | ... | AJL TOYOTA 1 LAMA   (TYPE MC code)
 *
 * Reading it gives every TYPE MC a human name, so the dashboard can show
 * "AJL 2 AIR TUCKER" instead of only "AJL TOYOTA CAM 2".
 * ------------------------------------------------------------------ */

/** Horizontal merges starting on `row`, as {startCol: width}. */
function rowMerges(ws, row) {
  const out = new Map();
  for (const m of ws['!merges'] || []) {
    if (m.s.r === row && m.e.r === row && m.e.c > m.s.c) out.set(m.s.c, m.e.c - m.s.c + 1);
  }
  return out;
}

/** Value at a cell, following a merge back to the range's anchor. */
function mergedValue(ws, r, c, merges) {
  const direct = ws[XLSX.utils.encode_cell({ r, c })];
  if (direct && direct.v !== undefined && direct.v !== '') return direct.v;
  for (const m of merges) {
    if (r >= m.s.r && r <= m.e.r && c >= m.s.c && c <= m.e.c) {
      const anchor = ws[XLSX.utils.encode_cell({ r: m.s.r, c: m.s.c })];
      return anchor ? anchor.v : null;
    }
  }
  return null;
}

const legendText = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  // Reject numbers and stray one-character cells.
  return s.length >= 2 && s.length <= 60 && !/^[\d.,%-]+$/.test(s) ? s : null;
};

/**
 * The description row is the only one of the three that is merged — each name
 * spans the four columns of its band — and the TYPE MC code sits two rows below
 * the start of each merge. Requiring that merge is what separates this header
 * from ordinary rows that happen to hold text.
 */
export function readTypeLegend(ws) {
  const merges = ws['!merges'] || [];
  if (!merges.length) return [];
  const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');
  const lastRow = Math.min(range.e.r, 14);
  let best = [];

  for (let r = 0; r + 2 <= lastRow; r++) {
    const spans = rowMerges(ws, r);
    if (spans.size < 4) continue;

    const found = [];
    for (const [c, width] of spans) {
      const description = legendText(ws[XLSX.utils.encode_cell({ r, c })]?.v);
      const type_mc = legendText(ws[XLSX.utils.encode_cell({ r: r + 2, c })]?.v);
      if (!description || !type_mc) continue;

      // The band merge above is not always aligned to the description merge —
      // it can start a column later — so scan across the whole span.
      let band = null;
      for (let bc = c; r > 0 && bc < c + width && !band; bc++) {
        band = legendText(mergedValue(ws, r - 1, bc, merges));
      }
      found.push({ type_mc, description, band, sort_order: c });
    }
    const distinct = new Set(found.map((f) => f.type_mc)).size;
    if (found.length >= 4 && distinct === found.length && found.length > best.length) best = found;
  }
  return best;
}

/** Last value wins when an order appears twice; the sheet lists each once. */
async function upsertSaldo(client, entries, sourceFile) {
  const seen = new Map();
  for (const e of entries) seen.set(e.mo, e);
  const list = [...seen.values()];
  if (!list.length) return 0;

  const values = [];
  const tuples = list.map((e, i) => {
    values.push(e.mo, e.kode_kain, e.produksi, sourceFile);
    return `($${i * 4 + 1},$${i * 4 + 2},$${i * 4 + 3},$${i * 4 + 4})`;
  });
  const res = await client.query(`
    INSERT INTO saldo (mo, kode_kain, produksi, source_file)
    VALUES ${tuples.join(',')}
    ON CONFLICT (mo) DO UPDATE SET
      kode_kain   = EXCLUDED.kode_kain,
      produksi    = EXCLUDED.produksi,
      source_file = EXCLUDED.source_file,
      imported_at = now()`, values);
  return res.rowCount;
}

async function upsertTypes(client, entries, sourceFile) {
  if (!entries.length) return 0;
  // Only keep codes that appear in the data. A workbook has many formatted
  // sheets, and this is what stops a lookalike header becoming a junk row.
  const { rows } = await client.query('SELECT DISTINCT type_mc FROM production WHERE type_mc IS NOT NULL');
  const known = new Set(rows.map((r) => r.type_mc));
  entries = entries.filter((e) => known.has(e.type_mc));
  if (!entries.length) return 0;
  const values = [];
  const tuples = entries.map((e, i) => {
    values.push(e.type_mc, e.description, e.band, e.sort_order, sourceFile);
    return `($${i * 5 + 1},$${i * 5 + 2},$${i * 5 + 3},$${i * 5 + 4},$${i * 5 + 5})`;
  });
  const res = await client.query(`
    INSERT INTO machine_type (type_mc, description, band, sort_order, source_file)
    VALUES ${tuples.join(',')}
    ON CONFLICT (type_mc) DO UPDATE SET
      description = EXCLUDED.description,
      band        = EXCLUDED.band,
      sort_order  = EXCLUDED.sort_order,
      source_file = EXCLUDED.source_file,
      imported_at = now()`, values);
  return res.rowCount;
}

/* ------------------------------------------------------------------ *
 * Import
 * ------------------------------------------------------------------ */

const PROD_COLS = ['tgl', 'shift', 'no_mc', 'mo', 'kode_kain', 'type_mc', 'kelompok_mesin',
  'jml_kain', 'rpm', 'rpm_target', 'hit_rpm', 'produksi', 'ketik_rpm', 'ketik_prod', 'ket_bb'];
const PROD_NUM = new Set(['jml_kain', 'rpm', 'rpm_target', 'hit_rpm', 'produksi', 'ketik_rpm', 'ketik_prod']);

const GRADE_COLS = ['tgl', 'mo', 'kode_kain', 'grade_a', 'grade_b', 'bs', 'rk', 'total'];
const GRADE_NUM = new Set(['grade_a', 'grade_b', 'bs', 'rk', 'total']);

function buildRows(found) {
  const { dataset, headerRow, map, rows } = found;
  const cols = dataset === 'production' ? PROD_COLS : GRADE_COLS;
  const nums = dataset === 'production' ? PROD_NUM : GRADE_NUM;
  const out = [];
  const saldo = [];
  let skipped = 0;

  for (let i = headerRow + 1; i < rows.length; i++) {
    const raw = rows[i];
    if (!raw || raw.every((c) => c === null || c === '')) continue;

    const rec = {};
    for (const col of cols) {
      const idx = map[col];
      const v = idx === undefined ? null : raw[idx];
      rec[col] = col === 'tgl' ? toDate(v) : nums.has(col) ? toNum(v) : toText(v);
    }

    // A row without a real date is a SALDO / subtotal line, not a measurement.
    // SALDO lines still matter: they carry each order's opening balance.
    if (!rec.tgl) {
      const marker = String(raw[map.tgl] ?? '').trim().toUpperCase();
      if (dataset === 'production' && marker === 'SALDO' && rec.mo && rec.produksi !== null) {
        saldo.push({ mo: rec.mo, kode_kain: rec.kode_kain, produksi: rec.produksi });
      }
      skipped++;
      continue;
    }

    if (dataset === 'production') {
      if (!rec.no_mc) { skipped++; continue; }
      rec.shift = rec.shift || '-';
    } else {
      if (!rec.mo) { skipped++; continue; }
      for (const c of GRADE_NUM) rec[c] = rec[c] ?? 0;
      if (!rec.total) rec.total = rec.grade_a + rec.grade_b + rec.bs + rec.rk;
    }
    out.push(rec);
  }
  return { records: out, saldo, skipped };
}

/** Last row wins when a sheet repeats a key, so a corrected line overrides. */
function dedupe(records, keyOf) {
  const seen = new Map();
  for (const r of records) seen.set(keyOf(r), r);
  return [...seen.values()];
}

async function upsert(client, dataset, records, sourceFile, editedBy = null) {
  // Same shape as the normal return: the caller destructures the result, and a
  // bare 0 left `written` undefined, which import_log then stored as NULL for
  // any recognised sheet that turned out to hold no rows.
  if (!records.length) return { inserted: 0, updated: 0, written: 0 };

  const cols = dataset === 'production' ? PROD_COLS : GRADE_COLS;
  const table = dataset === 'production' ? 'production' : 'grade';
  const conflict = dataset === 'production' ? '(tgl, shift, no_mc)' : '(tgl, mo, kode_kain)';
  // Only production carries an editor. A row imported before sign-in existed
  // keeps NULL unless this run actually rewrites it.
  const credited = dataset === 'production';
  const all = [...cols, 'source_file', ...(credited ? ['edited_by'] : [])];
  const updates = cols.filter((c) => !conflict.includes(c));

  // Re-importing the same workbook re-writes every row it contains. Crediting
  // the importer for all of them would put a name against months of figures
  // they never touched, so the stamp only moves when a value actually differs;
  // an unchanged row keeps whatever it had, which for the backlog is nothing.
  const stamp = credited
    ? `CASE WHEN (${updates.map((c) => `${table}.${c}`).join(', ')})
              IS DISTINCT FROM (${updates.map((c) => `EXCLUDED.${c}`).join(', ')})
            THEN EXCLUDED.edited_by ELSE ${table}.edited_by END`
    : null;

  let inserted = 0;
  let updated = 0;
  const CHUNK = 500;
  for (let i = 0; i < records.length; i += CHUNK) {
    const batch = records.slice(i, i + CHUNK);
    const values = [];
    const tuples = batch.map((rec, r) => {
      const ph = all.map((_, c) => `$${r * all.length + c + 1}`);
      values.push(...cols.map((c) => rec[c]), sourceFile, ...(credited ? [editedBy] : []));
      return `(${ph.join(',')})`;
    });

    // xmax is 0 on a freshly inserted row and non-zero on one the conflict
    // clause updated, which is what separates "new day" from "corrected day".
    const sql = `
      INSERT INTO ${table} (${all.join(',')})
      VALUES ${tuples.join(',')}
      ON CONFLICT ${conflict} DO UPDATE SET
        ${updates.map((c) => `${c} = EXCLUDED.${c}`).join(', ')},
        source_file = EXCLUDED.source_file,
        ${credited ? `edited_by = ${stamp},` : ''}
        imported_at = now()
      RETURNING (xmax = 0) AS is_new`;
    const res = await client.query(sql, values);
    for (const row of res.rows) row.is_new ? inserted++ : updated++;
  }
  return { inserted, updated, written: inserted + updated };
}

/**
 * Import every recognisable sheet in a workbook.
 * `only` limits the run to named sheets; `dataset` forces the target table;
 * `editedBy` is the signed-in user credited on every production row written.
 */
export async function importBuffer(buffer, fileName, { only = null, dataset = null, editedBy = null } = {}) {
  const wb = readWorkbook(buffer, fileName);
  const results = [];
  const client = await pool.connect();

  try {
    for (const name of wb.SheetNames) {
      if (only && !only.includes(name)) continue;

      let found;
      try {
        found = inspectSheet(wb.Sheets[name]);
      } catch (err) {
        results.push({ sheet: name, status: 'error', message: err.message });
        continue;
      }
      if (!found) continue;
      if (dataset && found.dataset !== dataset) continue;

      const { records, saldo, skipped } = buildRows(found);
      const keyOf = found.dataset === 'production'
        ? (r) => `${r.tgl}|${r.shift}|${r.no_mc}`
        : (r) => `${r.tgl}|${r.mo}|${r.kode_kain}`;
      const unique = dedupe(records, keyOf);

      try {
        await client.query('BEGIN');
        const { inserted, updated, written } = await upsert(client, found.dataset, unique, fileName, editedBy);
        const saldoWritten = await upsertSaldo(client, saldo, fileName);
        await client.query(
          `INSERT INTO import_log (file_name, sheet_name, dataset, rows_read, rows_written, rows_skipped, status, imported_by)
           VALUES ($1,$2,$3,$4,$5,$6,'ok',$7)`,
          [fileName, name, found.dataset, records.length + skipped, written, skipped, editedBy]
        );
        await client.query('COMMIT');
        results.push({
          sheet: name, dataset: found.dataset, status: 'ok',
          read: records.length + skipped, written, inserted, updated, skipped,
          saldo: saldoWritten,
          duplicates: records.length - unique.length
        });
      } catch (err) {
        await client.query('ROLLBACK');
        await client.query(
          `INSERT INTO import_log (file_name, sheet_name, dataset, status, message, imported_by)
           VALUES ($1,$2,$3,'error',$4,$5)`,
          [fileName, name, found.dataset, err.message, editedBy]
        ).catch(() => {});
        results.push({ sheet: name, dataset: found.dataset, status: 'error', message: err.message });
      }
    }
    // The legend lives on the formatted daily sheets, which carry no data rows.
    // It runs last so it can be checked against the TYPE MC codes just imported.
    if (!dataset) {
      // Order headers: collect every sheet's block, keep the latest per order.
      // Keyed on order + date: every daily sheet contributes its own snapshot,
      // so the order's day-by-day progression is preserved.
      //
      // Only sheets named for a day of the month count, and the date printed on
      // the sheet has to agree with that name. Workbooks accumulate copies and
      // templates — "4 (2)", "10 (3)", "FORMAT" — that keep an old date while
      // their formulas show today's totals. Taken at face value they overwrite
      // real history with the latest figures.
      const orders = new Map();
      for (const name of wb.SheetNames) {
        if (only && !only.includes(name)) continue;
        const day = /^\s*(\d{1,2})\s*$/.exec(name);
        if (!day || Number(day[1]) < 1 || Number(day[1]) > 31) continue;
        try {
          for (const e of readOrderInfo(wb.Sheets[name])) {
            if (!e.as_of) continue;
            if (Number(e.as_of.slice(8, 10)) !== Number(day[1])) continue;
            orders.set(`${e.mo}|${e.as_of}`, e);
          }
        } catch { /* a sheet that will not parse simply has no order block */ }
      }
      if (orders.size) {
        try {
          const written = await upsertOrderInfo(client, [...orders.values()], fileName);
          results.push({ sheet: '(order headers)', dataset: 'order_info', status: 'ok',
            read: orders.size, written, skipped: orders.size - written });
        } catch (err) {
          results.push({ sheet: '(order headers)', dataset: 'order_info',
            status: 'error', message: err.message });
        }
      }

      // Daily capacity, from whichever sheet carries the monthly efficiency grid.
      for (const name of wb.SheetNames) {
        if (only && !only.includes(name)) continue;
        let cap = [];
        try { cap = readDailyCapacity(wb.Sheets[name]); } catch { continue; }
        if (!cap.length) continue;
        try {
          const written = await upsertCapacity(client, cap, fileName);
          results.push({ sheet: `(daily capacity · ${name})`, dataset: 'daily_capacity',
            status: 'ok', read: cap.length, written, skipped: 0 });
        } catch (err) {
          results.push({ sheet: `(daily capacity · ${name})`, dataset: 'daily_capacity',
            status: 'error', message: err.message });
        }
        break;
      }

      const legend = new Map();
      for (const name of wb.SheetNames) {
        if (only && !only.includes(name)) continue;
        try {
          for (const e of readTypeLegend(wb.Sheets[name])) legend.set(e.type_mc, e);
        } catch { /* a sheet that will not parse simply has no legend */ }
      }
      if (legend.size) {
        try {
          const written = await upsertTypes(client, [...legend.values()], fileName);
          if (written) {
            results.push({ sheet: '(machine type names)', dataset: 'machine_type', status: 'ok',
              read: legend.size, written, skipped: legend.size - written });
          }
        } catch (err) {
          results.push({ sheet: '(machine type names)', dataset: 'machine_type',
            status: 'error', message: err.message });
        }
      }
    }
  } finally {
    client.release();
  }

  if (!results.length) {
    const near = diagnose(wb, only);
    if (near) {
      const label = (f) => FIELD_LABEL[f] ?? f;
      throw new Error(
        `Sheet "${near.sheet}" looks like a ${near.dataset} report but is missing ` +
        `${near.missing.map(label).join(' and ')}. ` +
        `Found: ${near.have.map(label).join(', ')}. ` +
        `Column headings on that row: ${near.headers.join(', ')}. ` +
        `Rename the missing column, or check the heading is spelled as the importer expects.`
      );
    }
    throw new Error(
      'No recognisable sheet found. A production sheet needs TGL, NO MC and PRODUKSI columns; ' +
      'a grade sheet needs TGL, MO and A.'
    );
  }
  return results;
}

/** Sheet listing for the upload preview, without writing anything. */
export function previewBuffer(buffer, fileName) {
  const wb = readWorkbook(buffer, fileName);
  return wb.SheetNames.map((name) => {
    const found = inspectSheet(wb.Sheets[name]);
    if (!found) return { sheet: name, dataset: null, rows: 0 };
    const { records } = buildRows(found);
    return { sheet: name, dataset: found.dataset, rows: records.length };
  });
}
