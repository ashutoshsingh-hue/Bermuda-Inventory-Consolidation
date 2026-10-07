/* ===== Bermuda Sort Station — open + migrate the SQLite file (STRUCTURE.md §5) ===== */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { defaultSettings } from '../core/state.js';

const SCHEMA_VERSION = 5;

export function openDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  try {
    migrate(db);
  } catch (err) {
    db.close(); // don't leak an open handle on a refused migration (e.g. blocked overflow data)
    throw err;
  }
  return db;
}

function migrate(db) {
  const current = db.pragma('user_version', { simple: true });
  if (current >= SCHEMA_VERSION) return;
  db.transaction(() => {
    if (current === 0) {
      // fresh DB: schema.sql is already the current (v4) shape, nothing else to do
      const schemaSql = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
      db.exec(schemaSql);
    } else {
      if (current === 1) migrateV1toV2(db);
      if (current <= 2) migrateV2toV3(db);
      if (current <= 3) migrateV3toV4(db);
      migrateV4toV5(db);
    }
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  })();
}

// v2: adds the 'M' (tote/barcode marked NOT FOUND) state and pids.m. SQLite can't widen a
// CHECK constraint in place, so totes/barcodes are rebuilt (rename -> create -> copy -> drop);
// pids just gets a new column.
function migrateV1toV2(db) {
  db.exec(`
    ALTER TABLE totes RENAME TO totes_v1;
    CREATE TABLE totes (
      tote_id TEXT PRIMARY KEY,
      tote_number TEXT,
      state TEXT NOT NULL CHECK (state IN ('H', 'O', 'C', 'M')),
      load_id INT,
      station_id TEXT,
      operator TEXT,
      shift TEXT,
      opened_at TEXT,
      closed_at TEXT
    );
    INSERT INTO totes (tote_id, tote_number, state, load_id, station_id, operator, shift, opened_at, closed_at)
      SELECT tote_id, tote_number, state, load_id, station_id, operator, shift, opened_at, closed_at FROM totes_v1;
    DROP TABLE totes_v1;
    CREATE INDEX IF NOT EXISTS ix_totes_state ON totes(state);

    ALTER TABLE barcodes RENAME TO barcodes_v1;
    CREATE TABLE barcodes (
      barcode TEXT PRIMARY KEY,
      pid TEXT NOT NULL,
      tote_id TEXT,
      partition TEXT,
      processable INT NOT NULL DEFAULT 0,
      state TEXT NOT NULL CHECK (state IN ('H', 'P', 'O', 'N', 'X', 'M')),
      location_code TEXT,
      placed_at TEXT,
      placed_station TEXT,
      placed_shift TEXT,
      nf_at TEXT,
      ho_at TEXT
    );
    INSERT INTO barcodes (barcode, pid, tote_id, partition, processable, state, location_code, placed_at, placed_station, placed_shift, nf_at, ho_at)
      SELECT barcode, pid, tote_id, partition, processable, state, location_code, placed_at, placed_station, placed_shift, nf_at, ho_at FROM barcodes_v1;
    DROP TABLE barcodes_v1;
    CREATE INDEX IF NOT EXISTS ix_barcodes_pid ON barcodes(pid, state);
    CREATE INDEX IF NOT EXISTS ix_barcodes_tote ON barcodes(tote_id, state);

    ALTER TABLE pids ADD COLUMN m INT NOT NULL DEFAULT 0;
  `);
}

