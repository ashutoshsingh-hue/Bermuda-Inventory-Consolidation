/* ===== Bermuda Sort Station — nightly SQLite backup (PLAN.md §11 M5) =====
 * Uses better-sqlite3's online backup API rather than copying the file, so a backup taken
 * mid-write (WAL mode) is always consistent — no risk of grabbing the .db without its .wal.
 */
import fs from 'node:fs';
import path from 'node:path';

const PREFIX = 'bermuda-';
const SUFFIX = '.db';

// owner rule: backups never pile up — only the newest KEEP_BACKUPS are kept (nightly + pre-clear)
export const KEEP_BACKUPS = 2;

export async function backupOnce(db, backupsDir, { keep = KEEP_BACKUPS, now = new Date() } = {}) {
  fs.mkdirSync(backupsDir, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const dest = path.join(backupsDir, `${PREFIX}${stamp}${SUFFIX}`);
  await db.backup(dest);
  pruneOldBackups(backupsDir, keep);
  return dest;
}

// deletes all but the newest `keep` bermuda-*.db files (by modified time); other files untouched
export function pruneOldBackups(backupsDir, keep = KEEP_BACKUPS) {
  const files = fs.readdirSync(backupsDir)
    .filter(f => f.startsWith(PREFIX) && f.endsWith(SUFFIX))
    .map(f => ({ full: path.join(backupsDir, f), t: fs.statSync(path.join(backupsDir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  const old = files.slice(Math.max(0, keep));
  for (const f of old) fs.unlinkSync(f.full);
  return old.length;
}

function msUntil(hour, minute, now) {
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next - now;
}

// fires once a day at hour:minute local time; each run reschedules itself for the next day
export function scheduleNightlyBackup(db, backupsDir, { hour = 22, minute = 15, logger = console } = {}) {
  function scheduleNext() {
    const t = setTimeout(async () => {
      try {
        const dest = await backupOnce(db, backupsDir);
        logger.info?.(`Nightly backup written: ${dest}`);
      } catch (err) {
        logger.error?.(err, 'Nightly backup failed');
      }
      scheduleNext();
    }, msUntil(hour, minute, new Date()));
    t.unref?.(); // never the reason the process stays alive
    return t;
  }
  return scheduleNext();
}
