import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newState, recount } from '../../src/core/state.js';
import { scan, undoLast, finishTote, toteProgress, forceReleaseTote } from '../../src/core/scan.js';

function setup() {
  const st = newState();
  st.totes.T1 = { n: '1', s: 'H', bs: ['B1', 'B2'] };
  st.barcodes.B1 = { p: 'P1', t: 'T1', pt: '1', pr: 1, s: 'H' };
  st.barcodes.B2 = { p: 'P1', t: 'T1', pt: '1', pr: 0, s: 'H' }; // not processable
  // P1 needs a known total >= 5 to be placeable at all (under-5 PIDs are left aside, never
  // placed) — the other 4 live in a separate holding tote so T1-specific tests are unaffected
  st.totes.T9 = { n: '9', s: 'H', bs: ['B1b', 'B1c', 'B1d', 'B1e'] };
  for (const b of ['B1b', 'B1c', 'B1d', 'B1e']) st.barcodes[b] = { p: 'P1', t: 'T9', pt: '1', pr: 1, s: 'H' };
  recount(st); // as loadDump() would, so P1.R reflects all 5 before any scanning
  return st;
}

test('scan — opening a tote locks it to that station', () => {
  const st = setup();
  const r = scan(st, 'S1', 'T1');
  assert.equal(r.type, 'tote');
  assert.equal(st.totes.T1.station, 'S1');
});

test('scan — a second station scanning a tote open elsewhere gets "Tote open at Station X"', () => {
  const st = setup();
  scan(st, 'S1', 'T1');
  const r = scan(st, 'S2', 'T1');
  assert.equal(r.type, 'error');
  assert.match(r.msg, /Tote open at Station S1/);
});

test('scan — the owning station re-scanning its own open tote gets an info message, not an error', () => {
  const st = setup();
  scan(st, 'S1', 'T1');
  const r = scan(st, 'S1', 'T1');
  assert.equal(r.type, 'info');
});

test('scan — a station must finish its current tote before opening another', () => {
  const st = setup();
  st.totes.T2 = { n: '2', s: 'H', bs: [] };
  scan(st, 'S1', 'T1');
  const r = scan(st, 'S1', 'T2');
  assert.equal(r.type, 'error');
  assert.match(r.msg, /Finish tote 1 first/);
});

test('scan — a barcode cannot be scanned before a tote is open', () => {
  const st = setup();
  const r = scan(st, 'S1', 'B1');
  assert.equal(r.type, 'error');
  assert.match(r.msg, /Scan the TOTE first/);
});

test('scan — processable barcode is placed and the PID/location counts update', () => {
  const st = setup();
  scan(st, 'S1', 'T1');
  const r = scan(st, 'S1', 'B1');
  assert.equal(r.type, 'place');
  assert.ok(r.loc);
  assert.equal(st.pids.P1.C, 1);
});

test('scan — a PID whose known total never reaches 5 is left aside, never placed', () => {
  const st = newState();
  st.totes.T1 = { n: '1', s: 'H', bs: ['B1', 'B2', 'B3'] };
  for (const b of ['B1', 'B2', 'B3']) st.barcodes[b] = { p: 'UNDER5', t: 'T1', pt: '1', pr: 1, s: 'H' };
  recount(st); // known total = 3, under the 5 threshold
  scan(st, 'S1', 'T1');
  for (const b of ['B1', 'B2', 'B3']) {
    const r = scan(st, 'S1', b);
    assert.equal(r.type, 'aside');
    assert.equal(st.barcodes[b].s, 'X');
  }
  assert.equal(st.pids.UNDER5.C, 0);
  assert.equal(st.pids.UNDER5.R, 0); // recount() wouldn't count an 'X' barcode toward R either
});

test('scan — right at the boundary: a PID whose total is exactly 5 IS placed, not left aside', () => {
  const st = newState();
  st.totes.T1 = { n: '1', s: 'H', bs: ['B1', 'B2', 'B3', 'B4', 'B5'] };
  for (const b of ['B1', 'B2', 'B3', 'B4', 'B5']) st.barcodes[b] = { p: 'EXACTLY5', t: 'T1', pt: '1', pr: 1, s: 'H' };
  recount(st);
  scan(st, 'S1', 'T1');
  const r = scan(st, 'S1', 'B1');
  assert.equal(r.type, 'place');
});

test('undoLast — undoing an under-5 aside restores R so recount() still matches', () => {
  const st = newState();
  st.totes.T1 = { n: '1', s: 'H', bs: ['B1', 'B2', 'B3'] };
  for (const b of ['B1', 'B2', 'B3']) st.barcodes[b] = { p: 'UNDER5', t: 'T1', pt: '1', pr: 1, s: 'H' };
  recount(st);
  scan(st, 'S1', 'T1');
  scan(st, 'S1', 'B1');
  assert.equal(st.pids.UNDER5.R, 2); // B2, B3 still waiting; B1 excluded (aside)
  const undone = undoLast(st, 'S1');
  assert.equal(undone, 'B1');
  assert.equal(st.barcodes.B1.s, 'H');
  assert.equal(st.pids.UNDER5.R, 3); // back to all 3 waiting

  const cached = { ...st.pids.UNDER5 };
  recount(st);
  assert.deepEqual(st.pids.UNDER5, cached); // matches a fresh recount exactly
});

test('scan — non-processable barcode is set aside, not placed', () => {
  const st = setup();
  scan(st, 'S1', 'T1');
  const r = scan(st, 'S1', 'B2');
  assert.equal(r.type, 'aside');
  assert.equal(st.barcodes.B2.s, 'X');
});

