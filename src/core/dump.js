/* ===== Bermuda Sort Station — PID Hunter dump load & merge (PLAN.md §4) =====
 * A barcode that's already placed/handed-over/set-aside and reappears in a dump is silently
 * reconciled ("already sorted") rather than flagged as a conflict — this is what makes the
 * preload-then-reload recovery flow (preload.js) work without raising thousands of false
 * conflicts for totes PID Hunter still thinks are pending. Its tote-of-record only moves if
 * the old one was a synthetic PRELOAD source or no longer exists, so a barcode already tied
 * to a real tote keeps that tie. After merging, evaluateTotes() auto-closes/flags totes that
 * are now mostly (or partly) already accounted for.
 */
import { parseCSV } from './csv.js';
import { recount } from './state.js';
import { evaluateTotes } from './evaluate.js';
import { refreshRouteR } from './route.js';
import { nowISO } from './shift.js';

const REQ = ['pid', 'barcode', 'status', 'availability', 'tote', 'tote_number', 'partition'];

function validateRows(rows) {
  if (!rows.length) return { ok: false, error: 'File is empty' };
  const hdr = rows[0].map(h => h.trim().toLowerCase());
  const missing = REQ.filter(c => !hdr.includes(c));
  if (missing.length) return { ok: false, error: 'Missing columns: ' + missing.join(', ') };
  return { ok: true };
}

// header-only validation, so a caller can refuse a bad file BEFORE wiping anything
export function checkDump(text) { return validateRows(parseCSV(text)); }

export function loadDump(st, text, fileName, now = new Date()) {
  const rows = parseCSV(text);
  const chk = validateRows(rows);
  if (!chk.ok) return chk;
  const hdr = rows[0].map(h => h.trim().toLowerCase()); const ix = {};
  hdr.forEach((h, i) => ix[h] = i);
  const warn = [];
  const m = /(\d{4})-(\d{2})-(\d{2})/.exec(fileName || '');
  if (m) {
    const fd = `${m[1]}-${m[2]}-${m[3]}`, td = nowISO(now).slice(0, 10);
    if (fd !== td) warn.push(`File date ${fd} is not today (${td}).`);
  }
  const byTote = {}; let noTote = 0, total = 0;
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]; if (row.length < hdr.length - 1) continue; total++;
    const t = (row[ix.tote] || '').trim().toUpperCase();
    if (!t) { noTote++; continue; }
    (byTote[t] || (byTote[t] = [])).push(row);
  }
  const res = {
    ok: true, file: fileName, rows: total, noTote, newTotes: 0, refreshed: 0, skippedTaken: [],
    conflicts: [], foundAgain: 0, missingInDump: [], alreadySorted: 0, autoClosed: [], partial: [], warn,
  };
  const loadId = st.loads.length + 1;
  for (const t in byTote) {
    const T = st.totes[t];
    if (T && T.s === 'M') { res.missingInDump.push(t); continue; } // kept as NOT FOUND until scanned/reinstated
    if (T && T.s !== 'H') { res.skippedTaken.push(t); continue; }
    if (T) { // refresh: drop its still-pending barcodes
      for (const b of T.bs) { const B = st.barcodes[b]; if (B && B.s === 'H' && B.t === t) delete st.barcodes[b]; }
      res.refreshed++;
    } else res.newTotes++;
    const first = byTote[t][0];
    const NT = { n: (first[ix.tote_number] || '').trim(), s: 'H', bs: [], load: loadId };
    for (const row of byTote[t]) {
      const b = (row[ix.barcode] || '').trim().toUpperCase(); if (!b) continue;
      const ex = st.barcodes[b];
      if (ex && (ex.s === 'P' || ex.s === 'O' || ex.s === 'X')) { // already in aisles / handed over / set aside: keep with its tote, don't re-add
        if (ex.t === 'PRELOAD' || !st.totes[ex.t]) { ex.t = t; ex.pt = (row[ix.partition] || '').trim(); }
        res.alreadySorted++; NT.bs.push(b); continue;
      }
      if (ex && ex.s === 'N') res.foundAgain++;
      const pr = st.settings.processableStatus.includes((row[ix.status] || '').trim().toUpperCase())
        && st.settings.processableAvailability.includes((row[ix.availability] || '').trim().toUpperCase());
      st.barcodes[b] = { p: (row[ix.pid] || '').trim(), t, pt: (row[ix.partition] || '').trim(), pr: pr ? 1 : 0, s: 'H' };
      NT.bs.push(b);
    }
    st.totes[t] = NT;
  }
  if (res.skippedTaken.length) st.alerts.push({ ts: nowISO(now), type: 'TAKEN_TOTE_IN_DUMP', msg: `${res.skippedTaken.length} tote(s) already taken are still in the dump (not removed from PID Hunter?): ${res.skippedTaken.slice(0, 20).join(', ')}` });
  recount(st);
  const ev = evaluateTotes(st, now); res.autoClosed = ev.closed; res.partial = ev.partial;
  if (res.alreadySorted) st.alerts.push({ ts: nowISO(now), type: 'ALREADY_SORTED', msg: `${res.alreadySorted} barcodes in ${fileName} are already in the aisles / handed over — not added again. ${ev.closed.length} tote(s) auto-closed, ${ev.partial.length} partly sorted.` });
  st.loads.push({
    id: loadId, file: fileName, at: nowISO(now), rows: total, newTotes: res.newTotes, refreshed: res.refreshed,
    skippedTaken: res.skippedTaken.length, conflicts: res.conflicts.length,
  });
  recount(st);
  refreshRouteR(st);
  return res;
}
