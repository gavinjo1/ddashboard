# Machine Report

A dashboard for the AJL daily loom report, backed by PostgreSQL. Reads the
existing Excel workbook as-is — no reformatting of the mill's sheets.

## Setup

Requires Node 18+ and a running PostgreSQL 13+.

```bash
npm install
cp .env.example .env     # edit if your Postgres user/host differ
npm run setup            # creates the database and tables
npm start                # http://localhost:3000
```

## Loading data

From the Import tab, or from the command line:

```bash
npm run import -- "/path/to/file.xlsx"
```


Accepted formats: `.xlsx`, `.xlsm`, `.xlsb`, `.xls`, `.ods`, `.csv`, `.tsv`,
`.txt`, `.json`.

### Columns

A **daily report** sheet needs `TGL`, `NO MC` and `PRODUKSI`. Also read when
present: `SHIFT`, `MO`, `KODE KAIN`, `TYPE MC`, `KELOMPOK MESIN`, `JML KAIN`,
`RPM`, `RPM TARGET`, `HIT RPM`, `KETIK RPM`, `KETIK PROD`, `KET BB`.

A **grade** sheet needs `TGL`, `MO` and `A`. Also read: `KODE`, `B`, `BS`,
`RK`, `TOTAL`.

### Machine type names

The formatted daily sheets (`1`, `2`, … `17`) carry a banded header the data
rows do not:

```
row 4   AJL TOYOTA 1 . . . . . . . . . . . . . .   band, merged across the group
row 5   E SHADE | E SHADE 190 | AJL MEKANICAL      the mill's name, merged per band
row 6   RUMUS | PICK RATA² | MC JLN | PROD
row 7   TOYOTA AJL E-SHD 1 | ... | AJL TOYOTA 1 LAMA   the TYPE MC code
```

The importer reads this into `machine_type`, giving every `TYPE MC` a readable
name. Detection keys on row 5 being the only merged row of the three, and the
result is checked against the `TYPE MC` codes that actually appear in the data,
so a lookalike header elsewhere in the workbook cannot add junk rows.

A type with no entry simply shows its raw code.

**Column order does not matter.** Columns are matched by heading, not position,
so they can be in any order, the header row can sit anywhere in the first 25
rows, and unknown columns are ignored. A sheet with a title above the header,
its columns shuffled and junk columns interleaved imports exactly the same as
the original layout.

Header spelling is matched loosely — `Kelompok Mesin`, `KELOMPOK MESIN` and
`kelompok_mesin` are the same thing, and each field carries several aliases
(`NO MC`, `No Mesin`, `Nomor Mesin`, `Machine`…).

What the importer cannot do is guess a heading it has never seen. When a
required column is missing it names which one, what it did find, and lists the
headings on that row:

> Sheet "Sheet" looks like a production report but is missing NO MC (machine)
> and PRODUKSI (output). Found: TGL (date). Column headings on that row:
> Tanggal, Regu, Kode Kain, Hasil Tenun Meter.

Teach it a new spelling by adding it to `PRODUCTION_FIELDS` in
`server/importer.js`.

### Safety checks on upload

**The file is checked before it is parsed.** An extension is a label anyone can
rename, so `checkFileBytes` looks at the actual bytes: a `.xlsx` must carry a
zip or OLE signature, and a `.csv`/`.tsv`/`.txt` must not start with an
executable, PDF, zip or Office header and must contain no NUL bytes. A renamed
`.exe` or PDF is refused with a message naming what it really is.

**A file with no matching columns is refused**, not partly imported. A sheet has
to carry TGL + NO MC + PRODUKSI, or TGL + MO + A, or it is ignored; if no sheet
in the workbook qualifies, the whole upload is rejected.

**Cell contents are treated as untrusted.** Everything a spreadsheet supplies —
customer, fabric, order, machine, note, even the file name — is HTML-escaped
before it reaches the page. A cell holding `<img src=x onerror=…>` renders as
that text and does not run. The CSV export prefixes any value starting with
`=`, `+`, `-` or `@` with an apostrophe, so Excel opens it as text rather than
executing it as a formula.


### Dates and numbers

Date cells are read as Excel serials rather than converted by the spreadsheet
library, which would apply the host machine's timezone and can shift a whole
report back by a day. Text dates are read as `DD/MM/YYYY` or `YYYY-MM-DD`.

Both `1.234,5` and `1,234.5` parse to `1234.5`.

## Layout

```
server/
  schema.sql    tables and indexes
  db.js         connection pool
  importer.js   file parsing, column matching, upserts
  index.js      HTTP API and static hosting
public/
  index.html    the three tabs
  app.css       tokens and layout
  app.js        state, filters, tables
  charts.js     the SVG charts
scripts/
  setup-db.js   create database, apply schema
  import-file.js  command-line import
```

## API

All production endpoints take the same filters: `from`, `to`, and
comma-separated `shift`, `group`, `type`, `fabric`, `mo`.

