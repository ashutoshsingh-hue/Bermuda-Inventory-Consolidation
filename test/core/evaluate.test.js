import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newState, recount, defaultSettings } from '../../src/core/state.js';
import { evaluateTotes } from '../../src/core/evaluate.js';

function toteWith(st, id, entries) {
  st.totes[id] = { n: id, s: 'H', bs: entries.map(e => e.b) };
  for (const e of entries) st.barcodes[e.b] = { p: e.p, t: id, pt: '1', pr: 1, s: e.s };
}

test('evaluateTotes — auto-closes a tote at or above the auto-close share, remaining barcodes go NOT FOUND', () => {
  const st = newState();
  // 9 of 10 already accounted for (90%) -> auto-closed
  toteWith(st, 'T1', [
    ...Array.from({ length: 9 }, (_, i) => ({ b: 'B' + i, p: 'P1', s: 'P' })),
    { b: 'B9', p: 'P1', s: 'H' },
  ]);
  recount(st);
  const r = evaluateTotes(st);
  assert.equal(r.closed.length, 1);
  assert.equal(r.closed[0].tote, 'T1');
  assert.equal(r.closed[0].notFound, 1);
  assert.equal(st.totes.T1.s, 'C');
  assert.equal(st.totes.T1.autoClosed, 1);
  assert.equal(st.barcodes.B9.s, 'N');
  assert.ok(st.alerts.some(a => a.type === 'TOTE_AUTO_CLOSED'));
});

test('evaluateTotes — a partly-sorted tote (10-90%) is flagged but stays waiting', () => {
  const st = newState();
  toteWith(st, 'T1', [
    { b: 'B0', p: 'P1', s: 'P' },
    { b: 'B1', p: 'P1', s: 'H' },
    { b: 'B2', p: 'P1', s: 'H' },
  ]); // 1/3 = 33%
  recount(st);
  const r = evaluateTotes(st);
  assert.equal(r.closed.length, 0);
  assert.equal(r.partial.length, 1);
  assert.equal(r.partial[0].tote, 'T1');
  assert.equal(st.totes.T1.s, 'H'); // still waiting
  assert.equal(st.barcodes.B1.s, 'H'); // not force-closed
  assert.ok(st.alerts.some(a => a.type === 'TOTE_PARTLY_SORTED'));
});

test('evaluateTotes — under 10% (a stray barcode) is left as an ordinary waiting tote, not flagged', () => {
  const st = newState();
  toteWith(st, 'T1', [
    { b: 'B0', p: 'P1', s: 'P' },
    ...Array.from({ length: 19 }, (_, i) => ({ b: 'B' + (i + 1), p: 'P1', s: 'H' })),
  ]); // 1/20 = 5%
  recount(st);
  const r = evaluateTotes(st);
  assert.equal(r.closed.length, 0);
  assert.equal(r.partial.length, 0);
  assert.equal(st.totes.T1.s, 'H');
});

test('evaluateTotes — threshold is configurable via settings.autoCloseSharePct', () => {
  const st = newState({ ...defaultSettings(), autoCloseSharePct: 50 });
  toteWith(st, 'T1', [
    { b: 'B0', p: 'P1', s: 'P' },
    { b: 'B1', p: 'P1', s: 'H' },
  ]); // 50% -> closes with the lowered threshold
  recount(st);
  const r = evaluateTotes(st);
  assert.equal(r.closed.length, 1);
});

test('evaluateTotes — a tote with nothing yet accounted for is untouched', () => {
  const st = newState();
  toteWith(st, 'T1', [{ b: 'B0', p: 'P1', s: 'H' }]);
  recount(st);
  const r = evaluateTotes(st);
  assert.equal(r.closed.length, 0);
  assert.equal(r.partial.length, 0);
  assert.equal(st.totes.T1.s, 'H');
});
