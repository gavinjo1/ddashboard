#!/bin/sh
# Waits for Postgres, applies both schemas, then hands over to the server.
set -e

if [ "${WAIT_FOR_DB:-1}" = "1" ]; then
  node --input-type=module -e '
    import pg from "pg";
    const cfg = {
      host: process.env.PGHOST || "localhost",
      port: Number(process.env.PGPORT || 5432),
      user: process.env.PGUSER,
      password: process.env.PGPASSWORD || undefined,
      database: "postgres",
      connectionTimeoutMillis: 3000
    };
    const deadline = Date.now() + Number(process.env.DB_WAIT_SECONDS || 60) * 1000;
    let lastError;
    while (Date.now() < deadline) {
      const c = new pg.Client(cfg);
      try { await c.connect(); await c.end(); process.exit(0); }
      catch (err) { lastError = err; try { await c.end(); } catch {} }
      await new Promise((r) => setTimeout(r, 1000));
    }
    console.error("Postgres did not answer in time:", lastError?.message);
    process.exit(1);
  '
fi

# Both schemas are CREATE ... IF NOT EXISTS, so this is safe to repeat. Set
# RUN_SETUP=0 on a managed host where the role cannot open the "postgres"
# database or create one, and apply the schema yourself instead.
if [ "${RUN_SETUP:-1}" = "1" ]; then
  node scripts/setup-db.js
fi

exec "$@"
