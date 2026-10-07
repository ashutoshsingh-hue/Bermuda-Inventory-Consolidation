/* ===== Bermuda Sort Station — tote "not found" (physically un-locatable) tracking =====
 * Distinct from a barcode going NOT FOUND at finishTote() (unscanned but the tote itself was
 * found and processed). Here the whole tote can't be located on the floor. Only a waiting
 * tote can be marked missing; its processable barcodes leave R (so no PID waits on them) and
 * go into a separate M count, dropping the tote out of recommend()'s pool. Scanning the tote's
 * label later — or an explicit "mark found" — reinstates it and its barcodes back to R.
 */
import { pid, touch } from './state.js';
import { trimReservations } from './allocate.js';
import { refreshRouteR } from './route.js';
import { nowISO, shiftOf } from './shift.js';

export function markToteMissing(st, t, now = new Date(), reason = '') {
  const T = st.totes[t]; if (!T) return { ok: false, error: 'Unknown tote' };
  if (T.s !== 'H') return { ok: false, error: T.s === 'M' ? 'Already marked missing' : 'Only a waiting tote can be marked missing' };
  const ts = nowISO(now), touched = new Set();
  let bc = 0, proc = 0;
  for (const b of T.bs) {
    const B = st.barcodes[b]; if (!B || B.s !== 'H' || B.t !== t) continue;
    B.s = 'M'; bc++; touch(st, 'barcodes', b);
    if (B.pr) { const P = pid(st, B.p); P.R--; P.M++; proc++; touched.add(B.p); }
  }
  touched.forEach(p => { trimReservations(st, p); touch(st, 'pids', p); });
  refreshRouteR(st);
  T.s = 'M'; T.missingAt = ts; T.missingReason = reason; T.missingCount = (T.missingCount || 0) + 1;
  touch(st, 'totes', t);
  st.alerts.push({ ts, type: 'TOTE_MISSING', msg: `Tote ${T.n} (${t}) marked NOT FOUND — ${bc} barcodes, ${proc} processable, ${touched.size} PIDs affected${reason ? ' — ' + reason : ''}` });
  st.log.push([ts, shiftOf(now), t, t, 'tote_missing', '', String(proc)]);
  return { ok: true, tote: t, n: T.n, barcodes: bc, processable: proc, pids: touched.size };
}

export function reinstateTote(st, t, now = new Date()) {
  const T = st.totes[t]; if (!T || T.s !== 'M') return { ok: false, error: 'Tote is not marked missing' };
  const ts = nowISO(now);
  let proc = 0;
  for (const b of T.bs) {
    const B = st.barcodes[b]; if (!B || B.s !== 'M' || B.t !== t) continue;
    B.s = 'H'; touch(st, 'barcodes', b);
    if (B.pr) { const P = pid(st, B.p); P.M--; P.R++; proc++; touch(st, 'pids', B.p); }
  }
  refreshRouteR(st);
  T.s = 'H'; T.foundAt = ts;
  touch(st, 'totes', t);
  st.alerts.push({ ts, type: 'TOTE_FOUND', msg: `Tote ${T.n} (${t}) found again — ${proc} processable barcodes back in play` });
  st.log.push([ts, shiftOf(now), t, t, 'tote_found', '', String(proc)]);
  return { ok: true, tote: t, n: T.n, processable: proc };
}

export function missingTotes(st) {
  const out = [];
  for (const t in st.totes) {
    const T = st.totes[t]; if (T.s !== 'M') continue;
    let bc = 0, proc = 0; const ps = new Set();
    for (const b of T.bs) { const B = st.barcodes[b]; if (B && B.s === 'M' && B.t === t) { bc++; if (B.pr) { proc++; ps.add(B.p); } } }
    out.push({ tote: t, n: T.n, barcodes: bc, processable: proc, pids: ps.size, at: T.missingAt, reason: T.missingReason || '' });
  }
  return out.sort((a, b) => b.processable - a.processable);
}