| Endpoint | Returns |
|---|---|
| `GET /api/filters` | date range and the distinct values behind each control; types carry `description` and `band` |
| `GET /api/summary` | headline totals plus the previous equal-length period |
| `GET /api/trend` | output and attainment per day |
| `GET /api/search` | orders matching a term in any field, with the matched field named |
| `GET /api/order-history` | one order's day-by-day accumulated and remaining metres, with that day's output |
| `GET /api/order-info` | order header (customer, quantity, accumulated, remaining) for the selected orders or fabrics |
| `GET /api/orders` | per order: SALDO opening balance, output in the period, and the two summed |
| `GET /api/breakdown/:dim` | totals by `group`, `type`, `shift`, `fabric`, `mo` or `machine`; `type` is labelled by name with the code in `code` |
| `GET /api/machines` | per-machine table (`sort`, `dir`) |
| `GET /api/machine/:no` | every shift for one machine |
| `GET /api/stoppages` | stoppage reasons by frequency |
| `GET /api/quality` | grade totals, daily series and fabric breakdown |
| `GET /api/export.csv` | the filtered rows as CSV, with `kelompok_layout` and `nama_mesin` |
| `POST /api/preview` | sheets in an uploaded file, without writing |
| `POST /api/import` | import an uploaded file |
| `GET /api/imports` | the last 25 import runs |

## Screen sizes

One layout, from a 360px phone to a 1920px monitor. No horizontal page scroll at
any width.

| Width | Layout |
|---|---|
| ≥ 1180px | Filters inline, three cards across |
| 1000–1180px | Two cards across |
| 860–1000px | Filters inline, charts stacked |
| < 860px | Filters fold behind a button; one card across |

Below 860px the filter row runs to roughly 500px stacked — half a phone screen
of controls before any data — so it collapses to a single button carrying the
date range and how many filters are set. Wide tables scroll sideways with the
first column pinned, and cells do not wrap: a wrapped
"AJL TOYOTA 910 | AJL 3 AIR TUCKER" turns every row into three lines.

Grid and flex items are given `min-width: 0`. Without it they refuse to shrink
below their content, and a chart measured once at a wide size pins its card open
and never shrinks back — which pushed the whole page sideways on a phone.

## Numbers

Figures follow Indonesian convention: `.` groups thousands and `,` is the
decimal point, so 2019419.4 reads **2.019.419,4**.

Measurements keep the decimals the data actually has, up to two — a shift that
wove 4.24 m shows **4,24**, not 4. Counts (machines, shifts, orders, stoppages)
are never fractional.

The CSV export is deliberately left in plain form — `.` decimals, `,` between
fields — so it stays re-importable and readable by other tools. Opening it in an
Indonesian-locale Excel needs the import dialog rather than a double-click.

## Scope: the SOURCE DATA sheet

Everything on the Production tab comes from the workbook's `SOURCE DATA` sheet
and nothing else. The formatted daily sheets are read only for the machine-type
names in their banded header.

Two of that sheet's columns turned out to be pure derivations and are imported
but not shown: `HIT RPM` is exactly `RPM × JML KAIN` and `KETIK PROD` is exactly
`PRODUKSI ÷ JML KAIN`, in every one of the 5,967 rows. `KETIK RPM` differs from
`RPM` in only 15 rows.

The sheet's 53 `SALDO` rows — each order's opening balance — are imported into
the `saldo` table and served by `GET /api/orders`, but nothing in the UI uses
them yet.

## Order detail

The daily sheets carry an order header above their machine grid: MO, fabric,
customer, `ORDER` (quantity), `COMM` (woven so far) and `SISA` (remaining).
Those are running totals, so the importer reads the block from **every** daily
sheet and keeps whichever is newest per order — no sheet number is hardcoded,
and next month's workbook works the same way. 62 orders come through: 47 from
the last day, 15 from the last sheet each appeared on.

`order_info` keeps **one row per order per day**, so an order's whole
progression is available, not just where it ended up. Two rules keep that
history honest:

- Only sheets named for a day of the month are read, and the date printed on
  the sheet must agree with that name. Workbooks accumulate copies and
  templates — `4 (2)`, `10 (3)`, `FORMAT` — that keep an old date while their
  formulas show today's totals. Taken at face value they overwrite real history
  with the latest figures.
- The sheet's date is looked up in the same compacted row list the header was
  found in. Blank rows are dropped when a sheet is read, so a raw worksheet
  coordinate points at the wrong line.

The **Order detail** card on the Production tab shows them, and only appears
once the view is narrowed to an order or a fabric — the figures describe a whole
order, so they are not affected by the date, machine or shift filters, and the
card says so. Four orders have no quantity entered in the sheet; those show
"no order qty" rather than a progress bar computed against zero.

Narrow to a **single order** and a **Day by day** section appears below it: the
accumulated metres as each daily sheet recorded them, plotted against the order
quantity, with that day's loom output from `SOURCE DATA` beside it. The two
agree — for MO/UW/26389 the jump from 40.820 to 41.626,4 on 5 September is
exactly the 806,4 m the looms logged that day.

## Adding a new day

Export the updated workbook and drop it on the Import tab. Nothing needs tidying
first:

- New dates are added; existing ones are matched on date + shift + machine and
  updated in place, so re-uploading the same file never duplicates.
- A new daily sheet (`18`, `19`, …) is picked up on its own — no sheet number is
  written into the code.
- Order headers, machine-type names and SALDO balances are all re-read each time.

One caveat, and it is about the file rather than the importer: the values are
read from the results Excel caches with each formula. A workbook saved by Excel
always carries them. A file written by a script or converter may not, and those
cells then arrive empty.
