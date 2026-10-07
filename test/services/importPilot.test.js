import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newState, loadDump, scan, recount } from '../../src/core/index.js';
import { importPilotBackup } from '../../src/services/importPilot.js';

test('importPilotBackup — errors clearly on a file missing the expected fields', () => {
  assert.throws(() => importPilotBackup({}), /missing/i);
  assert.throws(() => importPilotBackup(null), /valid backup/i);
});

test('importPilotBackup — round-trips placed/handed-over/not-found barcodes and per-location counts', () => {
  const st = newState();
  // P1 needs a known total >= 5 to be placeable at all (under-5 PIDs are left aside) — B3-B5
  // live in a separate tote so B1/B2/TL01-specific assertions below are unaffected
  const csv = 'pid,barcode,status,condition,availability,scan_location,tote,tote_simplified,tote_number,partition,scanned_at,nexs_location\n'
    + 'P1,B1,AVAILABLE,GOOD,NOT_FOUND,LOC1,TL01,1-1,1,1,2026-09-25 10:00:00,NEXS1\n'
    + 'P1,B2,AVAILABLE,GOOD,NOT_FOUND,LOC1,TL01,1-1,1,1,2026-09-25 10:00:00,NEXS1\n'
    + 'P1,B3,AVAILABLE,GOOD,NOT_FOUND,LOC1,TL02,1-1,1,1,2026-09-25 10:00:00,NEXS1\n'
    + 'P1,B4,AVAILABLE,GOOD,NOT_FOUND,LOC1,TL02,1-1,1,1,2026-09-25 10:00:00,NEXS1\n'
    + 'P1,B5,AVAILABLE,GOOD,NOT_FOUND,LOC1,TL02,1-1,1,1,2026-09-25 10:00:00,NEXS1\n';
  loadDump(st, csv, 'sample-2026-09-25.csv');
  scan(st, 'S1', 'TL01');
  const r1 = scan(st, 'S1', 'B1');
  recount(st);

  // simulate "Settings -> Download backup" from the pilot: a plain JSON round-trip
  const backup = JSON.parse(JSON.stringify(st));
  const imported = importPilotBackup(backup);

  assert.equal(imported.barcodes.B1.s, 'P');
  assert.equal(imported.barcodes.B1.l, r1.loc);
  assert.equal(imported.pids.P1.C, 1);
  assert.equal(imported.pids.P1.R, 4); // B2 + B3 + B4 + B5 still waiting
  const L = imported.locations.find(l => l.code === r1.loc);
  assert.equal(L.used, 1);
  assert.deepEqual(L.pids.P1, st.locations.find(l => l.code === r1.loc).pids.P1);
});

test('importPilotBackup — a tote left open in the pilot re-enters the pool as waiting, not owned', () => {
  const st = newState();
  st.totes.TL01 = { n: '1', s: 'O', bs: ['B1'], station: 'PILOT-STATION', openedAt: '2026-09-25 09:00:00' };
  st.barcodes.B1 = { p: 'P1', t: 'TL01', pt: '1', pr: 1, s: 'H' };
  const backup = JSON.parse(JSON.stringify(st));
  const imported = importPilotBackup(backup);
  assert.equal(imported.totes.TL01.s, 'H');
  assert.equal(imported.totes.TL01.station, undefined);
});
