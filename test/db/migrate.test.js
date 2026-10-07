import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openDb } from '../../src/db/migrate.js';

function tmpDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bermuda-migrate-'));
  return { dir, file: path.join(dir, 'test.db') };
}

const CORE_TABLES_SQL = `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE locations (code TEXT PRIMARY KEY, aisle INT, tote INT, part INT, is_overflow INT DEFAULT 0, used INT DEFAULT 0);
  CREATE TABLE loc_pid (location_code TEXT, pid TEXT, placed INT DEFAULT 0, reserved INT DEFAULT 0, PRIMARY KEY (location_code, pid));
  CREATE TABLE loads (id INTEGER PRIMARY KEY, file_name TEXT, loaded_at TEXT, loaded_by TEXT, rows INT, new_totes INT, refreshed INT, skipped_taken INT, conflicts INT);
  CREATE TABLE events (id INTEGER PRIMARY KEY, ts TEXT NOT NULL, shift TEXT, station_id TEXT, operator TEXT, type TEXT NOT NULL, open_tote TEXT, input_raw TEXT, barcode TEXT, result TEXT, location_code TEXT, pid TEXT, detail TEXT);
  CREATE TABLE alerts (id INTEGER PRIMARY KEY, ts TEXT NOT NULL, type TEXT NOT NULL, message TEXT, resolved_by TEXT, resolved_at TEXT);
  CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, role TEXT NOT NULL, pin_hash TEXT NOT NULL, active INT NOT NULL DEFAULT 1);
  CREATE TABLE stations (id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, active INT NOT NULL DEFAULT 1, current_operator TEXT, open_tote TEXT, last_scan_barcode TEXT, last_seen TEXT);
  CREATE TABLE sessions (token TEXT PRIMARY KEY, user_id INTEGER, station_id TEXT, created_at TEXT, expires_at TEXT);
`;

// build a v1-shaped DB by hand (the CHECK constraints/columns as they were before 'M' existed)
function buildV1Db(file) {
  const db = new Database(file);
  db.exec(`
    CREATE TABLE totes (
      tote_id TEXT PRIMARY KEY, tote_number TEXT, state TEXT NOT NULL CHECK (state IN ('H','O','C')),
      load_id INT, station_id TEXT, operator TEXT, shift TEXT, opened_at TEXT, closed_at TEXT
    );
    CREATE TABLE barcodes (
      barcode TEXT PRIMARY KEY, pid TEXT NOT NULL, tote_id TEXT, partition TEXT,
      processable INT NOT NULL DEFAULT 0, state TEXT NOT NULL CHECK (state IN ('H','P','O','N','X')),
      location_code TEXT, placed_at TEXT, placed_station TEXT, placed_shift TEXT, nf_at TEXT, ho_at TEXT
    );
    CREATE TABLE pids (pid TEXT PRIMARY KEY, r INT NOT NULL DEFAULT 0, c INT NOT NULL DEFAULT 0, h INT NOT NULL DEFAULT 0, n INT NOT NULL DEFAULT 0);
  `);
  db.exec(CORE_TABLES_SQL);
  db.prepare("INSERT INTO totes (tote_id, tote_number, state) VALUES ('T1', '1', 'C')").run();
  db.prepare("INSERT INTO barcodes (barcode, pid, tote_id, processable, state) VALUES ('B1', 'P1', 'T1', 1, 'O')").run();
  db.prepare('INSERT INTO pids (pid, r, c, h, n) VALUES (?, ?, ?, ?, ?)').run('P1', 0, 0, 1, 0);
  db.pragma('user_version = 1');
  db.close();
}

