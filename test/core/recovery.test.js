/* The headline disaster-recovery workflow: the server's own data is lost, but the physical
 * aisles still hold real inventory. Upload the aisle-stock CSV first (preloadStock), then the
 * normal daily PID Hunter dump on top of it (loadDump) — the dump's barcodes reconcile against
 * what's already placed instead of raising false conflicts, and totes that are now mostly (or
 * fully) already sorted get closed/flagged automatically (evaluateTotes, run by both). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newState, recount } from '../../src/core/state.js';
import { preloadStock } from '../../src/core/preload.js';
import { loadDump } from '../../src/core/dump.js';

const HDR = 'pid,barcode,status,condition,availability,scan_location,tote,tote_simplified,tote_number,partition,scanned_at,nexs_location';
function dumpRow(pid, barcode, tote, toteNumber) {
  return `${pid},${barcode},AVAILABLE,GOOD,NOT_FOUND,LOC1,${tote},x,${toteNumber},1,2026-09-25 10:00:00,NEXS1`;
}

test('recovery — a fully-sorted tote (10/10 preloaded) auto-closes when the main dump reloads on top', () => {
  const st = newState();
  // "physically, all 10 barcodes of TOTE1 are already in A1-T01-P1" — recorded before data was lost
  const rows = Array.from({ length: 10 }, (_, i) => `A1-T01-P1,P1,B${i},TOTE1`).join('\n');
  const pre = preloadStock(st, 'location,pid,barcode,tote\n' + rows, 'aisle-stock.csv');
  assert.equal(pre.added, 10);

  // PID Hunter still thinks TOTE1 is out there with all 10 barcodes — it has no idea sorting happened
  const dumpRows = Array.from({ length: 10 }, (_, i) => dumpRow('P1', 'B' + i, 'TOTE1', '4')).join('\n');
  const res = loadDump(st, HDR + '\n' + dumpRows, 'sample.csv');

  assert.equal(res.alreadySorted, 10);
  assert.equal(res.conflicts.length, 0);
  assert.equal(res.autoClosed.length, 1);
  assert.equal(st.totes.TOTE1.s, 'C');
  for (let i = 0; i < 10; i++) assert.equal(st.barcodes['B' + i].s, 'P'); // all still placed, none re-created or lost

  recount(st);
  assert.equal(st.pids.P1.C, 10);
  assert.equal(st.pids.P1.R, 0);
});

test('recovery — a partly-sorted tote (3/10 preloaded) is flagged for a rescan, not force-closed', () => {
  const st = newState();
  const rows = Array.from({ length: 3 }, (_, i) => `A1-T01-P1,P1,B${i},TOTE1`).join('\n');
  preloadStock(st, 'location,pid,barcode,tote\n' + rows, 'aisle-stock.csv');

  const dumpRows = Array.from({ length: 10 }, (_, i) => dumpRow('P1', 'B' + i, 'TOTE1', '4')).join('\n');
  const res = loadDump(st, HDR + '\n' + dumpRows, 'sample.csv');

  assert.equal(res.alreadySorted, 3);
  assert.equal(res.partial.length, 1);
  assert.equal(res.autoClosed.length, 0);
  assert.equal(st.totes.TOTE1.s, 'H'); // still waiting — the remaining 7 need a real rescan
  for (let i = 0; i < 3; i++) assert.equal(st.barcodes['B' + i].s, 'P');
  for (let i = 3; i < 10; i++) assert.equal(st.barcodes['B' + i].s, 'H');
});

test('recovery — quantity-only preload (no barcode/tote match) still lets the main dump load cleanly alongside it', () => {
  const st = newState();
  preloadStock(st, 'location,pid,qty\nA1-T01-P1,P1,4', 'aisle-stock.csv');
  const dumpRows = Array.from({ length: 6 }, (_, i) => dumpRow('P1', 'B' + i, 'TOTE1', '4')).join('\n');
  const res = loadDump(st, HDR + '\n' + dumpRows, 'sample.csv');
  assert.equal(res.ok, true);
  assert.equal(res.newTotes, 1);
  recount(st);
  // quantity-only preload can't be tied to specific barcodes, so the dump's 6 load fresh as
  // waiting (R) rather than reconciling against the preloaded units — the pid's C only
  // reflects the 4 preloaded (synthetic) units
  assert.equal(st.pids.P1.C, 4);
  assert.equal(st.pids.P1.R, 6);
});
