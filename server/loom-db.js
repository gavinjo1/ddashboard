import pg from 'pg';
import 'dotenv/config';

// Its own pool and its own database: nothing here touches the daily report.
export const loomPool = new pg.Pool({
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || process.env.USER,
  password: process.env.PGPASSWORD || undefined,
  database: process.env.PGDATABASE_LOOM || 'loom_monitor',
  max: 6
});

export const loomQuery = (text, params) => loomPool.query(text, params);
