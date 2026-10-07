/* ===== Bermuda Sort Station — admin recount check (PLAN.md §8) =====
 * Rebuilds R/C/H/N from barcodes (the source of truth) and reports any pid whose cached
 * counts had drifted. recount() is idempotent and self-healing: calling it always leaves
 * st.pids correct, so the caller just needs to persist the pids this reports as changed.
 */
import { recount } from '../core/index.js';

export function recountCheck(st) {
  const before = {};
  for (const p in st.pids) before[p] = { R: st.pids[p].R, C: st.pids[p].C, H: st.pids[p].H, N: st.pids[p].N };
  recount(st);
  const diffs = [];
  for (const p of new Set([...Object.keys(before), ...Object.keys(st.pids)])) {
    const b = before[p] || { R: 0, C: 0, H: 0, N: 0 }, a = st.pids[p];
    if (b.R !== a.R || b.C !== a.C || b.H !== a.H || b.N !== a.N) diffs.push({ pid: p, before: b, after: { R: a.R, C: a.C, H: a.H, N: a.N } });
  }
  return { ok: diffs.length === 0, diffs };
}
