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

// The loom monitoring export lives in its own database, on purpose: it is a
// different system measuring the same mill, and mixing the two would blur
// which number came from where.
const loomName = process.env.PGDATABASE_LOOM || 'loom_monitor';
const admin2 = new pg.Client({ ...cfg, database: 'postgres' });
await admin2.connect();
const { rowCount: has } = await admin2.query('SELECT 1 FROM pg_database WHERE datname = $1', [loomName]);
if (!has) {
  await admin2.query(`CREATE DATABASE "${loomName}"`);
  console.log(`created database ${loomName}`);
} else {
  console.log(`database ${loomName} already exists`);
}
await admin2.end();

const loom = new pg.Client({ ...cfg, database: loomName });
await loom.connect();
await loom.query(fs.readFileSync(path.join(__dirname, '..', 'server', 'loom-schema.sql'), 'utf8'));
await loom.end();
console.log('loom schema applied');
