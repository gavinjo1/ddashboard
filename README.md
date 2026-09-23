# Machine Report

A dashboard for the AJL daily loom report, backed by PostgreSQL. Reads the
existing Excel workbook as-is — no reformatting of the mill's sheets.

## Two datasets, two databases

| | Production / Quality / Import | Pabrik |
|---|---|---|
| Source | the mill's hand-typed daily report (`.xlsx`) | the looms' own monitoring export (`.xls` Shift Report) |
| Database | `machine_dashboard` | `loom_monitor` |
| Code | `server/index.js`, `server/importer.js` | `server/loom-*.js` |

They measure the same mill but are different systems, and they disagree in
ways that matter — different shift letters, different fabric spellings,
different notion of output. Keeping them apart means a number on screen always
has one unambiguous source.

## Reading the Pabrik numbers

Hours there are **loom-hours**, added up across machines, not hours on a clock.
116 looms in one eight-hour shift give 928 loom-hours, so a single shift can
easily show 179 hours stopped. The tiles and columns say `loom-h` for this
reason.

Shifts the monitor only caught part of are excluded from every figure, and the
count of what was dropped is on the tiles. The date range shown is the range
actually counted, not the range imported — otherwise it would disagree with the
chart beside it.

## Shift rotation

The looms write a fixed **time slot**: A = pagi, B = siang, C = malam. The
mill's paperwork labels the same eight hours by **crew**, and crews move on one
slot every Friday:

```
week 1   A pagi    B siang   C malam
week 2   A siang   B malam   C pagi
week 3   A malam   B pagi    C siang
```

So the two systems can carry different letters for the same shift, and joining
on the letter alone is wrong. The importer derives the crew from the date.

Anchored on the week beginning Friday 11 September 2026 and checked against the
daily report: with this rotation the two sources line up to **0.00 m** per
machine-shift on 16 September and **0.17 m** on the 17th. The other two
rotations are out by 18-26 m.

## Setup

Requires Node 18+ and a running PostgreSQL 13+.

```bash
npm install
cp .env.example .env     # edit if your Postgres user/host differ
npm run setup            # creates both databases and their tables
npm start                # http://localhost:3000
```

Loading a loom export from the command line:

```bash
npm run import:loom -- "/path/to/17 SEPT ALL.xls"
```

Accepted there and on the Pabrik tab: `.xls`, `.xlsx`, `.xlsm`, `.xlsb`,
`.ods`, `.csv`, `.tsv`, `.txt`. The rows are found by their `SORTKEY` header
rather than by sheet name, so a CSV saved from the export's Data sheet — which
arrives with no sheet name at all — works the same as the original workbook.

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
| `GET /api/export.xlsx` | the filtered rows as the workbook's own SOURCE DATA sheet, ID columns rebuilt |
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

## Efficiency target on the daily chart

The monthly sheet (`BULANAN`, "LAPORAN EFFISIENSI & PRODUKSI AJL TOYOTA") holds
`prod100%` — what the mill would have woven that day at 100% efficiency —
alongside the actual output and the resulting efficiency. The Daily output
chart shades the **90–100%** range behind the columns, so the gap to target is
visible without doing arithmetic. September ran 78–86%.

Only the sheet's own **TOTAL** column is imported. The same four columns exist
per machine type, but those eight bands sum to ~757 m more than TOTAL, because
TOTAL is computed from its own average pick rather than by adding the bands up.
Importing both would put two different capacities in one chart.

Two things the sheet does that the import works around:

- It is filled in by hand and lags. 17 September has production but no capacity
  row, so that day simply has no band — the value is not carried forward or
  estimated.
- Its band row repeats "AJL 3 AIR TUCKER" three times where the row above has
  the correct names. The importer does not rely on those labels; it finds the
  TOTAL group from the merged header above it.

Each column is labelled with that day's **output** and, above it, that day's
**efficiency**. The output is rounded to whole metres — at 120.000 m the two
decimals are noise, and dropping them buys the width that keeps neighbouring
labels apart. When the columns are too close for the text to stay clear — a
phone, a tablet, or a long date range — the labels give way to a single label
on the tallest column, and the tooltip carries the rest.

The band is **hidden whenever a filter narrows the machines** — by shift,
machine, group, type, fabric or order. `prod100%` covers every machine for a
whole day, so comparing it with one shift or one order would overstate the
shortfall. The caption says so when it happens.

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

## Exporting back to the workbook

**Export Excel** rebuilds the workbook's own `SOURCE DATA` sheet — all 22
columns in their original order, including the six `ID` columns the dashboard
does not otherwise store:

| Column | Rebuilt as |
|---|---|
| `ID PERSHIFT` | shift + Excel date serial |
| `ID LAP MO` | serial + MO + TYPE MC |
| `ID RPM REAL` | TYPE MC + serial |
| `ID KELOMPOK MESIN` | KELOMPOK MESIN + shift + serial |
| `ID LAY OUT` | NO MC + shift + serial |
| `ID BB` | KET BB + TYPE MC + serial |

Those are the keys every other sheet looks rows up by. Paste the export over
`SOURCE DATA` and the daily sheets, `BULANAN` and `GRADE` recalculate on their
own — their formulas are untouched.

Reproducing those sheets here instead would be the wrong way round: the
workbook holds roughly 50,000 formulas across 28 sheets, and they already work.

Three details decide whether a pasted column behaves like the original, and
each was wrong at first:

- `TGL` is written as Excel's own date serial with the sheet's date format,
  not as text and not via a JS `Date`. Text breaks every date lookup; a `Date`
  lands a few seconds off midnight, which looks right but fails an equality
  test against a date.
- `MO` for a machine with no order is a numeric `0`, as the sheet has it.
- `KODE KAIN` for those rows is a literal `#N/A` error, not a blank. All 72
  such rows in the workbook carry it, matching exactly the rows the importer
  reads as empty, and a blank would change how the workbook's lookups behave.

Checked against the original across all 22 days: **162,162 cells compared,
1 differs**. That one is a stray space typed into `PRODUKSI` for A3 on
17 September — the importer reads it as empty and the export writes it empty,
rather than reproducing a typo.

**Export CSV** stays a plain flat table for anything else.

## Adding one shift by hand

The Import tab also takes a single shift typed in directly, for a shift that
has not reached a file yet.

Only what changes each shift is typed — date, shift, machine, order, output,
RPM, note. The rest is filled from what the data already shows and stated
under the form rather than applied silently:

- **Machine type** and **fabric width count** never vary per machine anywhere
  in the data, so they are taken as given.
- **Fabric code** never varies per order, likewise.
- **Machine group** and **target RPM** do drift, so the most recent value is
  offered and stays editable.

`HIT RPM` and `KETIK PROD` are derived the way the workbook derives them —
`RPM × JML KAIN` and `PRODUKSI ÷ JML KAIN` — so a hand-entered row and an
imported one cannot disagree.

Rows are keyed on date + shift + machine like any other, so saving twice
updates rather than duplicates, and the form says which happened. They carry
`source_file = 'manual entry'` so they can be told apart later. **A file import
covering the same date, shift and machine will overwrite them.**

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
