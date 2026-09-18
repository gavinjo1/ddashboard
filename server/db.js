import pg from 'pg';
import 'dotenv/config';

// Excel gives us numerics as JS numbers; keep them that way coming back out.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => (v === null ? null : parseFloat(v)));
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => (v === null ? null : parseInt(v, 10)));
// Return DATE as the plain YYYY-MM-DD string, not a timezone-shifted Date.
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

export const pool = new pg.Pool({
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || process.env.USER,
  password: process.env.PGPASSWORD || undefined,
  database: process.env.PGDATABASE || 'machine_dashboard',
  max: 10
});

export const query = (text, params) => pool.query(text, params);
