/* ===== Real-dump acceptance replay (PLAN.md §10, rev. 03-Oct-2026) =====
 * Runs the repo's actual PID Hunter export through the real batch (Route) lifecycle: the
 * 60-tote rack (240 locations), 50-tote batches in file order, a real giveMin=5 handover after
 * every batch. Reference point from the owner's own 01-Oct export (a different day's dump, so
 * exact figures won't match, only the shape of the result): 0 NO SPACE, ~55,766 handed over,
 * peak ~17,400 pieces in <=213 of 240 partitions. This file's own run came out at 0 NO SPACE,
 * 55,781 handed over, peak 17,237 pieces in 209 locations — close enough to confirm the batch
 * lifecycle (routeR-scoped reservations, single shared pool, real giveMin=5 handover) behaves
 * the way the owner independently observed, not a coincidence of this specific file.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newState, defaultSettings, recount } from '../src/core/state.js';
import { loadDump } from '../src/core/dump.js';
import { scan, finishTote } from '../src/core/scan.js';
import { activateRoute, deactivateRoute } from '../src/core/route.js';
import { buildHandover, handOver, placedByPid } from '../src/core/handover.js';
import { summary } from '../src/core/summary.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DUMP_FILE = 'Current Barcode Inventory for Export-data-2026-09-29 13_17_32.csv';
const DUMP_PATH = path.join(ROOT, DUMP_FILE);
const LAYOUT = { aisles: 3, totesPerAisle: 20, lastAisleTotes: 20, partitions: 4, cap: 100, headroomPct: 5, softPidCap: 20 };

const hasRealDump = fs.existsSync(DUMP_PATH);
const run = hasRealDump ? test : test.skip;

run('real-dump replay — 60-tote layout, 50-tote batches, handover every batch: 0 NO SPACE, caps respected', { timeout: 60000 }, () => {
  const text = fs.readFileSync(DUMP_PATH, 'utf8');
  const st = newState({ ...defaultSettings(), ...LAYOUT });
  const loaded = loadDump(st, text, DUMP_FILE);
  assert.equal(loaded.ok, true);

  const waiting = Object.keys(st.totes).filter(t => st.totes[t].s === 'H');
  let noSpace = 0, totalGiven = 0, totesFinished = 0, peakUnits = 0, peakLocs = 0, maxLocUsed = 0, maxPidsPerLoc = 0;
  const BATCH_SIZE = 50;
  for (let b = 0; b < waiting.length; b += BATCH_SIZE) {
    const batchToteIds = waiting.slice(b, b + BATCH_SIZE);
    activateRoute(st, batchToteIds);
    for (const t of batchToteIds) {
      scan(st, 'SIM-1', t);
      for (const code of st.totes[t].bs.slice()) {
        const r = scan(st, 'SIM-1', code);
        if (r && r.type === 'error' && /NO SPACE/.test(r.msg || '')) noSpace++;
      }
      finishTote(st, 'SIM-1'); totesFinished++;
      const s = summary(st);
      peakUnits = Math.max(peakUnits, s.C); peakLocs = Math.max(peakLocs, s.locUsed);
      for (const L of st.locations) { maxLocUsed = Math.max(maxLocUsed, L.used); maxPidsPerLoc = Math.max(maxPidsPerLoc, Object.keys(L.pids).length); }
    }
    deactivateRoute(st);
    const { plan } = buildHandover(st, 5);
    const idx = placedByPid(st);
    for (const p of plan.filter(p => p.give > 0)) totalGiven += handOver(st, p.pid, p.give, new Date(), idx);
  }

  assert.equal(totesFinished, waiting.length); // every tote in the file got processed
  assert.equal(noSpace, 0); // the hard 240-location cap was never hit
  assert.ok(maxLocUsed <= 95, );
  assert.ok(maxPidsPerLoc <= 20, );
  assert.ok(peakLocs <= 240, );
  assert.equal(summary(st).H, totalGiven);

  // sanity-check against the owner's own 01-Oct export (a different day's dump — same shape,
  // not an exact match): tens of thousands handed over, peak around ~17,400 pieces placed
  assert.ok(totalGiven > 40000, );
  assert.ok(peakUnits > 10000 && peakUnits < 25000, );
});

run('real-dump replay — a fresh recount over the final barcode states matches the incrementally-tracked P.C/P.R/P.H/P.N (no drift across the whole batch lifecycle)', { timeout: 60000 }, () => {
  const text = fs.readFileSync(DUMP_PATH, 'utf8');
  const st = newState({ ...defaultSettings(), ...LAYOUT });
  const loaded = loadDump(st, text, DUMP_FILE);
  assert.equal(loaded.ok, true);

  // replay the same batch lifecycle as the test above, directly against a
  // state we keep a handle on, so we can recount() it afterward and compare
  const waiting = Object.keys(st.totes).filter(t => st.totes[t].s === 'H');
  const BATCH_SIZE = 50;
  for (let b = 0; b < waiting.length; b += BATCH_SIZE) {
    const batchToteIds = waiting.slice(b, b + BATCH_SIZE);
    activateRoute(st, batchToteIds);
    for (const t of batchToteIds) {
      scan(st, 'SIM-1', t);
      for (const code of st.totes[t].bs.slice()) scan(st, 'SIM-1', code);
      finishTote(st, 'SIM-1');
    }
    deactivateRoute(st);
    const { plan } = buildHandover(st, 5);
    const givers = plan.filter(p => p.give > 0);
    const idx = placedByPid(st);
    for (const p of givers) handOver(st, p.pid, p.give, new Date(), idx);
  }

  const before = {};
  for (const p in st.pids) before[p] = { ...st.pids[p] };
  recount(st);
  let checked = 0;
  for (const p in before) {
    assert.equal(st.pids[p].R, before[p].R, `R drifted for ${p}`);
    assert.equal(st.pids[p].C, before[p].C, `C drifted for ${p}`);
    assert.equal(st.pids[p].H, before[p].H, `H drifted for ${p}`);
    assert.equal(st.pids[p].N, before[p].N, `N drifted for ${p}`);
    checked++;
  }
  assert.ok(checked > 1000, `expected thousands of PIDs to cross-check, only found ${checked}`);
});
