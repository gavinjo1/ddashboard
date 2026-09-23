// Usage: npm run import:loom -- "<path to loom Shift Report .xls>"
import fs from 'node:fs';
import path from 'node:path';
import { importLoomBuffer } from '../server/loom-importer.js';
import { loomPool } from '../server/loom-db.js';

const [file] = process.argv.slice(2);
if (!file) { console.error('Usage: npm run import:loom -- "<file>"'); process.exit(1); }
if (!fs.existsSync(file)) { console.error(`Not found: ${file}`); process.exit(1); }

const r = await importLoomBuffer(fs.readFileSync(file), path.basename(file));
console.log(`  ${r.file}`);
console.log(`  ${r.periode ?? ''}`);
console.log(`  read ${r.read}  written ${r.written}`);
await loomPool.end();
