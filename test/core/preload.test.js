import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newState } from '../../src/core/state.js';
import { preloadStock } from '../../src/core/preload.js';

const HDR_BY_BARCODE = 'location,pid,barcode,tote';
const HDR_BY_QTY = 'location,pid,qty';

test('preloadStock — missing required columns errors out', () => {
  const st = newState();
  const r = preloadStock(st, 'location,pid\nA1-T01-P1,P1', 'x.csv');
  assert.equal(r.ok, false);
  assert.match(r.error, /Need columns/);
});

test('preloadStock — by barcode: creates a placed barcode at the given location', () => {
  const st = newState();
  const csv = `${HDR_BY_BARCODE}\nA1-T01-P1,P1,B1,TOTE1\nA1-T01-P1,P1,B2,TOTE1`;
  const r = preloadStock(st, csv, 'aisle-stock.csv');
  assert.equal(r.ok, true);
  assert.equal(r.added, 2);
  assert.equal(r.pids, 1);
  assert.equal(r.locs, 1);
  assert.equal(st.barcodes.B1.s, 'P');
  assert.equal(st.barcodes.B1.l, 'A1-T01-P1');
  assert.equal(st.barcodes.B1.t, 'TOTE1');
  assert.equal(st.barcodes.B1.pre, 1);
  const L = st.locations.find(l => l.code === 'A1-T01-P1');
  assert.equal(L.used, 2);
  assert.equal(L.pids.P1.c, 2);
  assert.ok(st.pids.P1.locs['A1-T01-P1']);
});

test('preloadStock — by barcode: a barcode already placed/handed-over is skipped as bad, not overwritten', () => {
  const st = newState();
  st.barcodes.B1 = { p: 'P1', t: 'TOTE1', pt: '1', pr: 1, s: 'P', l: 'A1-T01-P1' };
  const csv = `${HDR_BY_BARCODE}\nA1-T02-P1,P1,B1,TOTE1`;
  const r = preloadStock(st, csv, 'x.csv');
  assert.equal(r.added, 0);
  assert.equal(r.bad.length, 1);
  assert.equal(st.barcodes.B1.l, 'A1-T01-P1'); // untouched
});

test('preloadStock — by quantity: creates synthetic PRELOAD barcodes for the count given', () => {
  const st = newState();
  const csv = `${HDR_BY_QTY}\nA1-T01-P1,P1,3`;
  const r = preloadStock(st, csv, 'x.csv');
  assert.equal(r.ok, true);
  assert.equal(r.byBarcode, false);
  assert.equal(r.added, 3);
  const L = st.locations.find(l => l.code === 'A1-T01-P1');
  assert.equal(L.used, 3);
  assert.equal(L.pids.P1.c, 3);
  const synthetic = Object.keys(st.barcodes).filter(b => b.startsWith('PRELOAD-'));
  assert.equal(synthetic.length, 3);
  for (const b of synthetic) assert.equal(st.barcodes[b].t, 'PRELOAD');
});

test('preloadStock — a bad location or non-positive quantity is reported, not silently dropped', () => {
  const st = newState();
  const csv = `${HDR_BY_QTY}\nNOTALOCATION,P1,3\nA1-T01-P1,P2,0`;
  const r = preloadStock(st, csv, 'x.csv');
  assert.equal(r.added, 0);
  assert.equal(r.bad.length, 2);
});

test('preloadStock — flags a location pushed over its physical capacity', () => {
  const st = newState();
  const csv = `${HDR_BY_QTY}\nA1-T01-P1,P1,150`;
  const r = preloadStock(st, csv, 'x.csv');
  assert.equal(r.over.length, 1);
  assert.match(r.over[0], /A1-T01-P1/);
});

test('preloadStock — uploading again replaces the earlier preload still sitting in the aisles', () => {
  const st = newState();
  preloadStock(st, `${HDR_BY_QTY}\nA1-T01-P1,P1,5`, 'first.csv');
  const r = preloadStock(st, `${HDR_BY_QTY}\nA1-T02-P1,P1,3`, 'second.csv');
  assert.equal(r.removed, 5);
  const L1 = st.locations.find(l => l.code === 'A1-T01-P1');
  assert.equal(L1.used, 0); // first preload's synthetic barcodes gone
  const L2 = st.locations.find(l => l.code === 'A1-T02-P1');
  assert.equal(L2.used, 3);
});

test('preloadStock — replacing a by-barcode preload reverts the real barcode to waiting (H) if its tote still exists', () => {
  const st = newState();
  st.totes.TOTE1 = { n: '1', s: 'H', bs: ['B1'] };
  preloadStock(st, `${HDR_BY_BARCODE}\nA1-T01-P1,P1,B1,TOTE1`, 'first.csv');
  assert.equal(st.barcodes.B1.s, 'P');
  preloadStock(st, `${HDR_BY_QTY}\nA1-T02-P1,P2,1`, 'second.csv');
  assert.equal(st.barcodes.B1.s, 'H'); // reverted, since TOTE1 still exists to wait in
  assert.equal(st.barcodes.B1.pre, undefined);
});

