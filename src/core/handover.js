/* ===== Bermuda Sort Station — handover, hold-back rule (PLAN.md §5.2-5.3) ===== */
import { locByCode, touch } from './state.js';
import { trimReservations } from './allocate.js';
import { shiftOf, nowISO } from './shift.js';

// Operator-facing release nudge (owner request, not a PLAN.md §5 rule): once a PID's
// collected quantity at one location reaches this many units, the operator is offered a
// release button right on the scan screen — never automatic, always the operator's call.
// Shared by scanService (shows the nudge) and consolidationService (enforces it for the
// operator role specifically; lead/admin remain unrestricted as before).
export const RELEASE_NUDGE_THRESHOLD = 30;

// never leave 1-4 behind: what's left of a PID (C+R) after handover must be 0 or >= 5
// N here is the combined not-found count (finish-time NOT FOUND + barcodes in a missing tote)
//
// GIVE_MIN below is an owner-approved override of PLAN.md §5.3's own documented example
// ("R = 0 or R >= 5: hand over all C. This applies even when C is under 5, and is how big
// PIDs clear at shift end"). The owner explicitly rejected that: a give amount under 5 is
// never worth an operator trip, even when the rule otherwise permits it. So R>=5 with C<5 now
// waits instead of releasing the small batch — it still hands over everything once C reaches
// GIVE_MIN. This never conflicts with the 1<=R<=4 partial-keep branch below: that branch is
// only ever reached once T=C+R >= 10 (T of 5-9 is filtered out earlier), where its give
// (T-5) is already >= GIVE_MIN by construction, so it needs no separate check.
const GIVE_MIN = 5;
// giveMin is only ever overridden by the route planner (core/routePlanner.js); the live default is GIVE_MIN.
export function handoverSuggestion(C, R, N = 0, giveMin = GIVE_MIN) {
  if (C === 0) return { give: 0, keep: 0, why: 'Nothing placed' };
  const T = C + R;
  if (T >= 5 && T <= 9 && R > 0) return { give: 0, keep: C, why: `Small PID: wait until all ${T} collected` };
  if (R === 0 && C < 5) return N > 0
    ? { give: 0, keep: C, why: 'AT RISK: not-found / missing tote made it under 5 — admin release', risk: 1 }
    : { give: 0, keep: C, why: 'Under 5 — waiting for new stock', under5: 1 };
  if (T < 5) return { give: 0, keep: C, why: `Under 5 so far (${C} placed + ${R} to come)`, under5: 1 };
  if (R === 0 || R >= 5) {
    if (C < giveMin) return { give: 0, keep: C, why: `${C} collected, ${R} to come — waiting for ${giveMin}+ before release` };
    return { give: C, keep: 0, why: R === 0 ? 'All collected' : `${R} still to come (5+)` };
  }
  const h = 5 - R;
  if (C - h >= 1) return { give: C - h, keep: h, why: `Keep ${h} so ${h}+${R} to come = 5` };
  return { give: 0, keep: C, why: `Wait: ${C}+${R} to come` };
}

export function pidInfo(st, p) {
  const P = st.pids[p]; if (!P) return null;
  const locs = Object.keys(P.locs).map(code => { const e = locByCode(st, code).pids[p]; return { code, placed: e ? e.c : 0, reserved: e ? e.r : 0 }; });
  return { pid: p, R: P.R, C: P.C, H: P.H, N: P.N, M: P.M || 0, locs, sug: handoverSuggestion(P.C, P.R, P.N + (P.M || 0)) };
}

export function placedByPid(st) {
  const m = {};
  for (const b in st.barcodes) { const B = st.barcodes[b]; if (B.s === 'P') (m[B.p] || (m[B.p] = [])).push([b, B]); }
  return m;
}

// pulling order: the locations holding the fewest of that PID first (§5.3)
function pullOrder(st, p, bs) {
  return bs.slice().sort((a, b) => {
    const La = locByCode(st, a[1].l), Lb = locByCode(st, b[1].l);
    return La.pids[p].c - Lb.pids[p].c;
  });
}

export function handOver(st, p, qty, now = new Date(), idx) {
  const P = st.pids[p]; if (!P || qty <= 0) return 0; const ts = nowISO(now);
  const bs = pullOrder(st, p, idx ? (idx[p] || []) : Object.entries(st.barcodes).filter(([, B]) => B.p === p && B.s === 'P'));
  let n = 0;
  for (const [b, B] of bs) {
    if (n >= qty) break;
    const L = locByCode(st, B.l), e = L.pids[p];
    L.used--; e.c--; e.r--; B.s = 'O'; B.hoAt = ts; P.C--; P.H++; n++;
    if (e.c <= 0 && e.r <= 0) { delete L.pids[p]; delete P.locs[L.code]; }
    touch(st, 'barcodes', b); touch(st, 'locations', L.code);
  }
  trimReservations(st, p);
  if (n > 0) touch(st, 'pids', p);
  st.log.push([ts, shiftOf(now), '', '', 'handover', '', `${p}:${n}`]);
  return n;
}

