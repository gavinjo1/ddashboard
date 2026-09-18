// Usage: npm run import -- "<path to xlsx|csv|...>" [SheetName ...]
import fs from 'node:fs';
import path from 'node:path';
import { importBuffer, isSupported } from '../server/importer.js';
import { pool } from '../server/db.js';

const [file, ...sheets] = process.argv.slice(2);
if (!file) {
  console.error('Usage: npm run import -- "<file>" [SheetName ...]');
  process.exit(1);
}
if (!fs.existsSync(file)) { console.error(`Not found: ${file}`); process.exit(1); }
if (!isSupported(file)) { console.error(`Unsupported file type: ${path.extname(file)}`); process.exit(1); }

const results = await importBuffer(fs.readFileSync(file), path.basename(file),
  { only: sheets.length ? sheets : null });

for (const r of results) {
  if (r.status === 'ok') {
    console.log(`  ${r.sheet.padEnd(32)} ${r.dataset.padEnd(11)} ` +
      `read ${String(r.read).padStart(5)}  new ${String(r.inserted ?? 0).padStart(5)}  ` +
      `updated ${String(r.updated ?? 0).padStart(5)}  skipped ${r.skipped}` +
      (r.saldo ? `  saldo ${r.saldo}` : '') +
      (r.duplicates ? `  (${r.duplicates} duplicate keys collapsed)` : ''));
  } else {
    console.log(`  ${r.sheet.padEnd(32)} ERROR  ${r.message}`);
  }
}
await pool.end();