// ---- full migration rows: state O / X / N / C (aisle-stock file from the old site) ----
const HDR_FULL = 'location,pid,barcode,tote,state,at,processable,tote_number';
const DUMP_HDR = 'pid,barcode,status,availability,tote,tote_number,partition';

test('preloadStock — migration rows restore handed-over, set-aside, not-found barcodes and done totes', () => {
  const st = newState();
  const csv = [HDR_FULL,
    ',,,TD,C,2026-10-07 03:00:00,,87',
    'A1-T01-P1,P1,B1,TOTE1,P,2026-10-07 01:00:00,1,',
    'A1-T01-P1,P1,B2,TOTE1,O,2026-10-07 02:40:49,1,',
    ',P2,B3,TOTE1,X,2026-10-07 01:30:00,0,',
    ',P3,B4,TD,N,2026-10-07 03:00:00,1,'].join('\n');
  const r = preloadStock(st, csv, 'full.csv');
  assert.equal(r.ok, true);
  assert.deepEqual([r.added, r.handedOver, r.setAside, r.notFound, r.totesDone, r.bad.length], [1, 1, 1, 1, 1, 0]);
  assert.equal(st.barcodes.B1.s, 'P');
  assert.equal(st.barcodes.B2.s, 'O'); assert.equal(st.barcodes.B2.hoAt, '2026-10-07 02:40:49');
  assert.equal(st.barcodes.B3.s, 'X'); assert.equal(st.barcodes.B3.pr, 0);
  assert.equal(st.barcodes.B4.s, 'N');
  assert.equal(st.totes.TD.s, 'C'); assert.equal(st.totes.TD.n, '87');
  assert.equal(st.locations.find(l => l.code === 'A1-T01-P1').used, 1); // O/X/N take no rack space
  assert.equal(st.pids.P1.C, 1); assert.equal(st.pids.P1.H, 1);
});

test('preloadStock — migrated state survives the dump: nothing re-placed, done totes skipped', async () => {
  const { loadDump } = await import('../../src/core/dump.js');
  const st = newState();
  preloadStock(st, [HDR_FULL,
    ',,,TD,C,2026-10-07 03:00:00,,87',
    'A1-T01-P1,P1,B1,TOTE1,P,,1,',
    'A1-T01-P1,P1,B2,TOTE1,O,2026-10-07 02:40:49,1,',
    ',P3,B4,TD,N,,1,'].join('\n'), 'full.csv');
  const dump = [DUMP_HDR,
    'P1,B1,AVAILABLE,AVAILABLE,TOTE1,1,1',
    'P1,B2,AVAILABLE,AVAILABLE,TOTE1,1,1',
    'P1,B9,AVAILABLE,AVAILABLE,TOTE1,1,1',
    'P3,B4,AVAILABLE,AVAILABLE,TD,87,1'].join('\n');
  const r = loadDump(st, dump, 'dump.csv', new Date());
  assert.equal(r.ok, true);
  assert.deepEqual(r.skippedTaken, ['TD']);
  assert.equal(st.barcodes.B2.s, 'O');        // still handed over, not offered again
  assert.equal(st.barcodes.B1.s, 'P');
  assert.equal(st.barcodes.B9.s, 'H');        // genuinely new barcode is waiting
  assert.equal(st.barcodes.B4.s, 'N');        // done tote untouched
});

test('preloadStock — migration rows: clashes are reported, repeats are harmless', () => {
  const st = newState();
  const csv = [HDR_FULL,
    'A1-T01-P1,P1,B1,TOTE1,P,,1,',
    'A1-T01-P1,P1,B1,TOTE1,O,,1,',       // same barcode placed AND handed over in the file -> clash
    'A1-T01-P1,P1,B2,TOTE1,O,,1,',
    'A1-T01-P1,P1,B2,TOTE1,O,,1,',       // repeat
    'A1-T01-P1,P1,B3,TOTE1,Z,,1,'].join('\n'); // unknown state
  const r = preloadStock(st, csv, 'x.csv');
  assert.equal(r.ok, true);
  assert.equal(r.handedOver, 1);
  assert.equal(r.dupes, 1);
  assert.equal(r.bad.length, 2);
  // uploading the identical file again changes nothing
  const r2 = preloadStock(st, csv, 'x.csv');
  assert.equal(st.barcodes.B2.s, 'O');
  assert.equal(st.totes.TOTE1, undefined);
  assert.equal(r2.ok, true);
});