test('scan — re-scanning an already-placed barcode is flagged as a duplicate', () => {
  const st = setup();
  scan(st, 'S1', 'T1'); scan(st, 'S1', 'B1');
  const r = scan(st, 'S1', 'B1');
  assert.equal(r.type, 'dup');
});

test('scan — a barcode that belongs to another tote is placed and flagged EXTRA', () => {
  const st = setup();
  st.totes.T2 = { n: '2', s: 'H', bs: [] };
  st.barcodes.B3 = { p: 'P2', t: 'T2', pt: '1', pr: 1, s: 'H' };
  // P2 needs a known total >= 5 too, same as P1 in setup()
  st.totes.T10 = { n: '10', s: 'H', bs: ['B3b', 'B3c', 'B3d', 'B3e'] };
  for (const b of ['B3b', 'B3c', 'B3d', 'B3e']) st.barcodes[b] = { p: 'P2', t: 'T10', pt: '1', pr: 1, s: 'H' };
  recount(st);
  scan(st, 'S1', 'T1');
  const r = scan(st, 'S1', 'B3');
  assert.equal(r.type, 'extra');
  assert.ok(st.alerts.some(a => a.type === 'EXTRA'));
});

test('scan — an unrecognized code is flagged UNKNOWN', () => {
  const st = setup();
  scan(st, 'S1', 'T1');
  const r = scan(st, 'S1', 'NOPE');
  assert.equal(r.type, 'unknown');
  assert.ok(st.alerts.some(a => a.type === 'UNKNOWN'));
});

test('undoLast — a station can only undo its own last scan', () => {
  const st = setup();
  scan(st, 'S1', 'T1'); scan(st, 'S1', 'B1');
  const undone = undoLast(st, 'S2'); // S2 never scanned anything
  assert.equal(undone, null);
  assert.equal(st.barcodes.B1.s, 'P'); // untouched
  const undone2 = undoLast(st, 'S1');
  assert.equal(undone2, 'B1');
  assert.equal(st.barcodes.B1.s, 'H');
  assert.equal(st.pids.P1.C, 0);
});

test('undoLast — one station\'s undo never touches another station\'s scans', () => {
  const st = setup();
  st.totes.T2 = { n: '2', s: 'H', bs: ['B3'] };
  st.barcodes.B3 = { p: 'P2', t: 'T2', pt: '1', pr: 1, s: 'H' };
  // P2 needs a known total >= 5 too, same as P1 in setup()
  st.totes.T10 = { n: '10', s: 'H', bs: ['B3b', 'B3c', 'B3d', 'B3e'] };
  for (const b of ['B3b', 'B3c', 'B3d', 'B3e']) st.barcodes[b] = { p: 'P2', t: 'T10', pt: '1', pr: 1, s: 'H' };
  recount(st);
  scan(st, 'S1', 'T1'); scan(st, 'S1', 'B1');
  scan(st, 'S2', 'T2'); scan(st, 'S2', 'B3');
  undoLast(st, 'S1');
  assert.equal(st.barcodes.B3.s, 'P'); // S2's placement survives S1's undo
});

test('finishTote — unscanned processable barcodes become NOT FOUND and R/N update', () => {
  const st = setup();
  scan(st, 'S1', 'T1'); // B1, B2 never scanned
  const res = finishTote(st, 'S1');
  assert.equal(res.notFound.length, 1); // only B1 is processable
  assert.equal(st.barcodes.B1.s, 'N');
  assert.equal(st.pids.P1.N, 1);
  assert.equal(st.pids.P1.R, 4); // B1 moved from R to N; the other 4 (in the padding tote) are still waiting
});

test('finishTote — releases the station\'s open tote so it can open another', () => {
  const st = setup();
  scan(st, 'S1', 'T1');
  finishTote(st, 'S1');
  st.totes.T2 = { n: '2', s: 'H', bs: [] };
  const r = scan(st, 'S1', 'T2');
  assert.equal(r.type, 'tote');
});

test('toteProgress — reports expected vs. done for a tote', () => {
  const st = setup();
  scan(st, 'S1', 'T1');
  let p = toteProgress(st, 'T1');
  assert.deepEqual(p, { exp: 2, done: 0 });
  scan(st, 'S1', 'B1');
  p = toteProgress(st, 'T1');
  assert.equal(p.done, 1);
});

test('forceReleaseTote — clears the crashed station\'s openTote and returns the tote to waiting', () => {
  const st = setup();
  scan(st, 'S1', 'T1');
  const r = forceReleaseTote(st, 'T1');
  assert.deepEqual(r, { tote: 'T1', n: '1' });
  assert.equal(st.totes.T1.s, 'H');
  assert.equal(st.stations.S1.openTote, null);
});

test('forceReleaseTote — another station can then open the released tote', () => {
  const st = setup();
  scan(st, 'S1', 'T1');
  forceReleaseTote(st, 'T1');
  const r = scan(st, 'S2', 'T1');
  assert.equal(r.type, 'tote');
});

test('forceReleaseTote — a no-op on a tote that is not open', () => {
  const st = setup();
  assert.equal(forceReleaseTote(st, 'T1'), null); // still waiting, never opened
  scan(st, 'S1', 'T1'); finishTote(st, 'S1');
  assert.equal(forceReleaseTote(st, 'T1'), null); // already closed
});
