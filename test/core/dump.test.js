import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newState } from '../../src/core/state.js';
import { loadDump } from '../../src/core/dump.js';

const HDR = 'pid,barcode,status,condition,availability,scan_location,tote,tote_simplified,tote_number,partition,scanned_at,nexs_location';
function row({ pid = 'P1', barcode, status = 'AVAILABLE', availability = 'NOT_FOUND', tote = 'TL0000000001', toteSimplified = '4-2', toteNumber = '4', partition = '2' }) {
  return `${pid},${barcode},${status},GOOD,${availability},LOC1,${tote},${toteSimplified},${toteNumber},${partition},2026-09-25 10:00:00,NEXS1`;
}
function csv(rows) { return HDR + '\n' + rows.join('\n'); }

test('loadDump — missing required columns errors out', () => {
  const st = newState();
  const res = loadDump(st, 'pid,barcode\nP1,B1', 'x.csv');
  assert.equal(res.ok, false);
  assert.match(res.error, /Missing columns/);
});

test('loadDump — skips rows with empty tote and reports the count', () => {
  const st = newState();
  const text = csv([row({ barcode: 'B1' }), row({ barcode: 'B2', tote: '' })]);
  const res = loadDump(st, text, 'x.csv');
  assert.equal(res.ok, true);
  assert.equal(res.rows, 2);
  assert.equal(res.noTote, 1);
  assert.equal(Object.keys(st.barcodes).length, 1);
});

test('loadDump — tote_simplified is never trusted; tote id and partition come from tote/partition columns', () => {
  const st = newState();
  // Excel-mangled tote_simplified ("04-Feb") must not affect anything
  const text = csv([row({ barcode: 'B1', toteSimplified: '04-Feb', toteNumber: '4', partition: '2' })]);
  loadDump(st, text, 'x.csv');
  assert.equal(st.barcodes.B1.pt, '2');
  assert.equal(st.totes.TL0000000001.n, '4');
});

test('loadDump — processable when status=AVAILABLE and availability in {AVAILABLE,NOT_FOUND,NOT_FOUND_HOLD}', () => {
  const st = newState();
  const text = csv([
    row({ barcode: 'B1', status: 'AVAILABLE', availability: 'AVAILABLE' }),
    row({ barcode: 'B2', status: 'AVAILABLE', availability: 'NOT_FOUND' }),
    row({ barcode: 'B3', status: 'AVAILABLE', availability: 'NOT_FOUND_HOLD' }),
    row({ barcode: 'B4', status: 'AVAILABLE', availability: 'DISPOSED' }),
    row({ barcode: 'B5', status: 'DAMAGED', availability: 'AVAILABLE' }),
  ]);
  loadDump(st, text, 'x.csv');
  assert.equal(st.barcodes.B1.pr, 1);
  assert.equal(st.barcodes.B2.pr, 1);
  assert.equal(st.barcodes.B3.pr, 1);
  assert.equal(st.barcodes.B4.pr, 0);
  assert.equal(st.barcodes.B5.pr, 0);
});

test('loadDump — eligibility is read from st.settings, not hard-coded: changing the lists changes what is processable', () => {
  const st = newState({ ...newState().settings, processableStatus: ['AVAILABLE', 'DAMAGED'], processableAvailability: ['DISPOSED'] });
  const text = csv([
    row({ barcode: 'B1', status: 'DAMAGED', availability: 'DISPOSED' }), // now eligible under the custom lists
    row({ barcode: 'B2', status: 'AVAILABLE', availability: 'NOT_FOUND' }), // was eligible by default, no longer (NOT_FOUND dropped)
  ]);
  loadDump(st, text, 'x.csv');
  assert.equal(st.barcodes.B1.pr, 1);
  assert.equal(st.barcodes.B2.pr, 0);
});

test('loadDump — new tote is added and counted', () => {
  const st = newState();
  const res = loadDump(st, csv([row({ barcode: 'B1' })]), 'x.csv');
  assert.equal(res.newTotes, 1);
  assert.equal(res.refreshed, 0);
  assert.equal(st.totes.TL0000000001.s, 'H');
});

test('loadDump — refreshing a still-waiting tote drops its stale pending barcodes', () => {
  const st = newState();
  loadDump(st, csv([row({ barcode: 'B1' }), row({ barcode: 'B2' })]), 'load1.csv');
  const res = loadDump(st, csv([row({ barcode: 'B3' })]), 'load2.csv');
  assert.equal(res.refreshed, 1);
  assert.equal(res.newTotes, 0);
  assert.equal(st.barcodes.B1, undefined);
  assert.equal(st.barcodes.B2, undefined);
  assert.ok(st.barcodes.B3);
});

