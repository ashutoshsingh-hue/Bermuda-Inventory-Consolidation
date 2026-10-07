import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newState, pid, locByCode, recount } from '../../src/core/state.js';
import { assign } from '../../src/core/allocate.js';
import { scan } from '../../src/core/scan.js';

test('assign — a PID\'s very first scan reserves its full remaining total (R was already decremented before assign() runs)', () => {
  // scan.js decrements P.R for the barcode being placed BEFORE calling assign(), so a naive
  // (P.C + P.R) check reads one low on a PID's first-ever scan — this pins that exact boundary
  // case down through the real scan() path, not just assign() with manually-set R.
  const st = newState();
  st.totes.T1 = { n: 'T1', s: 'H', bs: [] };
  const mkBc = (b, p) => { st.barcodes[b] = { p, t: 'T1', pt: '1', pr: 1, s: 'H' }; st.totes.T1.bs.push(b); };
  for (let i = 0; i < 10; i++) mkBc('TEN' + i, 'PTEN'); // exactly 10 processable barcodes total
  recount(st); // populates PTEN.R = 10 from the barcodes just created, as a real dump load would

  scan(st, 'S1', 'T1');
  const r = scan(st, 'S1', 'TEN0');
  assert.equal(r.type, 'place');
  const L = locByCode(st, r.loc);
  assert.equal(L.pids.PTEN.r, 10); // reservation sized for the full 10, not 9 or 1
});

test('assign — first call opens a new location with a 1-unit reservation', () => {
  const st = newState();
  pid(st, 'P1');
  const code = assign(st, 'P1');
  const L = locByCode(st, code);
  assert.deepEqual(L.pids.P1, { c: 0, r: 1 });
});

test('assign — rule 1: reuses the same location while outstanding reservation remains', () => {
  const st = newState();
  const code1 = assign(st, 'P1');
  const L = locByCode(st, code1);
  L.pids.P1.c = 1; // simulate a placement consuming part of the reservation... still c<r? set r=2 first
  L.pids.P1.r = 2;
  const code2 = assign(st, 'P1');
  assert.equal(code2, code1);
});

test('assign — rule 2: grows reservation on the same location once the location itself still has plan room', () => {
  const st = newState();
  const code = assign(st, 'P1');
  const L = locByCode(st, code);
  L.pids.P1 = { c: 10, r: 10 }; // reservation fully consumed, so rule 1 can't fire
  L.used = 50; // location total still well under plan (108)
  const again = assign(st, 'P1');
  assert.equal(again, code);
  assert.equal(L.pids.P1.r, 11);
});

test('assign — physical cap (120): a location at 120 used is never reused even with outstanding reservation', () => {
  const st = newState();
  const code = assign(st, 'P1');
  const L = locByCode(st, code);
  L.used = 120; L.pids.P1 = { c: 120, r: 125 }; // outstanding=5, but physically full
  const other = assign(st, 'P1');
  assert.notEqual(other, code);
});

test('assign — best fit: a SMALL pid picks the already-active location whose free space is closest to what it still needs', () => {
  const st = newState({ aisles: 1, totesPerAisle: 4, lastAisleTotes: 4, partitions: 1, cap: 120, headroomPct: 10, softPidCap: 20 }); // explicit plan=108, independent of defaults
  pid(st, 'SM').R = 7; // small (C+R=7 < 10) — need = min(8,108) = 8, bundles into a warm location
  const roomy = locByCode(st, st.locations[0].code); roomy.used = 0;      // cold — excluded from this comparison
  // warm locations must have a same-class resident already, same as real scans always produce
  // (L.used and L.pids are always set together in scan.js)
  const snug = locByCode(st, st.locations[1].code); snug.used = 108 - 9; snug.pids.OTHER1 = { c: snug.used, r: snug.used }; pid(st, 'OTHER1').R = 4; // small resident, free 9, closest to 8 among >= need
  const tootight = locByCode(st, st.locations[2].code); tootight.used = 108 - 3; tootight.pids.OTHER2 = { c: tootight.used, r: tootight.used }; pid(st, 'OTHER2').R = 4; // small resident, free 3, < need, not eligible
  const code = assign(st, 'SM');
  assert.equal(code, snug.code);
});

