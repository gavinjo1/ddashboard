-- Loom monitoring export — kept in its own database, separate from the
-- hand-typed daily report. The two measure the same mill but are different
-- systems: this one is written by the looms themselves.

CREATE TABLE IF NOT EXISTS loom_shift (
  tgl          date NOT NULL,
  slot         text NOT NULL,     -- time slot as the loom labels it: A/B/C
  loom         text NOT NULL,
  -- The mill's own crew letter for that slot on that date. Crews rotate every
  -- Friday, so this is derived per date rather than copied from the letter.
  crew         text,
  waktu        text,              -- pagi / siang / malam
  style        text,
  beam         text,

  rpm          numeric,
  effic        numeric,           -- run / (run + stop), percent
  run_min      numeric,
  stop_min     numeric,
  prod_pick    numeric,           -- thousands of picks
  prod_meter   numeric,           -- cloth length, one width

  air_flow     numeric,
  tension      numeric,
  start_miss   numeric,
  sys_press    numeric,
  main_press   numeric,
  sub_press    numeric,

  mttr_warp    numeric,

  warp_cnt     numeric, warp_min    numeric,
  weft_cnt     numeric, weft_min    numeric,
  false_cnt    numeric, false_min   numeric,
  leno_cnt     numeric, leno_min    numeric,
  doff_cnt     numeric, doff_min    numeric,
  wapout_cnt   numeric, wapout_min  numeric,
  manual_cnt   numeric, manual_min  numeric,
  other_cnt    numeric, other_min   numeric,
  total_cnt    numeric, total_min   numeric,

  source_file  text,
  imported_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tgl, slot, loom)
);

CREATE INDEX IF NOT EXISTS loom_shift_tgl_idx   ON loom_shift (tgl);
CREATE INDEX IF NOT EXISTS loom_shift_loom_idx  ON loom_shift (loom);
CREATE INDEX IF NOT EXISTS loom_shift_style_idx ON loom_shift (style);

CREATE TABLE IF NOT EXISTS loom_import_log (
  id           bigserial PRIMARY KEY,
  file_name    text NOT NULL,
  rows_read    integer NOT NULL DEFAULT 0,
  rows_written integer NOT NULL DEFAULT 0,
  periode      text,
  status       text NOT NULL,
  message      text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
