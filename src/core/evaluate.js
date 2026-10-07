/* ===== Bermuda Sort Station — tote closure from what's already in the aisles =====
 * A waiting tote whose barcodes are mostly already placed/handed-over/set-aside was worked
 * before (e.g. after a preloadStock() recovery, or a dump reload): if the already-accounted
 * share is >= settings.autoCloseSharePct, the tote is CLOSED and its few remaining barcodes
 * go NOT FOUND, same as a manual finish. Below that but still partly done, it's left waiting
 * as "partly sorted" so the operator rescans it (already-placed barcodes show ALREADY SCANNED).
 * Called after loadDump() and preloadStock() — never on its own from a scan.
 */
import { pid, touch } from './state.js';
import { trimReservations } from './allocate.js';
import { nowISO } from './shift.js';

export function evaluateTotes(st, now = new Date()) {
  const thr = st.settings.autoCloseSharePct ?? 90, ts = nowISO(now);
  const closed = [], partial = [], touched = new Set();
  for (const t in st.totes) {
    const T = st.totes[t]; if (T.s !== 'H') continue;
    let n = 0, done = 0;
    for (const b of T.bs) { const B = st.barcodes[b]; if (!B) continue; n++; if (B.s === 'P' || B.s === 'O' || B.s === 'X') done++; }
    if (!done || !n) continue;
    const share = Math.round(done / n * 100);
    if (share >= thr) {
      let nf = 0;
      for (const b of T.bs) {
        const B = st.barcodes[b]; if (!B || B.s !== 'H' || B.t !== t) continue;
        B.s = 'N'; B.nfAt = ts; nf++; touch(st, 'barcodes', b);
        if (B.pr) { const P = pid(st, B.p); P.R--; P.N++; touched.add(B.p); }
      }
      T.s = 'C'; T.closedAt = ts; T.autoClosed = 1; touch(st, 'totes', t);
      closed.push({ tote: t, n: T.n, share, sorted: done, notFound: nf });
    } else if (share >= 10) {
      partial.push({ tote: t, n: T.n, share, sorted: done, left: n - done }); // <10% = a stray barcode, treat as a normal waiting tote
    }
  }
  touched.forEach(p => { trimReservations(st, p); touch(st, 'pids', p); });
  if (closed.length) st.alerts.push({ ts, type: 'TOTE_AUTO_CLOSED', msg: `${closed.length} tote(s) auto-closed (>=${thr}% already in aisles): ${closed.slice(0, 15).map(c => `${c.n} (${c.share}%, ${c.notFound} not found)`).join(', ')}` });
  if (partial.length) st.alerts.push({ ts, type: 'TOTE_PARTLY_SORTED', msg: `${partial.length} tote(s) partly sorted — rescan them: ${partial.slice(0, 15).map(c => `${c.n} (${c.share}%)`).join(', ')}` });
  return { closed, partial };
}
