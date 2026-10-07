/* ===== Bermuda Sort Station — tote recommendation (PLAN.md §5.7, tested) =====
 * value of a tote = barcodes that move a PID toward handover:
 *   big PID (T >= 10): every barcode counts (goes at shift end)
 *   small PID (5-9): counts by how much of the PID's remaining this tote completes
 *                     (full credit + already-placed when it finishes the PID)
 *   under-5: 0
 * score = value / (barcodes in tote + TOTE_OVERHEAD)
 */
import { planCap } from './state.js';
import { outstanding } from './allocate.js';

const TOTE_OVERHEAD = 15; // fetching + opening a tote ~= scanning 15 barcodes (~2.5 min)

// opts may be a bare limit (number) or {limit, excludeTotes}
export function recommend(st, opts = 10) {
  const { limit = 10, excludeTotes = [] } = typeof opts === 'number' ? { limit: opts } : opts;
  const exclude = new Set(excludeTotes);
  const s = st.settings, plan = planCap(s); let free = 0;
  for (const L of st.locations) free += Math.max(0, plan - L.used - outstanding(L));
  const out = [];
  for (const t in st.totes) {
    const T = st.totes[t];
    if (T.s !== 'H' || exclude.has(t)) continue; // waiting only: open totes (any station) are already excluded
    if (st.routeToteIds && !st.routeToteIds.has(t)) continue; // a batch is active: only offer its own totes (PLAN.md §6)
    const per = {}; let size = 0, proc = 0;
    for (const b of T.bs) { const B = st.barcodes[b]; if (!B || B.s !== 'H' || B.t !== t) continue; size++; if (B.pr) { proc++; per[B.p] = (per[B.p] || 0) + 1; } }
    if (!size) continue;
    let value = 0, completes = 0, bigBc = 0, newSpace = 0;
    for (const p in per) {
      const P = st.pids[p], k = per[p], tot = P.C + P.R;
      if (tot >= 10) { value += k; bigBc += k; }
      else if (tot >= 5) { if (k >= P.R) { value += k + P.C; completes++; } else value += k * (k / P.R); }
      if (!Object.keys(P.locs).length) newSpace += Math.min(P.R, plan);
    }
    out.push({ tote: t, n: T.n, size, proc, value: Math.round(value), completes, bigBc, score: value / (size + TOTE_OVERHEAD), fits: newSpace <= free });
  }
  out.sort((a, b) => (b.fits - a.fits) || (b.score - a.score) || (b.value - a.value));
  return { list: limit ? out.slice(0, limit) : out, total: out.length, free };
}