test('migrate — a v1 DB upgrades all the way to the latest version: totes/barcodes accept the M state, pids gains m, existing rows survive', () => {
  const { dir, file } = tmpDbPath();
  buildV1Db(file);

  const db = openDb(file); // should run migrateV1toV2 -> migrateV2toV3 -> migrateV3toV4 silently
  assert.equal(db.pragma('user_version', { simple: true }), 5);

  // pre-existing data preserved
  assert.deepEqual(db.prepare('SELECT tote_id, state FROM totes').get(), { tote_id: 'T1', state: 'C' });
  assert.deepEqual(db.prepare('SELECT barcode, state FROM barcodes').get(), { barcode: 'B1', state: 'O' });
  const pidRow = db.prepare('SELECT * FROM pids').get();
  assert.equal(pidRow.h, 1);
  assert.equal(pidRow.m, 0); // new column, defaulted

  // the widened CHECK constraint now accepts 'M'
  assert.doesNotThrow(() => db.prepare("INSERT INTO totes (tote_id, tote_number, state) VALUES ('T2', '2', 'M')").run());
  assert.doesNotThrow(() => db.prepare("INSERT INTO barcodes (barcode, pid, tote_id, state) VALUES ('B2', 'P1', 'T2', 'M')").run());
  assert.doesNotThrow(() => db.prepare('UPDATE pids SET m = 5 WHERE pid = ?').run('P1'));

  // v4's new settings keys are present even though this DB never had a settings row at all
  const settings = JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'settings'").get().value);
  assert.deepEqual(settings.processableStatus, ['AVAILABLE']);
  assert.equal(settings.batchSize, 50);

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('migrate — re-opening an already-current DB is a no-op (idempotent)', () => {
  const { dir, file } = tmpDbPath();
  const db1 = openDb(file);
  db1.close();
  const db2 = openDb(file);
  assert.equal(db2.pragma('user_version', { simple: true }), 5);
  db2.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// build a v2-shaped DB by hand (post-M-state, pre-route_history, still has overflowAisle/
// overflowFromTote in its persisted settings — the shape migrateV2toV3 needs to handle)
function buildV2Db(file, { settings = { aisles: 5, totesPerAisle: 22, overflowAisle: 5, overflowFromTote: 13, partitions: 4, cap: 120, headroomPct: 10, softPidCap: 20, autoCloseSharePct: 90 } } = {}) {
  const db = new Database(file);
  db.exec(`
    CREATE TABLE totes (
      tote_id TEXT PRIMARY KEY, tote_number TEXT, state TEXT NOT NULL CHECK (state IN ('H','O','C','M')),
      load_id INT, station_id TEXT, operator TEXT, shift TEXT, opened_at TEXT, closed_at TEXT
    );
    CREATE TABLE barcodes (
      barcode TEXT PRIMARY KEY, pid TEXT NOT NULL, tote_id TEXT, partition TEXT,
      processable INT NOT NULL DEFAULT 0, state TEXT NOT NULL CHECK (state IN ('H','P','O','N','X','M')),
      location_code TEXT, placed_at TEXT, placed_station TEXT, placed_shift TEXT, nf_at TEXT, ho_at TEXT
    );
    CREATE TABLE pids (pid TEXT PRIMARY KEY, r INT NOT NULL DEFAULT 0, c INT NOT NULL DEFAULT 0, h INT NOT NULL DEFAULT 0, n INT NOT NULL DEFAULT 0, m INT NOT NULL DEFAULT 0);
  `);
  db.exec(CORE_TABLES_SQL);
  if (settings) db.prepare("INSERT INTO settings (key, value) VALUES ('settings', ?)").run(JSON.stringify(settings));
  // the full aisles x totesPerAisle x partitions shape, same as the live app always generated
  // pre-overflow-removal, with the trailing aisle's overflow-marked totes flagged
  const ins = db.prepare('INSERT INTO locations (code, aisle, tote, part, is_overflow, used) VALUES (?,?,?,?,?,?)');
  for (let a = 1; a <= settings.aisles; a++) for (let t = 1; t <= settings.totesPerAisle; t++) for (let p = 1; p <= settings.partitions; p++) {
    const ov = a === settings.overflowAisle && t >= settings.overflowFromTote ? 1 : 0;
    ins.run(`A${a}-T${String(t).padStart(2, '0')}-P${p}`, a, t, p, ov, 0);
  }
  db.pragma('user_version = 2');
  return db;
}

test('migrate — v2 to v3: collapses overflow settings into lastAisleTotes = totesPerAisle, never deleting a location', () => {
  const { dir, file } = tmpDbPath();
  // overflowFromTote === totesPerAisle is exactly the real-world shape that exposed the bug:
  // only the single trailing tote (A5-T20) was ever marked overflow
  const before = buildV2Db(file, { settings: { aisles: 5, totesPerAisle: 20, overflowAisle: 5, overflowFromTote: 20, partitions: 4, cap: 120, headroomPct: 10, softPidCap: 20, autoCloseSharePct: 90 } });
  const totalBefore = before.prepare('SELECT COUNT(*) AS n FROM locations').get().n;
  before.close();

  const db = openDb(file);
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='route_history'").get());

  const settings = JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'settings'").get().value);
  assert.equal('overflowAisle' in settings, false);
  assert.equal('overflowFromTote' in settings, false);
  assert.equal(settings.lastAisleTotes, settings.totesPerAisle); // the fix: never shrinks below the original shape

  // not a single location was deleted — A5-T20 (the exact code the old bug dropped) survives, now as A5-T100
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM locations').get().n, totalBefore);
  assert.ok(db.prepare("SELECT 1 FROM locations WHERE code = 'A5-T100-P1'").get()); // renumbered by v5: aisle 5 starts at tote 81

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('migrate — v2 to v3: real inventory sitting in a formerly-overflow location is left untouched, never discarded', () => {
  const { dir, file } = tmpDbPath();
  const before = buildV2Db(file);
  before.prepare("UPDATE locations SET used = 3 WHERE code = 'A5-T15-P1'").run();
  before.prepare("INSERT INTO loc_pid (location_code, pid, placed, reserved) VALUES ('A5-T15-P1', 'P1', 3, 3)").run();
  before.close();

  const db = openDb(file); // must not throw — nothing is ever deleted by this migration anymore
  assert.equal(db.prepare("SELECT used FROM locations WHERE code = 'A5-T103-P1'").get().used, 3);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM loc_pid WHERE location_code = 'A5-T103-P1'").get().n, 1);

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// build a v3-shaped DB (post-route_history, pre-v4-settings) directly, so v4's behavior can be
// tested in isolation without also re-exercising v2->v3's collapse on every case
function buildV3Db(file, settings) {
  const db = new Database(file);
  db.exec(`
    CREATE TABLE totes (
      tote_id TEXT PRIMARY KEY, tote_number TEXT, state TEXT NOT NULL CHECK (state IN ('H','O','C','M')),
      load_id INT, station_id TEXT, operator TEXT, shift TEXT, opened_at TEXT, closed_at TEXT
    );
    CREATE TABLE barcodes (
      barcode TEXT PRIMARY KEY, pid TEXT NOT NULL, tote_id TEXT, partition TEXT,
      processable INT NOT NULL DEFAULT 0, state TEXT NOT NULL CHECK (state IN ('H','P','O','N','X','M')),
      location_code TEXT, placed_at TEXT, placed_station TEXT, placed_shift TEXT, nf_at TEXT, ho_at TEXT
    );
    CREATE TABLE route_history (
      id INTEGER PRIMARY KEY, status TEXT NOT NULL CHECK (status IN ('planned','active','completed')),
      created_at TEXT NOT NULL, started_at TEXT, completed_at TEXT, created_by TEXT,
      tote_ids TEXT NOT NULL, projected TEXT NOT NULL, actual TEXT, note TEXT
    );
    CREATE TABLE pids (pid TEXT PRIMARY KEY, r INT NOT NULL DEFAULT 0, c INT NOT NULL DEFAULT 0, h INT NOT NULL DEFAULT 0, n INT NOT NULL DEFAULT 0, m INT NOT NULL DEFAULT 0);
  `);
  db.exec(CORE_TABLES_SQL);
  if (settings) db.prepare("INSERT INTO settings (key, value) VALUES ('settings', ?)").run(JSON.stringify(settings));
  db.pragma('user_version = 3');
  return db;
}

test('migrate — v3 to v4: adds batchSize/eligibility settings with defaults when the rack is empty, and applies the new 60-tote layout', () => {
  const { dir, file } = tmpDbPath();
  buildV3Db(file, { aisles: 5, totesPerAisle: 20, lastAisleTotes: 20, partitions: 4, cap: 120, headroomPct: 10, softPidCap: 20, autoCloseSharePct: 90 }).close();

  const db = openDb(file);
  assert.equal(db.pragma('user_version', { simple: true }), 5);
  const settings = JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'settings'").get().value);
  assert.equal(settings.batchSize, 50);
  assert.deepEqual(settings.processableStatus, ['AVAILABLE']);
  assert.deepEqual(settings.processableAvailability, ['NOT_FOUND', 'NOT_FOUND_HOLD', 'AVAILABLE']);
  assert.equal(settings.aisles, 3);
  assert.equal(settings.totesPerAisle, 20);
  assert.equal(settings.lastAisleTotes, 20);
  assert.equal(settings.cap, 100);
  assert.equal(settings.headroomPct, 5);

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('migrate — v3 to v4: never changes layout/capacity while real stock is placed, but still adds the new settings keys', () => {
  const { dir, file } = tmpDbPath();
  const before = buildV3Db(file, { aisles: 5, totesPerAisle: 20, lastAisleTotes: 20, partitions: 4, cap: 120, headroomPct: 10, softPidCap: 20, autoCloseSharePct: 90 });
  const ins = before.prepare('INSERT INTO locations (code, aisle, tote, part, is_overflow, used) VALUES (?,?,?,?,0,?)');
  ins.run('A1-T01-P1', 1, 1, 1, 7); // real stock on the rack
  before.close();

  const db = openDb(file);
  const settings = JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'settings'").get().value);
  // layout/capacity untouched — still the old 5-aisle/22x... shape, not silently reshaped to 240
  assert.equal(settings.aisles, 5);
  assert.equal(settings.totesPerAisle, 20);
  assert.equal(settings.cap, 120);
  assert.equal(settings.headroomPct, 10);
  // the new operational keys are still added, since they don't affect physical placement
  assert.equal(settings.batchSize, 50);
  assert.deepEqual(settings.processableStatus, ['AVAILABLE']);

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('migrate — v3 to v4: a loc_pid reservation (no used>0 yet) also counts as "stock placed" and blocks the layout change', () => {
  const { dir, file } = tmpDbPath();
  const before = buildV3Db(file, { aisles: 5, totesPerAisle: 20, lastAisleTotes: 20, partitions: 4, cap: 120, headroomPct: 10, softPidCap: 20, autoCloseSharePct: 90 });
  before.prepare('INSERT INTO loc_pid (location_code, pid, placed, reserved) VALUES (?, ?, ?, ?)').run('A1-T01-P1', 'P1', 0, 4);
  before.close();

  const db = openDb(file);
  const settings = JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'settings'").get().value);
  assert.equal(settings.aisles, 5); // layout untouched

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('migrate — v4 to v5: aisle 2/3 codes are renumbered (T21.., T41..) and placed barcodes, loc_pid and events follow', () => {
  const { dir, file } = tmpDbPath();
  const db0 = openDb(file);
  const per = 20;
  const ins = db0.prepare('INSERT INTO locations (code, aisle, tote, part, is_overflow, used) VALUES (?,?,?,?,0,0)');
  for (let a = 1; a <= 3; a++) for (let t = 1; t <= per; t++) for (let p = 1; p <= 4; p++) ins.run(`A${a}-T${String(t).padStart(2, '0')}-P${p}`, a, t, p); // v4 shape: T01 restarts in every aisle
  db0.prepare("INSERT INTO settings (key, value) VALUES ('settings', ?)").run(JSON.stringify({ totesPerAisle: per }));
  db0.prepare("UPDATE locations SET used = 2 WHERE code IN ('A2-T05-P3', 'A3-T20-P1')").run();
  db0.prepare("INSERT INTO loc_pid (location_code, pid, placed, reserved) VALUES ('A2-T05-P3', 'PX', 2, 2), ('A3-T20-P1', 'PY', 2, 2)").run();
  db0.prepare("INSERT INTO barcodes (barcode, pid, tote_id, partition, processable, state, location_code) VALUES ('BX1', 'PX', 'T', '1', 1, 'P', 'A2-T05-P3'), ('BY1', 'PY', 'T', '1', 1, 'P', 'A3-T20-P1'), ('BA1', 'PA', 'T', '1', 1, 'P', 'A1-T05-P1')").run();
  db0.prepare("INSERT INTO events (ts, type, location_code) VALUES ('2026-10-06 10:00:00', 'scan', 'A2-T05-P3')").run();
  db0.pragma('user_version = 4');
  db0.close();

  const db = openDb(file);
  assert.equal(db.pragma('user_version', { simple: true }), 5);
  const one = sql => db.prepare(sql).get();
  assert.equal(one("SELECT used FROM locations WHERE code = 'A2-T25-P3'").used, 2);   // 05 + 20
  assert.equal(one("SELECT used FROM locations WHERE code = 'A3-T60-P1'").used, 2);   // 20 + 40
  assert.equal(one("SELECT COUNT(*) n FROM locations WHERE code = 'A2-T05-P3'").n, 0);
  assert.equal(one("SELECT tote FROM locations WHERE code = 'A3-T60-P1'").tote, 60);
  assert.equal(one("SELECT location_code l FROM loc_pid WHERE pid = 'PX'").l, 'A2-T25-P3');
  assert.equal(one("SELECT location_code l FROM barcodes WHERE barcode = 'BY1'").l, 'A3-T60-P1');
  assert.equal(one("SELECT location_code l FROM barcodes WHERE barcode = 'BA1'").l, 'A1-T05-P1'); // aisle 1 is untouched
  assert.equal(one("SELECT location_code l FROM events WHERE type = 'scan'").l, 'A2-T25-P3');
  assert.equal(one('SELECT COUNT(*) n FROM locations').n, 240);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
