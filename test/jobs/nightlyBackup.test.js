import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { backupOnce, pruneOldBackups } from '../../src/jobs/nightlyBackup.js';

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'bermuda-backup-')); }

test('backupOnce — writes a consistent, restorable copy of the live DB', async () => {
  const dir = tmpDir();
  const dbPath = path.join(dir, 'live.db');
  const backupsDir = path.join(dir, 'backups');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE t(x)');
  db.prepare('INSERT INTO t VALUES (1)').run();

  const dest = await backupOnce(db, backupsDir, { now: new Date('2026-09-28T22:15:00') });
  assert.ok(fs.existsSync(dest));

  const restored = new Database(dest, { readonly: true });
  assert.deepEqual(restored.prepare('SELECT * FROM t').all(), [{ x: 1 }]);
  restored.close();

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('backupOnce — keeps only the newest 2 backups', async () => {
  const dir = tmpDir();
  const backupsDir = path.join(dir, 'backups');
  fs.mkdirSync(backupsDir, { recursive: true });
  const db = new Database(path.join(dir, 'live.db'));
  db.exec('CREATE TABLE t(x)');
  const names = ['bermuda-a.db', 'bermuda-b.db', 'bermuda-c.db'];
  names.forEach((n, i) => {
    const f = path.join(backupsDir, n); fs.writeFileSync(f, 'x');
    const d = new Date(Date.now() - (10 - i) * 86400000); fs.utimesSync(f, d, d);
  });

  const dest = await backupOnce(db, backupsDir);

  const remaining = fs.readdirSync(backupsDir).filter(f => f.startsWith('bermuda-')).sort();
  assert.equal(remaining.length, 2);
  assert.ok(remaining.includes(path.basename(dest)), 'the fresh backup is kept');
  assert.ok(remaining.includes('bermuda-c.db'), 'the previous newest is kept');

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('pruneOldBackups — leaves non-backup files alone', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'README.txt'), 'keep me');
  const old = new Date(Date.now() - 30 * 86400000);
  fs.utimesSync(path.join(dir, 'README.txt'), old, old);
  pruneOldBackups(dir, 2);
  assert.ok(fs.existsSync(path.join(dir, 'README.txt')));
  fs.rmSync(dir, { recursive: true, force: true });
});
