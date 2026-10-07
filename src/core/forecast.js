/* ===== Bermuda Sort Station — capacity forecast (owner-requested, not a PLAN.md §5 rule) =====
 * Every PID's P.C/P.R already reflects its true dump-wide total the moment its first barcode
 * is scanned — so forecasting isn't a statistical guess about an unknown future, it's a
 * deterministic sum over data the system already has: every PID still active (placed and/or
 * still waiting) needs a certain amount of space; this compares that total need against what's
 * actually available right now. Single shared pool (PLAN.md §5.6, rev. 03-Oct-2026): there's
 * no more dedicated/sharedLarge/sharedSmall split, just planCap (units) and softPidCap (PIDs).
 */
import { planCap } from './state.js';

// how much headroom to leave before warning — 100% means "warn only once genuinely short",
// matching the plain reading of "predict whether we'll run out", not an early buffer
const WARNING_MARGIN = 1.0;

export function capacityForecast(st) {
  const s = st.settings, plan = planCap(s);

  // every PID with anything still active (already placed, and/or still waiting anywhere in
  // the dump) — O/N/X are done and excluded; under-5 PIDs are never placed so excluded too
  const perPid = {};
  for (const b in st.barcodes) {
    const B = st.barcodes[b];
    if (!B.pr) continue;
    if (B.s !== 'H' && B.s !== 'P') continue;
    const e = perPid[B.p] || (perPid[B.p] = { C: 0, R: 0 });
    if (B.s === 'P') e.C++; else e.R++;
  }

  let totalUnits = 0, totalPids = 0;
  for (const p in perPid) {
    const trueTotal = perPid[p].C + perPid[p].R; // whole-dump total — the under-5 rule never changes with a batch
    if (trueTotal < 5) continue;
    // batch-scoped demand while a route is active (PLAN.md §6): only what's still coming in
    // this route's totes, same as assign()'s own reservation — not the whole remaining dump
    const R = st.routeR ? (st.routeR[p] ?? 0) : perPid[p].R;
    totalUnits += perPid[p].C + R;
    totalPids++;
  }
  const locationsNeeded = Math.max(Math.ceil(totalPids / s.softPidCap), Math.ceil(totalUnits / plan));

  // available = every location that isn't already claimed by a pid this forecast didn't count
  // (there shouldn't be any, since every P/H barcode's pid is counted above) — in practice
  // this is just the total location count, but computed from the live location array rather
  // than a settings field so it stays correct after a layout change
  const locationsAvailable = st.locations.length;

  const shortfall = Math.max(0, locationsNeeded - locationsAvailable);
  return {
    locationsNeeded, locationsAvailable, shortfall,
    warning: locationsNeeded > locationsAvailable * WARNING_MARGIN,
    breakdown: { pids: totalPids, units: totalUnits, locations: locationsNeeded },
  };
}
