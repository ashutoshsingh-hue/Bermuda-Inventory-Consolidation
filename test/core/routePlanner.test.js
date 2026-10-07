import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newState } from '../../src/core/state.js';
import { waitingTotes, planRoutes, describeTotes } from '../../src/core/routePlanner.js';

function addTote(st, toteId, toteNum, count, { s = 'H', pr = 1 } = {}) {
  st.totes[toteId] = { n: toteNum, s, bs: [] };
  for (let i = 0; i < count; i++) {
    const b = `${toteId}-B${i}`;
    st.barcodes[b] = { p: `P${toteId}`, t: toteId, pt: '1', pr, s: 'H' };
    st.totes[toteId].bs.push(b);
  }
  for (let i = 0; i < count; i++) {
    const p = `P${toteId}`;
    st.pids[p] = st.pids[p] || { C: 0, R: count, locs: {} };
  }
}
function stateWithTotes(n, extra = {}) {
  const st = newState();
  Object.assign(st.settings, extra);
  for (let i = 1; i <= n; i++) addTote(st, `T${i}`, String(i), 2);
  return st;
}

test('planRoutes — 120 waiting totes make rounds of 50, 50, 20 in dump order', () => {
  const st = stateWithTotes(120);
  const rounds = planRoutes(st, { rounds: 10 });
  assert.deepEqual(rounds.map(r => r.toteIds.length), [50, 50, 20]);
  assert.equal(rounds[0].toteIds[0], 'T1');
  assert.equal(rounds[0].toteIds[49], 'T50');
  assert.equal(rounds[1].toteIds[0], 'T51');
});

test('planRoutes — defaults to settings.batchSize and honors a different one', () => {
  assert.equal(planRoutes(stateWithTotes(120))[0].toteIds.length, 50);
  assert.equal(planRoutes(stateWithTotes(120, { batchSize: 30 }))[0].toteIds.length, 30);
});

test('planRoutes — only the requested number of rounds is returned', () => {
  const st = stateWithTotes(120);
  assert.equal(planRoutes(st, { rounds: 1 }).length, 1);
  assert.equal(planRoutes(st, { rounds: 2 }).length, 2);
});

test('planRoutes — the queue updates itself: finished and open totes drop out, next round refills', () => {
  const st = stateWithTotes(120);
  assert.equal(planRoutes(st)[0].toteIds[0], 'T1');
  for (let i = 1; i <= 50; i++) st.totes[`T${i}`].s = 'C'; // route 1 finished
  st.totes.T51.s = 'O';                                      // a tote open at a station
  const next = planRoutes(st)[0].toteIds;
  assert.equal(next.length, 50);
  assert.equal(next[0], 'T52');
  assert.ok(!next.includes('T51'));
});

test('waitingTotes — skips excluded and missing totes; empty queue gives no rounds', () => {
  const st = stateWithTotes(3);
  st.totes.T2.s = 'M';
  assert.deepEqual(waitingTotes(st), ['T1', 'T3']);
  assert.deepEqual(waitingTotes(st, ['T1']), ['T3']);
  assert.deepEqual(planRoutes(newState()), []);
});

test('describeTotes — counts barcodes and processable barcodes per tote', () => {
  const st = newState();
  addTote(st, 'T1', '7', 3);
  addTote(st, 'T2', '8', 2, { pr: 0 });
  assert.deepEqual(describeTotes(st, ['T1', 'T2']), [
    { tote: 'T1', n: '7', barcodes: 3, processable: 3 },
    { tote: 'T2', n: '8', barcodes: 2, processable: 0 },
  ]);
});

test('waitingTotes — ordered by tote number, not by insertion order (stable after a DB reload)', () => {
  const st = newState();
  addTote(st, 'TL9', '3', 1); addTote(st, 'TL1', '10', 1); addTote(st, 'TL5', '2', 1);
  assert.deepEqual(waitingTotes(st), ['TL5', 'TL9', 'TL1']);
});

test('planRoutes — round order is the stations\' recommend() queue order, even with a route active', async () => {
  const { recommend } = await import('../../src/core/recommend.js');
  const st = stateWithTotes(6);
  st.pids.PT3.R = 12; st.pids.PT3.C = 0; // PT3 becomes a big PID, so its tote ranks first
  const expected = recommend(st, { limit: 0 }).list.map(x => x.tote);
  assert.equal(expected[0], 'T3');
  assert.deepEqual(planRoutes(st, { size: 4 })[0].toteIds, expected.slice(0, 4));
  st.routeToteIds = new Set(['T1']);
  assert.deepEqual(planRoutes(st, { size: 4 })[0].toteIds, expected.slice(0, 4));
});