// v3: (a) adds route_history for the Route Planner; (b) the overflow concept was removed
// (PLAN.md §5.5, owner-approved) — any old persisted overflowAisle/overflowFromTote settings
// collapse into the new flat lastAisleTotes field. Non-destructive by design: every location
// code that existed before (including ones that used to be marked overflow) stays real and
// usable, nothing is ever deleted here — the overflow concept is just gone, not the locations
// it used to flag. (Fixed 03-Oct-2026: an earlier version of this migration computed
// lastAisleTotes = overflowFromTote - 1 and then deleted the codes above that, which silently
// dropped real, non-overflow totes whenever overflowFromTote happened to equal totesPerAisle —
// e.g. A5-T20 on a layout where only a single trailing tote had ever been marked overflow.)
// is_overflow stays in the locations table (write-only, never read back — see persist.js)
// rather than being dropped, since SQLite can't drop a column cheaply and nothing depends on
// it being gone.
function migrateV2toV3(db) {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'settings'").get();
  if (row) {
    const old = JSON.parse(row.value);
    if ('overflowAisle' in old || 'overflowFromTote' in old) {
      const { overflowAisle, overflowFromTote, ...rest } = old;
      const cleaned = { ...rest, lastAisleTotes: rest.totesPerAisle };
      db.prepare("UPDATE settings SET value = ? WHERE key = 'settings'").run(JSON.stringify(cleaned));
    }
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS route_history (
      id INTEGER PRIMARY KEY,
      status TEXT NOT NULL CHECK (status IN ('planned', 'active', 'completed')),
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      created_by TEXT,
      tote_ids TEXT NOT NULL,
      projected TEXT NOT NULL,
      actual TEXT,
      note TEXT
    );
    CREATE INDEX IF NOT EXISTS ix_route_history_status ON route_history(status);
  `);
}

// v4: the 60-tote rack, batch (Route) operation (PLAN.md §5.5/§6, owner-approved 03-Oct-2026).
// Always adds the new settings keys (batchSize, processableStatus, processableAvailability)
// with their defaults if missing. The new 3-aisle/20-tote/4-partition/cap-100/headroom-5%
// layout is only applied when the rack is genuinely empty (no used>0 location, no loc_pid row)
// — exactly the existing locationsInUse lock already enforces for a live layout change, so a
// deploy onto a rack that still has stock never silently reshapes or shrinks capacity under it
// (RUNBOOK.md: release/hand over everything before deploying this version). The physical
// `locations` table rows themselves don't need rewriting here: buildLocations() always
// regenerates the full location array fresh from settings at boot (src/core/state.js), and the
// next real dump load or layout save naturally rewrites the persisted rows to match.
function migrateV3toV4(db) {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'settings'").get();
  const old = row ? JSON.parse(row.value) : defaultSettings();
  const merged = { ...old };
  if (!('batchSize' in merged)) merged.batchSize = 50;
  if (!('processableStatus' in merged)) merged.processableStatus = ['AVAILABLE'];
  if (!('processableAvailability' in merged)) merged.processableAvailability = ['NOT_FOUND', 'NOT_FOUND_HOLD', 'AVAILABLE'];

  const used = db.prepare('SELECT COUNT(*) AS n FROM locations WHERE used > 0').get().n;
  const reserved = db.prepare('SELECT COUNT(*) AS n FROM loc_pid').get().n;
  if (used === 0 && reserved === 0) {
    Object.assign(merged, { aisles: 3, totesPerAisle: 20, lastAisleTotes: 20, partitions: 4, cap: 100, headroomPct: 5, softPidCap: 20 });
  }

  db.prepare(`
    INSERT INTO settings (key, value) VALUES ('settings', @value)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run({ value: JSON.stringify(merged) });
}

// v5: tote numbers run continuously across the rack (A2 = T21-T40, A3 = T41-T60 instead of restarting
// at T01 in every aisle) so location codes match the physical tote labels 1..60. Existing location
// codes of aisle >= 2 are RENAMED (not deleted), everywhere they are stored, so placed barcodes,
// reservations and history keep pointing at the same physical spot.
function migrateV4toV5(db) {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'settings'").get();
  const per = Number((row ? JSON.parse(row.value) : defaultSettings()).totesPerAisle);
  if (!(per > 0)) return;
  const rows = db.prepare('SELECT code, aisle, tote, part FROM locations WHERE aisle >= 2 AND tote <= ?').all(per);
  const fix = (sql, a, b) => db.prepare(sql).run(a, b);
  for (const r of rows) {
    const tote = r.tote + (r.aisle - 1) * per;
    const next = `A${r.aisle}-T${String(tote).padStart(2, '0')}-P${r.part}`;
    if (next === r.code) continue;
    db.prepare('UPDATE locations SET code = ?, tote = ? WHERE code = ?').run(next, tote, r.code);
    fix('UPDATE loc_pid SET location_code = ? WHERE location_code = ?', next, r.code);
    fix('UPDATE barcodes SET location_code = ? WHERE location_code = ?', next, r.code);
    fix('UPDATE events SET location_code = ? WHERE location_code = ?', next, r.code);
  }
}
