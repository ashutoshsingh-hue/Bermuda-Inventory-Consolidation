/* ===== Bermuda Sort Station — Route planner (owner-requested, not a PLAN.md §5 rule) =====
 * Deliberately simple: the waiting totes, in the SAME order the stations' "UP NEXT" queue uses
 * (recommend(): best consolidation first), are cut into rounds of `settings.batchSize`
 * (default 50). Route 1 is the first round, Route 2 the next, and so on, so a route always
 * matches what the stations would offer. Nothing is simulated — every round is recomputed from
 * the live state, so the queue updates itself as totes get finished. Space safety comes from the real allocator
 * (PLAN.md §5.6, §6.1) at scan time, not from a dry run here.
 */
import { recommend } from './recommend.js';

// every tote still waiting (state 'H'), by tote number (T.n, the dump sequence) then id so the
// queue order is stable across restarts/DB reloads, minus any the caller wants skipped
export function waitingTotes(st, excludeTotes = []) {
  const skip = new Set(excludeTotes);
  const num = t => { const n = Number(st.totes[t].n); return Number.isFinite(n) ? n : Infinity; };
  return Object.keys(st.totes).filter(t => st.totes[t].s === 'H' && !skip.has(t))
    .sort((a, b) => num(a) - num(b) || (a < b ? -1 : a > b ? 1 : 0));
}

// waiting totes in station-queue order (recommend() ranking), ignoring any active route filter
export function rankedTotes(st, excludeTotes = []) {
  const { list } = recommend({ ...st, routeToteIds: null }, { limit: 0, excludeTotes });
  return list.map(x => x.tote);
}

// the next `rounds` rounds of `size` totes each (last round may be shorter): [{ toteIds }]
export function planRoutes(st, { size = st.settings.batchSize ?? 50, rounds = 1, excludeTotes = [] } = {}) {
  const n = Math.max(1, Math.floor(size) || 50);
  const waiting = rankedTotes(st, excludeTotes);
  const out = [];
  for (let i = 0; i < waiting.length && out.length < rounds; i += n) out.push({ toteIds: waiting.slice(i, i + n) });
  return out;
}

// per-tote summary rows for a route's tote list
export function describeTotes(st, toteIds) {
  return toteIds.map(t => {
    const T = st.totes[t];
    let processable = 0;
    if (T) for (const b of T.bs) if (st.barcodes[b]?.pr) processable++;
    return { tote: t, n: T ? T.n : null, barcodes: T ? T.bs.length : 0, processable };
  });
}