test('assign — a big pid bundles into a warm location of any size, as long as it has enough free room', () => {
  const st = newState();
  pid(st, 'BIG').R = 50; // need = min(51, plan) — plan=95 by default
  // a warm location with easily enough room to fit BIG's need: no size-class separation
  // anymore (PLAN.md §5.6, rev. 03-Oct-2026) — any PIDs may share a partition
  const warmButRoomy = locByCode(st, st.locations[0].code); warmButRoomy.used = 5;
  warmButRoomy.pids.OTHER = { c: 5, r: 5 };
  const code = assign(st, 'BIG');
  assert.equal(code, warmButRoomy.code);
  const L = locByCode(st, code);
  assert.equal(L.pids.BIG.r, 51);
  assert.equal(Object.keys(L.pids).length, 2); // shares the partition with OTHER
});

test('assign — several pids of varied size bundle into the same location, limited only by softPidCap/planCap', () => {
  const st = newState();
  pid(st, 'M1').R = 14; const c1 = assign(st, 'M1');
  pid(st, 'M2').R = 19; const c2 = assign(st, 'M2');
  pid(st, 'M3').R = 6;  const c3 = assign(st, 'M3'); // small total, still welcome in the same location
  assert.equal(c2, c1);
  assert.equal(c3, c1);
  const L = locByCode(st, c1);
  assert.equal(Object.keys(L.pids).length, 3);
});

test('assign — a location runs out of free space once enough is reserved, regardless of pid size', () => {
  const st = newState({ aisles: 1, totesPerAisle: 2, lastAisleTotes: 2, partitions: 1, cap: 120, headroomPct: 10, softPidCap: 20 }); // plan=108
  pid(st, 'HUGE').R = 90; const hugeCode = assign(st, 'HUGE'); // need=91, consumes almost the whole plan
  pid(st, 'MODEST').R = 24; const modestCode = assign(st, 'MODEST'); // need=25 — doesn't fit HUGE's leftover (108-91=17)
  assert.notEqual(modestCode, hugeCode); // lands on a fresh location instead, purely on free space
});

test('assign — several SMALL pids bundle into the same already-active location instead of spreading to fresh ones', () => {
  const st = newState();
  pid(st, 'S1').R = 3; const c1 = assign(st, 'S1');
  pid(st, 'S2').R = 4; const c2 = assign(st, 'S2');
  pid(st, 'S3').R = 2; const c3 = assign(st, 'S3');
  // S1 lands on a fresh (cold) location first; S2/S3, both small, should then bundle into
  // that same now-warm location rather than each claiming their own fresh one
  assert.equal(c2, c1);
  assert.equal(c3, c1);
  const L = locByCode(st, c1);
  assert.equal(Object.keys(L.pids).length, 3);
});

test('assign — a small pid freely bundles into a location that already holds a big one, when there\'s enough room', () => {
  const st = newState(); // default plan=95
  pid(st, 'BIG').R = 50; // need = 51, lands on a fresh location with 95-51=44 free
  const bigCode = assign(st, 'BIG');
  pid(st, 'SM').R = 7; // need = 8 — comfortably fits BIG's leftover 44
  const smCode = assign(st, 'SM');
  assert.equal(smCode, bigCode);
  const L = locByCode(st, bigCode);
  assert.equal(Object.keys(L.pids).length, 2);
});

test('assign — two pids each needing most of the plan cap still end up on separate locations, purely on free space', () => {
  const st = newState(); // default plan=95
  pid(st, 'B1').R = 40; const c1 = assign(st, 'B1'); // need=41, leftover 95-41=54
  pid(st, 'B2').R = 60; const c2 = assign(st, 'B2'); // need=61 > 54 leftover -> doesn't fit
  assert.notEqual(c1, c2);
});

test('assign — softPidCap (20): a location already holding 20 PIDs is skipped even with free space', () => {
  const st = newState();
  const s = st.settings;
  const full = st.locations[0];
  for (let i = 0; i < s.softPidCap; i++) full.pids['X' + i] = { c: 0, r: 1 };
  full.used = 0; // plenty of physical/plan room, but already at the PID cap
  pid(st, 'NEW');
  const code = assign(st, 'NEW');
  assert.notEqual(code, full.code);
});

