import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newState, defaultSettings, locByCode, pid, recount } from '../../src/core/state.js';
import { scan } from '../../src/core/scan.js';
import { locationsInUse, validateLayoutSettings, updateLayoutSettings } from '../../src/core/settings.js';

test('validateLayoutSettings — rejects non-positive-integer fields', () => {
  const r = validateLayoutSettings({ ...defaultSettings(), aisles: 0 });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.includes('aisles')));
});

test('validateLayoutSettings — rejects a headroom/auto-close percentage outside 0-100', () => {
  const r = validateLayoutSettings({ ...defaultSettings(), headroomPct: 150 });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.includes('headroomPct')));
});

test('validateLayoutSettings — rejects a non-positive lastAisleTotes', () => {
  const r = validateLayoutSettings({ ...defaultSettings(), lastAisleTotes: 0 });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.includes('lastAisleTotes')));
});

test('validateLayoutSettings — accepts a valid, changed layout (the user\'s real 20-tote aisle)', () => {
  const r = validateLayoutSettings({ ...defaultSettings(), totesPerAisle: 20 });
  assert.equal(r.ok, true);
  assert.equal(r.settings.totesPerAisle, 20);
});

test('locationsInUse — false on a fresh state, true once anything is placed', () => {
  const st = newState();
  assert.equal(locationsInUse(st), false);
  const L = locByCode(st, st.locations[0].code);
  L.used = 1;
  assert.equal(locationsInUse(st), true);
});

test('locationsInUse — true even for a bare reservation with nothing physically placed yet', () => {
  const st = newState();
  const L = locByCode(st, st.locations[0].code);
  L.pids.P1 = { c: 0, r: 1 }; // reserved, not yet placed
  assert.equal(locationsInUse(st), true);
});

test('updateLayoutSettings — refuses to change anything once a barcode is placed', () => {
  const st = newState();
  st.totes.T1 = { n: '1', s: 'H', bs: ['B1'] };
  st.barcodes.B1 = { p: 'P1', t: 'T1', pt: '1', pr: 1, s: 'H' };
  // P1 needs a known total >= 5 to be placeable at all (under-5 PIDs are left aside)
  st.totes.T9 = { n: '9', s: 'H', bs: ['B1b', 'B1c', 'B1d', 'B1e'] };
  for (const b of ['B1b', 'B1c', 'B1d', 'B1e']) st.barcodes[b] = { p: 'P1', t: 'T9', pt: '1', pr: 1, s: 'H' };
  recount(st);
  scan(st, 'S1', 'T1');
  scan(st, 'S1', 'B1');
  const before = st.settings;
  const r = updateLayoutSettings(st, { ...defaultSettings(), totesPerAisle: 20 });
  assert.equal(r.ok, false);
  assert.equal(st.settings, before); // untouched
});

test('updateLayoutSettings — rebuilds locations to the new shape when nothing is placed', () => {
  const st = newState();
  const r = updateLayoutSettings(st, { ...defaultSettings(), aisles: 2, totesPerAisle: 20, lastAisleTotes: 20, partitions: 4 });
  assert.equal(r.ok, true);
  assert.equal(st.locations.length, 2 * 20 * 4);
  assert.ok(st.locations.some(L => L.code === 'A2-T40-P4')); // aisle 2 continues the tote numbers: T21-T40
  assert.ok(!st.locations.some(L => L.code === 'A2-T01-P1'));
  assert.ok(!st.locations.some(L => L.code === 'A5-T22-P1')); // old 5-aisle/22-tote shape gone
});

test('updateLayoutSettings — clears every pid\'s location associations (they refer to a shape that no longer applies)', () => {
  const st = newState();
  const L = locByCode(st, st.locations[0].code);
  const P = pid(st, 'P1');
  P.locs[L.code] = 1; // no physical usage, so the lock doesn't trip
  updateLayoutSettings(st, { ...defaultSettings(), totesPerAisle: 20 });
  assert.deepEqual(P.locs, {});
});
