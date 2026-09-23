-- Machine daily report warehouse
-- One row per (date, machine, shift) from the mill's daily report sheet.

CREATE TABLE IF NOT EXISTS production (
  id              bigserial PRIMARY KEY,
  tgl             date        NOT NULL,
  shift           text        NOT NULL,
  no_mc           text        NOT NULL,
  mo              text,
  kode_kain       text,
  type_mc         text,
  kelompok_mesin  text,
  jml_kain        numeric,
  rpm             numeric,
  rpm_target      numeric,
  hit_rpm         numeric,
  produksi        numeric,
  ketik_rpm       numeric,
  ketik_prod      numeric,
  ket_bb          text,
  source_file     text,
  imported_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tgl, shift, no_mc)
);

CREATE INDEX IF NOT EXISTS production_tgl_idx        ON production (tgl);
CREATE INDEX IF NOT EXISTS production_no_mc_idx      ON production (no_mc);
CREATE INDEX IF NOT EXISTS production_kelompok_idx   ON production (kelompok_mesin);
CREATE INDEX IF NOT EXISTS production_type_mc_idx    ON production (type_mc);
CREATE INDEX IF NOT EXISTS production_mo_idx         ON production (mo);

-- Inspection grades, reported per manufacturing order per day.
CREATE TABLE IF NOT EXISTS grade (
  id           bigserial PRIMARY KEY,
  tgl          date        NOT NULL,
  mo           text        NOT NULL,
  kode_kain    text,
  grade_a      numeric     NOT NULL DEFAULT 0,
  grade_b      numeric     NOT NULL DEFAULT 0,
  bs           numeric     NOT NULL DEFAULT 0,
  rk           numeric     NOT NULL DEFAULT 0,
  total        numeric     NOT NULL DEFAULT 0,
  source_file  text,
  imported_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tgl, mo, kode_kain)
);

CREATE INDEX IF NOT EXISTS grade_tgl_idx ON grade (tgl);
CREATE INDEX IF NOT EXISTS grade_mo_idx  ON grade (mo);

-- Opening balance per order, from the rows in the source sheet whose date
-- column reads SALDO instead of a date: production booked against that order
-- before this report period began.
CREATE TABLE IF NOT EXISTS saldo (
  mo          text PRIMARY KEY,
  kode_kain   text,
  produksi    numeric NOT NULL DEFAULT 0,
  source_file text,
  imported_at timestamptz NOT NULL DEFAULT now()
);

-- Daily capacity from the monthly efficiency sheet: what the mill would have
-- woven that day at 100% efficiency. Only the sheet's own TOTAL column is
-- taken — its eight per-type bands sum to a slightly different figure because
-- the total is computed from its own average pick, and mixing the two would
-- give two different answers to the same question.
CREATE TABLE IF NOT EXISTS daily_capacity (
  tgl         date PRIMARY KEY,
  prod        numeric,   -- actual, kept only to verify the row lines up
  prod100     numeric,   -- output at 100% efficiency
  pick_rata2  numeric,
  eff_pct     numeric,
  source_file text,
  imported_at timestamptz NOT NULL DEFAULT now()
);

-- Order header from the daily report sheets: who it is for, how much was
-- ordered, how much has been woven so far and what is left. Keyed on the order,
-- holding whichever daily sheet is most recent (`as_of`).
-- Migration: order_info once held only the newest snapshot, keyed on mo alone.
-- It now keeps one row per order per day, so the table is rebuilt when the old
-- single-column key is found. The contents are re-read from the workbook.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname = 'order_info' AND c.contype = 'p' AND array_length(c.conkey, 1) = 1
  ) THEN
    DROP TABLE order_info;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS order_info (
  mo          text NOT NULL,
  kode_kain   text,
  customer    text,
  pick        numeric,
  total_order numeric,
  akumulasi   numeric,
  sisa_order  numeric,
  as_of       date NOT NULL,
  source_file text,
  imported_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (mo, as_of)
);

CREATE INDEX IF NOT EXISTS order_info_kode_idx  ON order_info (kode_kain);
CREATE INDEX IF NOT EXISTS order_info_as_of_idx ON order_info (as_of);

-- Machine-type legend, read from the banded header on the daily report sheets:
-- the mill's own name for each loom type ("E SHADE", "AJL 2 AIR TUCKER")
-- alongside the technical TYPE MC code used in the data rows.
CREATE TABLE IF NOT EXISTS machine_type (
  type_mc     text PRIMARY KEY,
  description text NOT NULL,
  band        text,
  -- Column position in the sheet, so lists read left-to-right as the report
  -- does (E SHADE first) instead of alphabetically.
  sort_order  integer,
  source_file text,
  imported_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE machine_type ADD COLUMN IF NOT EXISTS sort_order integer;

-- Import audit trail.
CREATE TABLE IF NOT EXISTS import_log (
  id           bigserial PRIMARY KEY,
  file_name    text        NOT NULL,
  sheet_name   text,
  dataset      text        NOT NULL,
  rows_read    integer     NOT NULL DEFAULT 0,
  rows_written integer     NOT NULL DEFAULT 0,
  rows_skipped integer     NOT NULL DEFAULT 0,
  status       text        NOT NULL,
  message      text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
