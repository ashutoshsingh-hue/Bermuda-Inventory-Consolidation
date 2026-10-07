import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newState, pid, locByCode, recount } from '../../src/core/state.js';
import { assign } from '../../src/core/allocate.js';
import { scan, undoLast, finishTote } from '../../src/core/scan.js';
import { activateRoute, deactivateRoute, refreshRouteR } from '../../src/core/route.js';

function addTote(st, toteId, toteNum, p, count) {
  st.totes[toteId] = { n: toteNum, s: 'H', bs: [] };
  for (let i = 0; i < count; i++) {
    const b = `${toteId}-B${i}`;
    st.barcodes[b] = { p, t: toteId, pt: '1', pr: 1, s: 'H' };
    st.totes[toteId].bs.push(b);
  }
}

test('activateRoute — routeR counts only processable, still-H barcodes inside the route\'s own totes', () => {
  const st = newState();
  addTote(st, 'T1', '1', 'A', 5);
  addTote(st, 'T2', '2', 'B', 3); // not in the route
  st.barcodes['T1-B0'].pr = 0; // one non-processable barcode in the route tote, shouldn't count
  recount(st);

  activateRoute(st, ['T1']);
  assert.deepEqual(st.routeR, { A: 4 }); // 5 total minus the 1 non-processable one; B (outside the route) absent
});

test('activateRoute — a route with no eligible totes yields an empty routeR, not a crash', () => {
  const st = newState();
  activateRoute(st, ['DOES-NOT-EXIST']);
  assert.deepEqual(st.routeR, {});
});

test('refreshRouteR — stays correct after a scan places a barcode (routeR decrements)', () => {
  const st = newState();
  addTote(st, 'T1', '1', 'A', 5);
  recount(st);
  activateRoute(st, ['T1']);
  assert.equal(st.routeR.A, 5);

  scan(st, 'S1', 'T1');
  scan(st, 'S1', 'T1-B0');
  assert.equal(st.routeR.A, 4); // one fewer still 'H' inside the route
});

test('refreshRouteR — undo restores routeR back up', () => {
  const st = newState();
  addTote(st, 'T1', '1', 'A', 5);
  recount(st);
  activateRoute(st, ['T1']);
  scan(st, 'S1', 'T1');
  scan(st, 'S1', 'T1-B0');
  assert.equal(st.routeR.A, 4);

  undoLast(st, 'S1');
  assert.equal(st.routeR.A, 5);
});

test('refreshRouteR — finishTote marking unscanned barcodes NOT FOUND removes them from routeR too', () => {
  const st = newState();
  addTote(st, 'T1', '1', 'A', 5);
  recount(st);
  activateRoute(st, ['T1']);
  scan(st, 'S1', 'T1');
  scan(st, 'S1', 'T1-B0'); // 1 of 5 scanned, 4 remain 'H'
  assert.equal(st.routeR.A, 4);

  finishTote(st, 'S1');
  assert.equal(st.routeR.A ?? 0, 0); // the other 4 went to NOT FOUND, none left 'H' in the route
});

test('refreshRouteR — a lead/admin scan outside the route\'s totes never changes routeR (reads B.t === t)', () => {
  const st = newState();
  addTote(st, 'T1', '1', 'A', 5);
  addTote(st, 'T2', '2', 'A', 3); // same pid, a different (non-route) tote
  recount(st);
  activateRoute(st, ['T1']);
  assert.equal(st.routeR.A, 5);

  scan(st, 'S1', 'T2'); // override scan of a tote outside the route (lead/admin path, gate is in scanService)
  scan(st, 'S1', 'T2-B0');
  assert.equal(st.routeR.A, 5); // untouched — that placement came from outside the route's totes
});

test('assign — reservations while a route is active are sized from routeR, never the whole-dump R', () => {
  const st = newState();
  addTote(st, 'A', '1', 'PID1', 5); // 5 of PID1 in the active route's tote
  pid(st, 'PID1').R = 50; // but the whole dump has 50 more of PID1 waiting elsewhere, outside this batch
  recount(st);
  // recount() would recompute R from all 'H' barcodes of PID1 dump-wide; set it back explicitly
  // to simulate "50 more exist in totes not yet loaded/relevant to this route"
  st.pids.PID1.R = 50;
  activateRoute(st, ['A']);
  assert.equal(st.routeR.PID1, 5);

  scan(st, 'S1', 'A');
  const r = scan(st, 'S1', 'A-B0');
  assert.equal(r.type, 'place');
  const L = locByCode(st, r.loc);
  // need = min(routeR + 1, plan): routeR was 5 at the moment assign() ran (refreshRouteR only
  // catches up afterward, same +1 convention scan.js already uses for the whole-dump P.R) —
  // sized from the route's own 5+1=6, nowhere near P.R's whole-dump 50+1=51
  assert.equal(L.pids.PID1.r, 6);
});

test('deactivateRoute — releases every outstanding (unused) reservation down to what is actually placed', () => {
  const st = newState();
  addTote(st, 'A', '1', 'PID1', 10);
  recount(st);
  activateRoute(st, ['A']);
  scan(st, 'S1', 'A');
  scan(st, 'S1', 'A-B0'); // 1 placed, reservation sized for the route's remaining 10 -> r=10, c=1
  const loc = st.barcodes['A-B0'].l;
  const L = locByCode(st, loc);
  assert.equal(L.pids.PID1.c, 1);
  assert.ok(L.pids.PID1.r > 1); // outstanding reservation beyond what's placed

  deactivateRoute(st);
  assert.equal(L.pids.PID1.r, L.pids.PID1.c); // collapsed to exactly what's placed
  assert.equal(st.routeR, undefined);
  assert.equal(st.routeToteIds, undefined);
});

test('deactivateRoute — a fully-unused reservation (nothing ever placed) is removed entirely', () => {
  const st = newState();
  const L = locByCode(st, st.locations[0].code);
  pid(st, 'GHOST').locs[L.code] = 1;
  L.pids.GHOST = { c: 0, r: 7 }; // reserved but never placed (e.g. the batch ended before any arrived)

  deactivateRoute(st);
  assert.equal(L.pids.GHOST, undefined);
  assert.deepEqual(st.pids.GHOST.locs, {});
});

test('refreshRouteR — a no-op when no route is active', () => {
  const st = newState();
  refreshRouteR(st); // must not throw
  assert.equal(st.routeR, undefined);
});