// admin override: release everything of one PID sitting in one specific location, regardless
// of the normal hold-back/small-PID-wait rules — a direct "get this out of here" action for
// consolidation, not a handoverSuggestion()-gated one. Only touches that location; the same
// PID's stock elsewhere (if any) is untouched.
export function releaseFromLocation(st, locCode, p, now = new Date(), idx) {
  const P = st.pids[p]; if (!P) return { ok: false, error: 'Unknown PID' };
  const L = locByCode(st, locCode); if (!L) return { ok: false, error: 'Unknown location' };
  const e = L.pids[p]; if (!e || e.c <= 0) return { ok: false, error: 'Nothing placed here for this PID' };
  const qty = e.c, ts = nowISO(now);
  // optional idx (placedByPid(st), grouped by pid) avoids an Object.entries(st.barcodes) scan
  // per call — matters when called in a loop (releaseAllPlaced, below) across many rows
  const source = idx ? (idx[p] || []) : Object.entries(st.barcodes).filter(([, B]) => B.p === p && B.s === 'P');
  const bs = source.filter(([, B]) => B.l === locCode);
  let n = 0;
  for (const [b, B] of bs) {
    if (n >= qty) break;
    B.s = 'O'; B.hoAt = ts; n++;
    touch(st, 'barcodes', b);
  }
  L.used -= n; e.c -= n; e.r -= n; P.C -= n; P.H += n;
  if (e.c <= 0 && e.r <= 0) { delete L.pids[p]; delete P.locs[locCode]; }
  touch(st, 'locations', locCode);
  trimReservations(st, p);
  if (n > 0) touch(st, 'pids', p);
  st.log.push([ts, shiftOf(now), '', '', 'release_location', locCode, `${p}:${n}`]);
  return { ok: true, given: n };
}

// consolidation view: every location -> PID row currently holding real placed stock, with
// each PID's known total (C+R, from the dump), when it first landed in that location, and
// that PID's live handover reasoning (give/why/risk) so "where is it" and "why isn't it
// moving" show up together in one place instead of two separate panels.
export function consolidationView(st) {
  const earliest = {}; // "locCode|pid" -> earliest placed_at
  for (const b in st.barcodes) {
    const B = st.barcodes[b];
    if (B.s !== 'P' || !B.l || !B.ts) continue;
    const key = B.l + '|' + B.p;
    if (!earliest[key] || B.ts < earliest[key]) earliest[key] = B.ts;
  }
  const rows = [];
  for (const L of st.locations) {
    for (const p in L.pids) {
      const e = L.pids[p]; if (e.c <= 0) continue;
      const P = st.pids[p] || { C: 0, R: 0, N: 0, M: 0 };
      const sug = handoverSuggestion(P.C, P.R, (P.N || 0) + (P.M || 0));
      rows.push({
        location: L.code, pid: p, qtyHere: e.c, knownTotal: P.C + P.R, placedAt: earliest[L.code + '|' + p] || null,
        give: sug.give, why: sug.why, risk: !!sug.risk,
      });
    }
  }
  rows.sort((a, b) => a.location.localeCompare(b.location) || a.pid.localeCompare(b.pid));
  const locations = new Set(rows.map(r => r.location)).size;
  const pids = new Set(rows.map(r => r.pid)).size;
  return { rows, locationsActive: locations, pidsOpen: pids };
}

// admin override: release EVERY PID currently placed anywhere, all at once — the bulk form of
// releaseFromLocation(), bypassing the hold-back rule for the whole floor in one action. A full
// consolidation reset, not a data wipe: barcodes move from placed (P) to handed-over (O), the
// same state change a normal handover produces, just for everything and all at once.
export function releaseAllPlaced(st, now = new Date()) {
  const { rows } = consolidationView(st);
  const idx = placedByPid(st); // precompute once — see releaseFromLocation()'s comment
  let totalGiven = 0, locationsReleased = 0, pidsReleased = 0;
  const seenPids = new Set();
  for (const row of rows) {
    const r = releaseFromLocation(st, row.location, row.pid, now, idx);
    if (r.ok && r.given > 0) { totalGiven += r.given; locationsReleased++; seenPids.add(row.pid); }
  }
  pidsReleased = seenPids.size;
  return { ok: true, totalGiven, locationsReleased, pidsReleased };
}

// preview: per-PID plan plus the location lines that will be pulled, without mutating state
export function buildHandover(st, giveMin) {
  const lines = [], plan = [];
  const byPid = placedByPid(st);
  for (const p in st.pids) {
    const P = st.pids[p];
    const sug = handoverSuggestion(P.C, P.R, P.N + (P.M || 0), giveMin);
    plan.push({ pid: p, give: sug.give, keep: sug.keep, why: sug.why, risk: sug.risk, under5: sug.under5 });
    if (sug.give <= 0) continue;
    const bs = pullOrder(st, p, byPid[p] || []);
    const perLoc = {}; let n = 0;
    for (const [, B] of bs) { if (n >= sug.give) break; perLoc[B.l] = (perLoc[B.l] || 0) + 1; n++; }
    for (const loc in perLoc) lines.push({ location: loc, pid: p, qty: perLoc[loc] });
  }
  return { lines, plan };
}
