/* ===== Bermuda Sort Station — start a new dump, keeping only what is in the aisles (owner-requested) =====
 * "Continue" mode of the dump lifecycle. Everything that belongs to the OLD dump and its activity
 * (waiting/open/closed totes, handed-over, not-found, set-aside barcodes, loads, alerts, log) is
 * dropped; what is physically in the aisles (state 'P', with its location) is kept, re-tied to the
 * synthetic 'PRELOAD' tote exactly like preload.js does. The next loadDump() then reconciles those
 * barcodes as "already sorted" and counts them as collected (C) against each PID's new total —
 * and only those. If the aisles are empty nothing is carried over, so the new dump is not reduced.
 * Pure: no db/http/fs. The caller persists with persistFullSync().
 */
import { recount, pid } from './state.js';

export function keepAisleStockOnly(st) {
  const kept = {}; let droppedBarcodes = 0;
  for (const b in st.barcodes) {
    const B = st.barcodes[b];
    if (B.s === 'P' && B.l) kept[b] = { ...B, t: 'PRELOAD', pt: '' };
    else droppedBarcodes++;
  }
  const droppedTotes = Object.keys(st.totes).length;
  st.barcodes = kept; st.totes = {}; st.pids = {};
  st.loads = []; st.log = []; st.alerts = [];
  for (const sid in st.stations) { st.stations[sid].openTote = null; st.stations[sid].lastScan = null; }
  delete st.routeToteIds; delete st.routeR;

  for (const L of st.locations) { L.used = 0; L.pids = {}; }
  const byCode = Object.fromEntries(st.locations.map(L => [L.code, L]));
  let keptBarcodes = 0;
  for (const b in kept) {
    const B = kept[b], L = byCode[B.l];
    if (!L) { delete kept[b]; droppedBarcodes++; continue; } // location no longer exists in this layout
    const e = L.pids[B.p] || (L.pids[B.p] = { c: 0, r: 0 });
    e.c++; e.r++; L.used++; pid(st, B.p).locs[L.code] = 1; keptBarcodes++;
  }
  recount(st);
  return { keptBarcodes, keptPids: Object.keys(st.pids).length, droppedBarcodes, droppedTotes };
}
