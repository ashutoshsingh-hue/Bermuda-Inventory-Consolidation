import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newState, clearDirty, recount } from '../../src/core/state.js';
import { scan, undoLast, finishTote } from '../../src/core/scan.js';
import { handOver } from '../../src/core/handover.js';

function setup() {
  const st = newState();
  st.totes.T1 = { n: '1', s: 'H', bs: ['B1'] };
  st.barcodes.B1 = { p: 'P1', t: 'T1', pt: '1', pr: 1, s: 'H' };
  // P1 needs a known total >= 5 to be placeable at all (under-5 PIDs are left aside) — the
  // other 4 live in a separate holding tote so T1/B1-specific dirty-tracking checks are unaffected
  st.totes.T9 = { n: '9', s: 'H', bs: ['B1b', 'B1c', 'B1d', 'B1e'] };
  for (const b of ['B1b', 'B1c', 'B1d', 'B1e']) st.barcodes[b] = { p: 'P1', t: 'T9', pt: '1', pr: 1, s: 'H' };
  recount(st);
  return st;
}

test('dirty tracking — opening a tote marks only that tote and station', () => {
  const st = setup();
  scan(st, 'S1', 'T1');
  assert.deepEqual([...st._dirty.totes], ['T1']);
  assert.deepEqual([...st._dirty.stations], ['S1']);
  assert.equal(st._dirty.barcodes.size, 0);
  assert.equal(st._dirty.locations.size, 0);
  assert.equal(st._dirty.pids.size, 0);
});

test('dirty tracking — placing a barcode marks the barcode, its location and its pid', () => {
  const st = setup();
  clearDirty(st);
  scan(st, 'S1', 'T1'); clearDirty(st);
  const r = scan(st, 'S1', 'B1');
  assert.equal(r.type, 'place');
  assert.deepEqual([...st._dirty.barcodes], ['B1']);
  assert.deepEqual([...st._dirty.locations], [r.loc]);
  assert.deepEqual([...st._dirty.pids], ['P1']);
});

test('dirty tracking — a NO SPACE rollback leaves no dirty pid (net change is zero)', () => {
  const st = newState({ aisles: 1, totesPerAisle: 1, lastAisleTotes: 1, partitions: 1, cap: 1, headroomPct: 0, softPidCap: 20 });
  st.totes.T1 = { n: '1', s: 'H', bs: ['B1', 'B2'] };
  st.barcodes.B1 = { p: 'P1', t: 'T1', pt: '1', pr: 1, s: 'H' };
  st.barcodes.B2 = { p: 'P1', t: 'T1', pt: '1', pr: 1, s: 'H' };
  // P1 needs a known total >= 5 to be placeable at all — the extra 3 live in a separate
  // holding tote so this test's tiny 1-slot location isn't affected by them
  st.totes.T9 = { n: '9', s: 'H', bs: ['B1c', 'B1d', 'B1e'] };
  for (const b of ['B1c', 'B1d', 'B1e']) st.barcodes[b] = { p: 'P1', t: 'T9', pt: '1', pr: 1, s: 'H' };
  recount(st);
  scan(st, 'S1', 'T1'); clearDirty(st);
  scan(st, 'S1', 'B1'); clearDirty(st); // fills the single 1-slot location
  const r = scan(st, 'S1', 'B2');
  assert.equal(r.type, 'error');
  assert.equal(st._dirty.pids.size, 0);
  assert.equal(st._dirty.barcodes.size, 0);
  assert.equal(st._dirty.locations.size, 0);
});

test('dirty tracking — undo marks the barcode, its former location and pid', () => {
  const st = setup();
  scan(st, 'S1', 'T1');
  scan(st, 'S1', 'B1');
  clearDirty(st);
  undoLast(st, 'S1');
  assert.deepEqual([...st._dirty.barcodes], ['B1']);
  assert.equal(st._dirty.locations.size, 1);
  assert.deepEqual([...st._dirty.pids], ['P1']);
});

test('dirty tracking — finishTote marks the tote, not-found barcodes and their pids', () => {
  const st = setup();
  scan(st, 'S1', 'T1');
  clearDirty(st);
  finishTote(st, 'S1');
  assert.deepEqual([...st._dirty.totes], ['T1']);
  assert.deepEqual([...st._dirty.barcodes], ['B1']);
  assert.deepEqual([...st._dirty.pids], ['P1']);
});

test('dirty tracking — handOver marks the moved barcodes, their locations and the pid', () => {
  const st = setup();
  scan(st, 'S1', 'T1'); scan(st, 'S1', 'B1');
  clearDirty(st);
  const n = handOver(st, 'P1', 1);
  assert.equal(n, 1);
  assert.deepEqual([...st._dirty.barcodes], ['B1']);
  assert.equal(st._dirty.locations.size, 1);
  assert.deepEqual([...st._dirty.pids], ['P1']);
});
