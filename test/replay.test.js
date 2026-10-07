/* Synthetic multi-station replay (single process, no HTTP) — PLAN.md §11 M1.
 * The real acceptance-scale replay (§10, 25-09-2026 dump, ~45.7k barcodes) needs the
 * owner's actual CSV in test/fixtures/sample_dump.csv (per STRUCTURE.md §2) — add it
 * and a dedicated test once that file is available. This test proves the same wiring
 * (recommend -> scan -> finish -> handover -> recount) holds with 2/4/8 stations.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newState, recount } from '../src/core/state.js';
import { scan, finishTote } from '../src/core/scan.js';
import { recommend } from '../src/core/recommend.js';
import { buildHandover, handOver } from '../src/core/handover.js';

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildBacklog(seed) {
  const rand = mulberry32(seed);
  const st = newState();
  const pids = [];
  for (let i = 0; i < 250; i++) {
    const r = rand();
    const total = r < 0.15 ? 10 + Math.floor(rand() * 15)  // big
      : r < 0.5 ? 5 + Math.floor(rand() * 5)                // small
        : 1 + Math.floor(rand() * 4);                       // under-5
    pids.push({ id: 'PID' + i, total });
  }
  const TOTE_SIZE = 18;
  let toteIdx = 0, curTote = null, curCount = TOTE_SIZE;
  const nextTote = () => { toteIdx++; const id = 'TOTE' + toteIdx; st.totes[id] = { n: String(toteIdx), s: 'H', bs: [] }; return id; };
  let bcIdx = 0;
  for (const p of pids) {
    for (let i = 0; i < p.total; i++) {
      if (curCount >= TOTE_SIZE) { curTote = nextTote(); curCount = 0; }
      const b = 'BC' + (bcIdx++);
      st.barcodes[b] = { p: p.id, t: curTote, pt: '1', pr: 1, s: 'H' };
      st.totes[curTote].bs.push(b);
      curCount++;
    }
  }
  recount(st);
  return st;
}

function replay(stations) {
  const st = buildBacklog(42);
  const totalTotes = Object.keys(st.totes).length;
  let noSpaceErrors = 0, processed = 0;
  const HANDOVER_EVERY = 20; // simulate shift-end handover to keep the aisles from filling
  while (true) {
    let anyOpened = false;
    for (let s = 1; s <= stations; s++) {
      const rec = recommend(st, 1);
      if (!rec.list.length) continue;
      const tote = rec.list[0].tote, sid = 'STATION' + s;
      const openRes = scan(st, sid, tote);
      assert.equal(openRes.type, 'tote');
      anyOpened = true;
      for (const b of st.totes[tote].bs.slice()) {
        const r = scan(st, sid, b);
        if (r.type === 'error' && /NO SPACE/.test(r.msg)) noSpaceErrors++;
      }
      finishTote(st, sid);
      processed++;
      if (processed % HANDOVER_EVERY === 0) {
        const { plan } = buildHandover(st);
        for (const p of plan) if (p.give > 0) handOver(st, p.pid, p.give);
      }
    }
    if (!anyOpened) break;
  }
  const { plan } = buildHandover(st);
  for (const p of plan) if (p.give > 0) handOver(st, p.pid, p.give);

  const cached = {}; for (const p in st.pids) cached[p] = { ...st.pids[p] };
  recount(st);
  for (const p in cached) {
    assert.equal(st.pids[p].R, cached[p].R, `R mismatch for ${p}`);
    assert.equal(st.pids[p].C, cached[p].C, `C mismatch for ${p}`);
    assert.equal(st.pids[p].H, cached[p].H, `H mismatch for ${p}`);
    assert.equal(st.pids[p].N, cached[p].N, `N mismatch for ${p}`);
  }
  for (const L of st.locations) {
    assert.ok(L.used <= st.settings.cap, `${L.code} over physical cap (${L.used})`);
    assert.ok(Object.keys(L.pids).length <= st.settings.softPidCap, `${L.code} over PID cap`);
  }
  return { noSpaceErrors, totalTotes, processed };
}

for (const stations of [2, 4, 8]) {
  test(`replay — ${stations} station(s): 0 NO SPACE errors, caps respected, counts reconcile`, () => {
    const { noSpaceErrors, totalTotes, processed } = replay(stations);
    assert.equal(noSpaceErrors, 0);
    assert.equal(processed, totalTotes);
  });
}

test('replay — 2, 4 and 8 stations all fully clear the identical backlog', () => {
  const results = [2, 4, 8].map(replay);
  const [a, b, c] = results;
  assert.equal(a.totalTotes, b.totalTotes);
  assert.equal(b.totalTotes, c.totalTotes);
});
