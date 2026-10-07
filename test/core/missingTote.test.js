import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newState, recount } from '../../src/core/state.js';
import { scan } from '../../src/core/scan.js';
import { markToteMissing, reinstateTote, missingTotes } from '../../src/core/missingTote.js';

function setup() {
  const st = newState();
  st.totes.T1 = { n: '1', s: 'H', bs: ['B1', 'B2'] };
  st.barcodes.B1 = { p: 'P1', t: 'T1', pt: '1', pr: 1, s: 'H' };
  st.barcodes.B2 = { p: 'P1', t: 'T1', pt: '1', pr: 0, s: 'H' }; // not processable
  recount(st);
  return st;
}

test('markToteMissing — moves processable barcodes to M, R decreases, M increases, tote drops out of waiting', () => {
  const st = setup();
  const r = markToteMissing(st, 'T1', new Date(), 'Pallet not found');
  assert.equal(r.ok, true);
  assert.equal(r.barcodes, 2); // both move to M state...
  assert.equal(r.processable, 1); // ...but only the processable one affects pid counts
  assert.equal(st.totes.T1.s, 'M');
  assert.equal(st.barcodes.B1.s, 'M');
  assert.equal(st.barcodes.B2.s, 'M');
  assert.equal(st.pids.P1.R, 0);
  assert.equal(st.pids.P1.M, 1);
  assert.ok(st.alerts.some(a => a.type === 'TOTE_MISSING' && /Pallet not found/.test(a.msg)));
});

test('markToteMissing — refuses an already-open or already-finished tote', () => {
  const st = setup();
  st.totes.T2 = { n: '2', s: 'O', bs: [] };
  assert.equal(markToteMissing(st, 'T2').ok, false);
  st.totes.T3 = { n: '3', s: 'C', bs: [] };
  assert.equal(markToteMissing(st, 'T3').ok, false);
});

test('markToteMissing — refuses a tote already marked missing', () => {
  const st = setup();
  markToteMissing(st, 'T1');
  const r = markToteMissing(st, 'T1');
  assert.equal(r.ok, false);
  assert.match(r.error, /Already marked missing/);
});

test('reinstateTote — brings barcodes back to H, M decreases, R increases, tote waits again', () => {
  const st = setup();
  markToteMissing(st, 'T1');
  const r = reinstateTote(st, 'T1');
  assert.equal(r.ok, true);
  assert.equal(r.processable, 1);
  assert.equal(st.totes.T1.s, 'H');
  assert.equal(st.barcodes.B1.s, 'H');
  assert.equal(st.pids.P1.R, 1);
  assert.equal(st.pids.P1.M, 0);
  assert.ok(st.alerts.some(a => a.type === 'TOTE_FOUND'));
});

test('reinstateTote — refuses a tote that isn\'t marked missing', () => {
  const st = setup();
  assert.equal(reinstateTote(st, 'T1').ok, false);
});

test('missingTotes — lists missing totes sorted by processable count, descending', () => {
  const st = setup();
  st.totes.T2 = { n: '2', s: 'H', bs: ['B3', 'B4', 'B5'] };
  st.barcodes.B3 = { p: 'P2', t: 'T2', pt: '1', pr: 1, s: 'H' };
  st.barcodes.B4 = { p: 'P2', t: 'T2', pt: '1', pr: 1, s: 'H' };
  st.barcodes.B5 = { p: 'P2', t: 'T2', pt: '1', pr: 1, s: 'H' };
  recount(st);
  markToteMissing(st, 'T1'); // 1 processable
  markToteMissing(st, 'T2'); // 3 processable
  const list = missingTotes(st);
  assert.equal(list.length, 2);
  assert.equal(list[0].tote, 'T2');
  assert.equal(list[0].processable, 3);
  assert.equal(list[1].tote, 'T1');
});

test('scan — opening a tote marked missing auto-reinstates it and reports "found"', () => {
  const st = setup();
  markToteMissing(st, 'T1');
  const r = scan(st, 'S1', 'T1');
  assert.equal(r.type, 'tote');
  assert.equal(r.found, true);
  assert.match(r.msg, /FOUND/);
  assert.equal(st.totes.T1.s, 'O'); // reinstated to H then immediately opened
  assert.equal(st.pids.P1.R, 1);
  assert.equal(st.pids.P1.M, 0);
});

test('scan — a barcode from a missing tote scanned in a different open tote is reinstated with a FOUND_LATER alert', () => {
  const st = setup();
  markToteMissing(st, 'T1');
  st.totes.T2 = { n: '2', s: 'H', bs: [] };
  scan(st, 'S1', 'T2');
  const r = scan(st, 'S1', 'B1'); // B1 belongs to T1 (missing), scanned into T2 -> EXTRA + reinstated from M
  assert.equal(r.type, 'extra');
  assert.equal(st.pids.P1.M, 0);
  assert.equal(st.pids.P1.C, 1);
  assert.ok(st.alerts.some(a => a.type === 'FOUND_LATER' && /missing tote/.test(a.msg)));
});
