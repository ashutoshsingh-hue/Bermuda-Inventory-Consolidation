import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newState } from '../../src/core/state.js';
import { capacityForecast } from '../../src/core/forecast.js';

// small layout for predictable numbers: aisles=1, totesPerAisle=2, partitions=1, plan cap = 108 (120 * 0.9)
function setup() {
  return newState({ aisles: 1, totesPerAisle: 2, lastAisleTotes: 2, partitions: 1, cap: 120, headroomPct: 10, softPidCap: 20 });
}

test('capacityForecast — empty state needs nothing, no warning', () => {
  const st = setup();
  const f = capacityForecast(st);
  assert.equal(f.locationsNeeded, 0);
  assert.equal(f.locationsAvailable, 2); // 2 locations total
  assert.equal(f.shortfall, 0);
  assert.equal(f.warning, false);
});

test('capacityForecast — under-5 pids are excluded entirely, matching scan.js\'s own exclusion', () => {
  const st = setup();
  for (let i = 0; i < 4; i++) st.barcodes['B' + i] = { p: 'UNDER5', pr: 1, s: 'H' };
  const f = capacityForecast(st);
  assert.equal(f.locationsNeeded, 0);
  assert.equal(f.breakdown.pids, 0);
});

test('capacityForecast — counts both placed and still-waiting barcodes toward one pid\'s total', () => {
  const st = setup();
  for (let i = 0; i < 3; i++) st.barcodes['P' + i] = { p: 'X', pr: 1, s: 'P' }; // 3 placed
  for (let i = 0; i < 4; i++) st.barcodes['H' + i] = { p: 'X', pr: 1, s: 'H' }; // 4 waiting
  const f = capacityForecast(st); // T=7
  assert.equal(f.breakdown.pids, 1);
  assert.equal(f.breakdown.units, 7);
});

test('capacityForecast — ignores non-processable, handed-over, not-found and set-aside barcodes', () => {
  const st = setup();
  for (let i = 0; i < 10; i++) st.barcodes['O' + i] = { p: 'DONE', pr: 1, s: 'O' }; // already handed over
  for (let i = 0; i < 10; i++) st.barcodes['N' + i] = { p: 'GONE', pr: 1, s: 'N' }; // not found
  for (let i = 0; i < 10; i++) st.barcodes['X' + i] = { p: 'ASIDE', pr: 1, s: 'X' }; // set aside
  for (let i = 0; i < 10; i++) st.barcodes['NP' + i] = { p: 'NOTPROC', pr: 0, s: 'H' }; // non-processable, still H
  const f = capacityForecast(st);
  assert.equal(f.locationsNeeded, 0);
});

test('capacityForecast — a single big pid needs ceil(T/plan) locations', () => {
  const st = setup();
  for (let i = 0; i < 200; i++) st.barcodes['B' + i] = { p: 'HUGE', pr: 1, s: 'H' }; // T=200, plan=108
  const f = capacityForecast(st);
  assert.equal(f.breakdown.pids, 1);
  assert.equal(f.breakdown.locations, 2); // ceil(200/108)
  assert.equal(f.locationsNeeded, 2);
});

test('capacityForecast — several pids share one pool: total units, not per-pid location counts, drive the need', () => {
  const st = setup(); // 2 locations, plan=108 each -> 216 units of shared headroom
  for (const p of ['A', 'B', 'C']) {
    for (let i = 0; i < 60; i++) st.barcodes[p + i] = { p, pr: 1, s: 'H' }; // 180 units total across 3 pids
  }
  const f = capacityForecast(st);
  assert.equal(f.breakdown.pids, 3);
  assert.equal(f.breakdown.units, 180);
  assert.equal(f.locationsNeeded, 2); // ceil(180/108) = 2 -- they now share the pool instead of each needing its own
  assert.equal(f.warning, false);
});

test('capacityForecast — warns when total shared-pool need exceeds available locations', () => {
  const st = setup(); // only 2 locations available, plan=108 each -> 216 units total capacity
  for (const p of ['A', 'B', 'C', 'D']) {
    for (let i = 0; i < 60; i++) st.barcodes[p + i] = { p, pr: 1, s: 'H' }; // 240 units, over the 216-unit pool
  }
  const f = capacityForecast(st);
  assert.equal(f.locationsNeeded, 3); // ceil(240/108)
  assert.equal(f.locationsAvailable, 2);
  assert.equal(f.shortfall, 1);
  assert.equal(f.warning, true);
});

test('capacityForecast — softPidCap also drives the need, independent of unit volume', () => {
  const st = newState({ aisles: 1, totesPerAisle: 2, lastAisleTotes: 2, partitions: 1, cap: 120, headroomPct: 10, softPidCap: 2 });
  for (const p of ['A', 'B', 'C']) for (let i = 0; i < 5; i++) st.barcodes[p + i] = { p, pr: 1, s: 'H' }; // 3 pids, 5 units each = 15 units total (well under plan), but softPidCap=2
  const f = capacityForecast(st);
  assert.equal(f.breakdown.pids, 3);
  assert.equal(f.locationsNeeded, 2); // ceil(3/2) = 2, driven by PID count, not the tiny unit volume
});

test('capacityForecast — no warning when need is within available capacity', () => {
  const st = setup();
  for (let i = 0; i < 60; i++) st.barcodes['A' + i] = { p: 'A', pr: 1, s: 'H' };
  const f = capacityForecast(st);
  assert.equal(f.locationsNeeded, 1);
  assert.equal(f.warning, false);
});

test('capacityForecast — while a route is active, demand is scoped to st.routeR, not the whole dump\'s R', () => {
  const st = setup();
  st.barcodes.P1 = { p: 'A', pr: 1, s: 'P' }; // 1 already placed
  for (let i = 0; i < 50; i++) st.barcodes['H' + i] = { p: 'A', pr: 1, s: 'H' }; // 50 more waiting dump-wide
  st.routeR = { A: 4 }; // but only 4 of them are inside the active route's totes
  const f = capacityForecast(st);
  assert.equal(f.breakdown.units, 5); // 1 placed + 4 route-scoped, not 1 + 50
  assert.equal(f.locationsNeeded, 1);
});

test('capacityForecast — a pid absent from st.routeR while a route is active contributes nothing beyond what\'s already placed', () => {
  const st = setup();
  st.barcodes.P1 = { p: 'A', pr: 1, s: 'P' };
  for (let i = 0; i < 50; i++) st.barcodes['H' + i] = { p: 'A', pr: 1, s: 'H' };
  st.routeR = {}; // active route, but A has none of its waiting stock inside it
  const f = capacityForecast(st);
  assert.equal(f.breakdown.units, 1); // just the 1 already placed
});
