import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../src/db/migrate.js';
import { loadState } from '../../src/db/load.js';
import { createPersistence } from '../../src/db/persist.js';
import { createMutator } from '../../src/services/mutate.js';
import { newState, loadDump, scan, finishTote, recount } from '../../src/core/index.js';
import { recountCheck } from '../../src/services/recount.js';

function tmpDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bermuda-db-'));
  return { dir, file: path.join(dir, 'test.db') };
}

test('migrate — creates the schema and is idempotent', () => {
  const { dir, file } = tmpDbPath();
  const db = openDb(file);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  for (const t of ['settings', 'locations', 'loc_pid', 'totes', 'barcodes', 'pids', 'loads', 'events', 'alerts', 'users', 'stations', 'sessions']) {
    assert.ok(tables.includes(t), `missing table ${t}`);
  }
  db.close();
  const db2 = openDb(file); // re-opening an already-migrated file must not error
  db2.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('runMutation — a scan persists exactly the touched rows and one event, inside one transaction', () => {
  const { dir, file } = tmpDbPath();
  const db = openDb(file);
  const app = { st: loadState(db) };
  const persist = createPersistence(db);
  const { runMutation } = createMutator(db, persist, app);

  app.st.totes.T1 = { n: '1', s: 'H', bs: ['B1'] };
  app.st.barcodes.B1 = { p: 'P1', t: 'T1', pt: '1', pr: 1, s: 'H' };
  // P1 needs a known total >= 5 to be placeable at all (under-5 PIDs are left aside) — the
  // other 4 live in a separate holding tote so T1/B1-specific assertions are unaffected
  app.st.totes.T9 = { n: '9', s: 'H', bs: ['B1b', 'B1c', 'B1d', 'B1e'] };
  for (const b of ['B1b', 'B1c', 'B1d', 'B1e']) app.st.barcodes[b] = { p: 'P1', t: 'T9', pt: '1', pr: 1, s: 'H' };
  recount(app.st);

  const openRes = runMutation(st => ({ result: scan(st, 'S1', 'T1'), event: { ts: '2026-09-28 10:00:00', type: 'scan', station: 'S1', barcode: 'T1', result: 'tote' } }));
  assert.equal(openRes.type, 'tote');

  const placeRes = runMutation(st => ({ result: scan(st, 'S1', 'B1'), event: { ts: '2026-09-28 10:00:01', type: 'scan', station: 'S1', barcode: 'B1', result: 'place' } }));
  assert.equal(placeRes.type, 'place');

  const toteRow = db.prepare('SELECT * FROM totes WHERE tote_id = ?').get('T1');
  assert.equal(toteRow.state, 'O');
  assert.equal(toteRow.station_id, 'S1');

  const bcRow = db.prepare('SELECT * FROM barcodes WHERE barcode = ?').get('B1');
  assert.equal(bcRow.state, 'P');
  assert.equal(bcRow.location_code, placeRes.loc);

  const locRow = db.prepare('SELECT * FROM locations WHERE code = ?').get(placeRes.loc);
  assert.equal(locRow.used, 1);

  const locPidRow = db.prepare('SELECT * FROM loc_pid WHERE location_code = ? AND pid = ?').get(placeRes.loc, 'P1');
  assert.equal(locPidRow.placed, 1);

  const pidRow = db.prepare('SELECT * FROM pids WHERE pid = ?').get('P1');
  assert.equal(pidRow.c, 1);

  const stationRow = db.prepare('SELECT * FROM stations WHERE id = ?').get('S1');
  assert.equal(stationRow.open_tote, 'T1');
  assert.equal(stationRow.last_scan_barcode, 'B1');

  const eventCount = db.prepare('SELECT COUNT(*) AS n FROM events').get().n;
  assert.equal(eventCount, 2);

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('restart — reloading state from the DB reproduces the in-memory placement exactly', () => {
  const { dir, file } = tmpDbPath();
  const db = openDb(file);
  const app = { st: loadState(db) };
  const persist = createPersistence(db);
  const { runMutation } = createMutator(db, persist, app);

  app.st.totes.T1 = { n: '1', s: 'H', bs: ['B1', 'B2'] };
  app.st.barcodes.B1 = { p: 'P1', t: 'T1', pt: '1', pr: 1, s: 'H' };
  app.st.barcodes.B2 = { p: 'P1', t: 'T1', pt: '1', pr: 1, s: 'H' };
  // P1 needs a known total >= 5 to be placeable at all — the other 3 live in a separate
  // holding tote so T1/B1/B2-specific assertions below are unaffected
  app.st.totes.T9 = { n: '9', s: 'H', bs: ['B1c', 'B1d', 'B1e'] };
  for (const b of ['B1c', 'B1d', 'B1e']) app.st.barcodes[b] = { p: 'P1', t: 'T9', pt: '1', pr: 1, s: 'H' };
  recount(app.st);
  // manually-created rows are only in memory until something touches them — runMutation only
  // persists what a mutation actually touches, so the untouched padding tote needs an explicit
  // bulk sync now (as a real dump load would do) or it silently won't survive a reload
  persist.persistFullSync(app.st);

  runMutation(st => ({ result: scan(st, 'S1', 'T1') }));
  const r1 = runMutation(st => ({ result: scan(st, 'S1', 'B1') }));
  const r2 = runMutation(st => ({ result: scan(st, 'S1', 'B2') }));
  runMutation(st => ({ result: finishTote(st, 'S1') }));

  const before = app.st;
  db.close();

  const db2 = openDb(file);
  const after = loadState(db2);

  assert.equal(after.pids.P1.C, before.pids.P1.C);
  assert.equal(after.pids.P1.R, before.pids.P1.R);
  assert.equal(after.barcodes.B1.s, 'P');
  assert.equal(after.barcodes.B1.l, r1.loc);
  assert.equal(after.barcodes.B2.s, 'P');
  assert.equal(after.barcodes.B2.l, r2.loc);
  assert.equal(after.totes.T1.s, 'C');
  const L = after.locations.find(l => l.code === r1.loc);
  assert.equal(L.used, before.locations.find(l => l.code === r1.loc).used);

  db2.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('persistFullSync — dump load is fully reflected after a fresh reload (bulk path)', () => {
  const { dir, file } = tmpDbPath();
  const db = openDb(file);
  const app = { st: loadState(db) };
  const persist = createPersistence(db);

  const csv = 'pid,barcode,status,condition,availability,scan_location,tote,tote_simplified,tote_number,partition,scanned_at,nexs_location\n'
    + 'P1,B1,AVAILABLE,GOOD,NOT_FOUND,LOC1,TL01,1-1,1,1,2026-09-25 10:00:00,NEXS1\n'
    + 'P1,B2,AVAILABLE,GOOD,NOT_FOUND,LOC1,TL01,1-1,1,1,2026-09-25 10:00:00,NEXS1\n';
  loadDump(app.st, csv, 'sample-2026-09-28.csv');
  persist.persistFullSync(app.st);
  db.close();

  const db2 = openDb(file);
  const after = loadState(db2);
  assert.equal(after.totes.TL01.s, 'H');
  assert.equal(after.barcodes.B1.p, 'P1');
  assert.equal(after.pids.P1.R, 2);
  db2.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('recountCheck — detects and self-heals a drifted cached count', () => {
  const st = newState();
  st.totes.T1 = { n: '1', s: 'H', bs: ['B1'] };
  st.barcodes.B1 = { p: 'P1', t: 'T1', pt: '1', pr: 1, s: 'H' };
  recount(st);
  st.pids.P1.R = 99; // simulate drift
  const check = recountCheck(st);
  assert.equal(check.ok, false);
  assert.equal(check.diffs.length, 1);
  assert.equal(check.diffs[0].pid, 'P1');
  assert.equal(st.pids.P1.R, 1); // self-healed
});
