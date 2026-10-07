/* ===== Bermuda Sort Station — active-route (batch) lifecycle (PLAN.md §6, rev. 03-Oct-2026) =====
 * st.routeToteIds (a Set of tote ids) and st.routeR ({pid: count}) describe the currently
 * active batch, if any. Both are derived, never persisted directly — refreshRouteR() does a
 * full from-scratch rebuild, used at route start / server boot / after a bulk dump reload.
 * During the batch itself, every scan/undo/finishTote/missingTote call instead uses
 * bumpRouteR() to apply the exact +1/-1 this one barcode's H-state transition causes, O(1) —
 * a full rebuild on every single scan would be O(batch size) per scan, i.e. O(batch size^2)
 * per batch (confirmed in practice: minutes, not seconds, on a real ~50-tote/12k-barcode
 * batch). bumpRouteR() can't silently drift because it's computed from the exact same
 * B.s/prev.s transition each call site already has in hand for its own P.R bookkeeping, not a
 * separately-reasoned-about delta.
 */
import { touch } from './state.js';

// full rebuild: processable barcodes still 'H' inside the active route's totes, by pid
export function refreshRouteR(st) {
  if (!st.routeToteIds) return;
  const routeR = {};
  for (const t of st.routeToteIds) {
    const T = st.totes[t]; if (!T) continue;
    for (const b of T.bs) {
      const B = st.barcodes[b];
      if (B && B.pr && B.s === 'H' && B.t === t) routeR[B.p] = (routeR[B.p] || 0) + 1;
    }
  }
  st.routeR = routeR;
}

// incremental O(1) update for one barcode's H-state transition (delta is +1 entering H, -1
// leaving H) — a no-op whenever no route is active or the barcode's tote isn't part of it
export function bumpRouteR(st, toteId, p, delta) {
  if (!st.routeR || !st.routeToteIds || !st.routeToteIds.has(toteId)) return;
  const n = (st.routeR[p] || 0) + delta;
  if (n > 0) st.routeR[p] = n; else delete st.routeR[p];
}

export function activateRoute(st, toteIds) {
  st.routeToteIds = new Set(toteIds);
  refreshRouteR(st);
}

// batch complete: every outstanding (unused) reservation collapses to exactly what's actually
// placed — the next batch computes its own routeR fresh, so nothing here should keep holding
// room reserved on its behalf. Mirrors trimReservations()'s own cleanup, just across every pid
// at once rather than one at a time.
export function deactivateRoute(st) {
  for (const L of st.locations) {
    for (const p in L.pids) {
      const e = L.pids[p];
      if (e.r === e.c) continue; // nothing outstanding here, skip the write
      e.r = e.c;
      touch(st, 'locations', L.code);
      if (e.c === 0 && e.r === 0) {
        delete L.pids[p];
        const P = st.pids[p];
        if (P) { delete P.locs[L.code]; touch(st, 'pids', p); }
      }
    }
  }
  delete st.routeToteIds;
  delete st.routeR;
}
