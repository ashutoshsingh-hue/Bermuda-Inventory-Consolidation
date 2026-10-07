/* ===== Bermuda Sort Station — location assignment (PLAN.md §5.6, tested pilot logic) ===== */
import { planCap, pid, locByCode } from './state.js';

export function outstanding(L) {
  let o = 0; for (const p in L.pids) { const e = L.pids[p]; o += Math.max(0, e.r - e.c); } return o;
}
export const activePids = L => Object.keys(L.pids).length;

// Size-class separation (dedicated/sharedLarge/sharedSmall) was removed 03-Oct-2026,
// owner-approved (PLAN.md §5.6, rev. 03-Oct-2026): on the 60-tote rack, any PIDs may share a
// partition together, limited only by planCap (physical units) and softPidCap (PID count).
// §5.1's Big/Small/Under-5 handover categories are untouched — this was always a separate,
// purely space-allocation concern, not a business rule.

export function assign(st, p) {
  const s = st.settings, plan = planCap(s), P = pid(st, p);
  // batch-scoped reservation: while a route is active, reserve only for what this PID still
  // has waiting inside the active route's totes (st.routeR), never the whole remaining dump
  // (PLAN.md §6 "Batch operation") — falls back to the PID's whole-dump R with no active route.
  const remaining = st.routeR ? (st.routeR[p] ?? 0) : P.R;
  // +1: R was already decremented for the very barcode being placed right now (scan.js does
  // that before calling assign()), so C+R alone undercounts the true total by one.
  const need = Math.min(remaining + 1, plan);

  // 1) existing home with outstanding reservation and physical room
  for (const code in P.locs) {
    const L = locByCode(st, code), e = L.pids[p];
    if (e && e.c < e.r && L.used < s.cap) return code;
  }
  // 2) existing home with physical room (PID got more than planned)
  for (const code in P.locs) {
    const L = locByCode(st, code), e = L.pids[p];
    if (e && L.used + outstanding(L) < plan) { e.r = e.c + 1; return code; }
  }
  // 3) new location, best-fit: the free space closest to what's still needed, among locations
  // already active (warm). Cold (fully untouched) locations are excluded from this comparison
  // — every cold location ties at the same free space (the full plan cap), so a strict
  // best-fit would always resolve that tie the same way (array order) and pile unrelated PIDs
  // onto whichever location happened to go first before ever touching the rest.
  let L = null, r = need;
  let best = null, bestFree = 1e9;
  for (const Loc of st.locations) {
    if (activePids(Loc) >= s.softPidCap) continue;
    if (Loc.used === 0 && activePids(Loc) === 0) continue; // cold — handled below instead
    const free = plan - Loc.used - outstanding(Loc);
    if (free >= need && free < bestFree) { best = Loc; bestFree = free; }
  }
  L = best;
  if (!L) { const c = pickColdLocation(st); if (c) { L = c; r = need; } }
  if (!L) {
    // no warm fit and no fresh location left anywhere — last resort before NO SPACE: whichever
    // location has the most free space, as long as at least min(need, 5) of it fits. A partial
    // reservation is still better than NO SPACE.
    let any = null, anyFree = 0;
    for (const Loc of st.locations) {
      if (activePids(Loc) >= s.softPidCap) continue;
      const free = plan - Loc.used - outstanding(Loc);
      if (free > anyFree) { any = Loc; anyFree = free; }
    }
    if (any && anyFree >= Math.min(need, 5)) { L = any; r = anyFree; }
  }
  if (!L) return null; // no location anywhere — the rack's hard cap, not overflow
  // reuse the existing counter (only raising its reservation) instead of resetting it, in case
  // this exact pid already partially occupies the location the search above landed on —
  // overwriting L.pids[p] here would silently lose whatever was already placed there (c) while
  // the pid's own P.C keeps counting it.
  const existing = L.pids[p];
  if (existing) existing.r = Math.max(existing.r, existing.c, r);
  else { L.pids[p] = { c: 0, r }; P.locs[L.code] = 1; }
  return L.code;
}

// rotates through never-touched locations so successive brand-new PIDs spread across
// different empty locations instead of collapsing onto the same one. Every caller's need is
// <= plan (a cold location's full free space), so any cold location found always fits.
function pickColdLocation(st) {
  const n = st.locations.length;
  if (!Number.isInteger(st._coldCursor)) st._coldCursor = 0;
  for (let i = 0; i < n; i++) {
    const idx = (st._coldCursor + i) % n;
    const L = st.locations[idx];
    if (L.used !== 0 || activePids(L) !== 0) continue;
    st._coldCursor = (idx + 1) % n;
    return L;
  }
  return null;
}

// shrink reservations so a PID never holds more outstanding space than it can still receive —
// batch-scoped (st.routeR) while a route is active, same as assign()'s own need calculation
export function trimReservations(st, p) {
  const P = st.pids[p]; if (!P) return;
  let allow = st.routeR ? (st.routeR[p] ?? 0) : P.R;
  const codes = Object.keys(P.locs);
  for (const code of codes) {
    const L = locByCode(st, code), e = L.pids[p]; if (!e) { delete P.locs[code]; continue; }
    const o = Math.max(0, e.r - e.c), keep = Math.min(o, allow); allow -= keep; e.r = e.c + keep;
    if (e.c === 0 && e.r === 0) { delete L.pids[p]; delete P.locs[code]; }
  }
}
