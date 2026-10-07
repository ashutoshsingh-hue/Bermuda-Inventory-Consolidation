import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newState, recount } from '../../src/core/state.js';
import { releaseFromLocation, consolidationView, releaseAllPlaced } from '../../src/core/handover.js';

// consolidationView()/releaseFromLocation()/releaseAllPlaced() must handle any already-placed
// record correctly regardless of how it got placed — scan() now diverts under-5-total PIDs
// away from placement entirely, so this builds the "already placed, under-5" state directly
// (as legacy/migrated data would look) rather than through scan(), to keep exercising these
// core functions' own logic independent of that scan-time rule.
function setup() {
  const st = newState();
  const L = st.locations[0];
  st.totes.T1 = { n: '1', s: 'H', bs: ['B1', 'B2', 'B3'] };
  st.barcodes.B1 = { p: 'P1', t: 'T1', pt: '1', pr: 1, s: 'P', l: L.code, ts: '2026-01-01 00:00:00' };
  st.barcodes.B2 = { p: 'P1', t: 'T1', pt: '1', pr: 1, s: 'P', l: L.code, ts: '2026-01-01 00:00:01' };
  st.barcodes.B3 = { p: 'P2', t: 'T1', pt: '1', pr: 1, s: 'P', l: L.code, ts: '2026-01-01 00:00:02' };
  L.used = 3; L.pids.P1 = { c: 2, r: 2 }; L.pids.P2 = { c: 1, r: 1 };
  recount(st);
  return st;
}

test('consolidationView — lists every location/pid with real placed stock, with known total and earliest placement', () => {
  const st = setup();
  const view = consolidationView(st);
  assert.equal(view.locationsActive, 1);
  assert.equal(view.pidsOpen, 2);
  assert.equal(view.rows.length, 2);
  const p1Row = view.rows.find(r => r.pid === 'P1');
  assert.equal(p1Row.qtyHere, 2);
  assert.equal(p1Row.knownTotal, 2); // C=2, R=0 at this point
  assert.ok(p1Row.placedAt);
});

test('consolidationView — a pid with only a reservation (nothing physically placed) is not listed', () => {
  const st = newState();
  const L = st.locations[0];
  L.pids.GHOST = { c: 0, r: 3 }; // reserved, nothing placed yet
  const view = consolidationView(st);
  assert.equal(view.rows.length, 0);
});

test('consolidationView — each row carries live handover reasoning (give/why/risk), not just placement facts', () => {
  const st = setup(); // P1: C=2,R=0,T=2 -> under 5, waits; P2: C=1,R=0,T=1 -> under 5, waits
  const view = consolidationView(st);
  const p1Row = view.rows.find(r => r.pid === 'P1');
  assert.equal(p1Row.give, 0);
  assert.match(p1Row.why, /Under 5/);
  assert.equal(p1Row.risk, false);
});

test('releaseAllPlaced — releases every location/pid row in one shot, bypassing hold-back for all of them', () => {
  const st = setup(); // P1 (2 units) and P2 (1 unit), both placed, both under-5 (would normally wait)
  const r = releaseAllPlaced(st);
  assert.equal(r.ok, true);
  assert.equal(r.totalGiven, 3);
  assert.equal(r.pidsReleased, 2);
  assert.equal(consolidationView(st).rows.length, 0);
  assert.equal(st.pids.P1.H, 2);
  assert.equal(st.pids.P2.H, 1);
});

test('releaseAllPlaced — a no-op when nothing is placed anywhere', () => {
  const st = newState();
  const r = releaseAllPlaced(st);
  assert.equal(r.ok, true);
  assert.equal(r.totalGiven, 0);
  assert.equal(r.locationsReleased, 0);
  assert.equal(r.pidsReleased, 0);
});

test('releaseFromLocation — hands over exactly what\'s placed in that location, bypassing the hold-back rule', () => {
  const st = setup();
  const loc = st.locations.find(l => l.used > 0 && l.pids.P1).code;
  // P1 has C=2, R=0 -> T=2 < 5, normally handoverSuggestion() would say "under 5, wait" —
  // but this is a direct admin override, so it goes anyway
  const r = releaseFromLocation(st, loc, 'P1');
  assert.equal(r.ok, true);
  assert.equal(r.given, 2);
  assert.equal(st.pids.P1.C, 0);
  assert.equal(st.pids.P1.H, 2);
  const L = st.locations.find(l => l.code === loc);
  assert.equal(L.pids.P1, undefined); // fully cleared out
});

test('releaseFromLocation — only touches the named location, not the same pid placed elsewhere', () => {
  const st = setup();
  // force P1's second barcode into a different location by hand to simulate multi-location spread
  const otherLoc = st.locations.find(l => l.used === 0);
  st.barcodes.B2.l = otherLoc.code;
  const firstLoc = st.locations.find(l => l.used > 0 && l.pids.P1 && l.code !== otherLoc.code);
  otherLoc.used = 1; otherLoc.pids.P1 = { c: 1, r: 1 };
  firstLoc.pids.P1 = { c: 1, r: 1 };

  const r = releaseFromLocation(st, firstLoc.code, 'P1');
  assert.equal(r.given, 1);
  assert.equal(otherLoc.pids.P1.c, 1); // untouched
  assert.equal(st.barcodes.B2.s, 'P'); // untouched
});

test('releaseFromLocation — errors clearly for an unknown location, unknown pid, or nothing placed there', () => {
  const st = setup();
  assert.equal(releaseFromLocation(st, 'NOPE', 'P1').ok, false);
  const loc = st.locations.find(l => l.used > 0).code;
  assert.equal(releaseFromLocation(st, loc, 'NOPE').ok, false);
  assert.equal(releaseFromLocation(st, st.locations.find(l => l.used === 0).code, 'P1').ok, false);
});