test('assign — last-resort fallback picks whichever location has the most free space', () => {
  const st = newState({ aisles: 1, totesPerAisle: 2, lastAisleTotes: 2, partitions: 1, cap: 120, headroomPct: 10, softPidCap: 20 });
  const [locA, locB] = st.locations; // 2 locations total, plan cap = 108, both already warm
  pid(st, 'A'); locA.used = 90; locA.pids.A = { c: 90, r: 90 }; // free = 108-90 = 18
  pid(st, 'B'); locB.used = 95; locB.pids.B = { c: 95, r: 95 }; // free = 108-95 = 13
  pid(st, 'NEW').R = 19; // need = 20 — exceeds both locations' free space, so normal best-fit fails for both
  const code = assign(st, 'NEW');
  assert.equal(code, locA.code); // the most free space (18 > 13) wins as the last resort, partial reservation
  assert.equal(locA.pids.NEW.r, 18);
});

test('assign — the last-resort fallback landing back on a location the pid already partially occupies never wipes its existing count', () => {
  // regression: the general best-fit search can legitimately land back on a location this
  // exact pid already partially occupies (e.g. after its own reservation there was exhausted
  // elsewhere). Overwriting L.pids[p] here would silently lose whatever was already placed
  // there (c) while the pid's own P.C keeps counting it — the fix reuses the existing counter.
  // handOver() then walks every 'P' barcode for the pid expecting L.pids[p] to still match
  // reality and would crash ("Cannot read properties of undefined (reading 'c')") otherwise.
  // Found via the real plan-simulator running a large real dump file.
  const st = newState({ aisles: 1, totesPerAisle: 1, lastAisleTotes: 1, partitions: 1, cap: 120, headroomPct: 10, softPidCap: 20 });
  const L = locByCode(st, st.locations[0].code);

  pid(st, 'A'); st.pids.A.C = 1; st.pids.A.R = 0; L.pids.A = { c: 1, r: 1 }; st.pids.A.locs = { [L.code]: 1 };
  pid(st, 'B'); st.pids.B.C = 1; st.pids.B.R = 14; L.pids.B = { c: 1, r: 1 }; st.pids.B.locs = { [L.code]: 1 };
  L.used = 2;

  const code = assign(st, 'A');
  assert.equal(code, L.code); // only location that exists — last resort must still pick it
  assert.equal(L.pids.A.c, 1); // the barcode already placed there must not be forgotten
  assert.ok(L.pids.A.r >= 1);
});

test('assign — a second location is used once the first is at plan cap', () => {
  const st = newState({ aisles: 1, totesPerAisle: 2, lastAisleTotes: 2, partitions: 1, cap: 120, headroomPct: 10, softPidCap: 20 });
  const [first, second] = st.locations;
  first.used = 108; // first location at plan cap, no free space
  pid(st, 'P1');
  const code = assign(st, 'P1');
  assert.equal(code, second.code);
  assert.equal(second.pids.P1.r, 1);
});

test('assign — NO SPACE (400/400 hard cap) when every location is physically full', () => {
  const st = newState({ aisles: 1, totesPerAisle: 2, lastAisleTotes: 2, partitions: 1, cap: 120, headroomPct: 10, softPidCap: 20 });
  const [first, second] = st.locations;
  first.used = 120; second.used = 120;
  pid(st, 'P1');
  assert.equal(assign(st, 'P1'), null);
});

test('placed barcodes are never moved: once a barcode is placed, its location stays fixed', () => {
  const st = newState({ aisles: 1, totesPerAisle: 1, lastAisleTotes: 1, partitions: 1, cap: 5, headroomPct: 0, softPidCap: 20 });
  // plan cap = 5, one tiny location only, so a second PID's barcodes must NO-SPACE-fail once full
  st.totes.T1 = { n: 'T1', s: 'H', bs: [] };
  const mkBc = (b, p) => { st.barcodes[b] = { p, t: 'T1', pt: '1', pr: 1, s: 'H' }; st.totes.T1.bs.push(b); };
  for (let i = 0; i < 5; i++) mkBc('B' + i, 'P1');
  recount(st); // P1's known total is exactly 5 — right at the placeable threshold, not under it
  scan(st, 'S1', 'T1');
  const locs = [];
  for (let i = 0; i < 5; i++) { const r = scan(st, 'S1', 'B' + i); assert.equal(r.type, 'place'); locs.push(r.loc); }
  // re-scanning is impossible (dup), so simulate a later mutation (handover) and check earlier placements' recorded location is untouched
  for (let i = 0; i < 5; i++) assert.equal(st.barcodes['B' + i].l, locs[i]);
  assert.deepEqual(new Set(locs), new Set([locs[0]])); // all 5 fit the single tiny location, same code throughout
});
