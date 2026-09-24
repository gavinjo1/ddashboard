import crypto from 'node:crypto';

/**
 * An error whose message is written for the person using the dashboard —
 * "this sheet has an unexpected layout", "the file is empty". Everything
 * else is treated as a fault and its text never leaves the server.
 */
export class AppError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.expose = true;
  }
}

/**
 * Wraps an async handler. A PostgreSQL error names tables, columns and
 * sometimes the offending value, so the browser gets a reference code and
 * the detail stays in the server log where it is actually useful.
 */
export const send = (res, fn) => fn().catch((err) => {
  if (err?.expose) return res.status(err.status || 400).json({ error: err.message });

  const ref = crypto.randomBytes(4).toString('hex');
  console.error(`[${ref}]`, err);
  res.status(500).json({
    error: `Terjadi kesalahan di server. Sebutkan kode ini saat melapor: ${ref}`
  });
});
