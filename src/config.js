/* ===== Bermuda Sort Station — env + defaults (PLAN.md §7) ===== */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const config = {
  root: ROOT,
  port: Number(process.env.PORT) || 8080,
  host: '0.0.0.0',
  dbPath: path.resolve(ROOT, process.env.DB_PATH || 'data/bermuda.db'),
  backupsDir: path.resolve(ROOT, 'backups'),
  tz: process.env.TZ || 'Asia/Kolkata',
  // PLAN.md §3 — shift boundaries (local wall clock, see src/core/shift.js)
  shiftA: { start: 6, end: 14 },
  shiftB: { start: 14, end: 22 },
};