test('loadDump — a taken tote (already open/closed) reappearing in the dump is skipped and alerted', () => {
  const st = newState();
  loadDump(st, csv([row({ barcode: 'B1' })]), 'load1.csv');
  st.totes.TL0000000001.s = 'O'; // taken for sorting
  const res = loadDump(st, csv([row({ barcode: 'B2' })]), 'load2.csv');
  assert.deepEqual(res.skippedTaken, ['TL0000000001']);
  assert.ok(st.alerts.some(a => a.type === 'TAKEN_TOTE_IN_DUMP'));
  assert.equal(st.barcodes.B2, undefined); // dump for the taken tote is ignored entirely
});

test('loadDump — the persisted load summary (st.loads) carries the real skippedTaken count, not just the alert', () => {
  // regression: persist.js's appendNewLoads always wrote 0 for skippedTaken/conflicts, because
  // loadDump()'s st.loads.push() never set these fields — the alert had the right count,
  // the load-history row silently didn't, so `loads.skipped_taken` never matched reality.
  // (conflicts is currently always [] — loadDump never populates it, see the "reconciled, not
  // conflicted" test below — so this only guards that the field would persist correctly if that changes.)
  const st = newState();
  loadDump(st, csv([row({ barcode: 'B1', tote: 'TL0000000001' })]), 'load1.csv');
  st.totes.TL0000000001.s = 'O'; // taken for sorting -> triggers skippedTaken on the next load
  const res = loadDump(st, csv([row({ barcode: 'B2', tote: 'TL0000000001' })]), 'load2.csv');
  const last = st.loads[st.loads.length - 1];
  assert.equal(last.skippedTaken, res.skippedTaken.length);
  assert.equal(last.conflicts, res.conflicts.length);
  assert.ok(last.skippedTaken > 0);
});

test('loadDump — a barcode already placed/handed-over/set-aside reappearing is reconciled, not conflicted', () => {
  const st = newState();
  loadDump(st, csv([row({ barcode: 'B1', tote: 'TL0000000001', toteNumber: '4' })]), 'load1.csv');
  st.barcodes.B1.s = 'P'; st.barcodes.B1.l = 'A1-T01-P1';
  const res = loadDump(st, csv([row({ barcode: 'B1', tote: 'TL0000000002', toteNumber: '5' })]), 'load2.csv');
  assert.equal(res.alreadySorted, 1);
  assert.equal(res.conflicts.length, 0);
  assert.ok(st.alerts.some(a => a.type === 'ALREADY_SORTED'));
  assert.equal(st.barcodes.B1.s, 'P'); // untouched
  assert.equal(st.barcodes.B1.l, 'A1-T01-P1'); // still placed where it was
  assert.equal(st.barcodes.B1.t, 'TL0000000001'); // its original tote still exists, so the tie is kept
  assert.ok(st.totes.TL0000000002.bs.includes('B1')); // the new dump's tote still lists it though
});

test('loadDump — a reconciled barcode\'s tote-of-record moves on if its original tote no longer exists', () => {
  const st = newState();
  loadDump(st, csv([row({ barcode: 'B1', tote: 'TL0000000001', toteNumber: '4' })]), 'load1.csv');
  st.barcodes.B1.s = 'P'; st.barcodes.B1.l = 'A1-T01-P1';
  delete st.totes.TL0000000001; // original tote is gone (e.g. purged)
  loadDump(st, csv([row({ barcode: 'B1', tote: 'TL0000000002', toteNumber: '5' })]), 'load2.csv');
  assert.equal(st.barcodes.B1.t, 'TL0000000002');
});

test('loadDump — a tote already marked missing (M) reappearing in the dump is kept as missing', () => {
  const st = newState();
  loadDump(st, csv([row({ barcode: 'B1', tote: 'TL0000000001', toteNumber: '4' })]), 'load1.csv');
  st.totes.TL0000000001.s = 'M';
  st.barcodes.B1.s = 'M';
  const res = loadDump(st, csv([row({ barcode: 'B1', tote: 'TL0000000001', toteNumber: '4' })]), 'load2.csv');
  assert.deepEqual(res.missingInDump, ['TL0000000001']);
  assert.equal(st.totes.TL0000000001.s, 'M'); // untouched — only a scan or explicit reinstate brings it back
  assert.equal(st.barcodes.B1.s, 'M');
});

test('loadDump — a not-found barcode reappearing is accepted again', () => {
  const st = newState();
  loadDump(st, csv([row({ barcode: 'B1' })]), 'load1.csv');
  st.barcodes.B1.s = 'N';
  const res = loadDump(st, csv([row({ barcode: 'B1', tote: 'TL0000000002', toteNumber: '5' })]), 'load2.csv');
  assert.equal(res.foundAgain, 1);
  assert.equal(st.barcodes.B1.s, 'H');
  assert.equal(st.barcodes.B1.t, 'TL0000000002');
});
