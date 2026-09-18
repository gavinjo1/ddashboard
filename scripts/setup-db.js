// Creates the database if it is missing, then applies the schema.
import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cfg = {
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || process.env.USER,
  password: process.env.PGPASSWORD || undefined
};
const dbName = process.env.PGDATABASE || 'machine_dashboard';

const admin = new pg.Client({ ...cfg, database: 'postgres' });
await admin.connect();
const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
if (!rowCount) {
  await admin.query(`CREATE DATABASE "${dbName}"`);
  console.log(`created database ${dbName}`);
} else {
  console.log(`database ${dbName} already exists`);
}
await admin.end();

const db = new pg.Client({ ...cfg, database: dbName });
await db.connect();
await db.query(fs.readFileSync(path.join(__dirname, '..', 'server', 'schema.sql'), 'utf8'));
await db.end();
console.log('schema applied');
