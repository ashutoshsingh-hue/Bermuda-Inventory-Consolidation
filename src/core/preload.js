/* ===== Bermuda Sort Station — preload existing aisle stock (disaster recovery, PLAN.md §2) =====
 * Upload BEFORE the day's main dump, when the server's own data is lost but the physical
 * aisles still hold real inventory: a CSV of what's already placed (location + pid + barcode
 * is the accurate form; location + pid + qty works but then totes can't be matched to it).
 * Creates synthetic PRELOAD-sourced barcodes in state 'P' so counts, capacity and handover all
 * see them as already there — then loadDump()'s "already sorted" reconciliation and
 * evaluateTotes()'s auto-close take it from there once the main dump lands on top of it.
 * Uploading again replaces the earlier preload (only the parts still sitting in the aisles).
 */
import { parseCSV } from './csv.js';
import { pid, locByCode, recount, touch } from './state.js';
import { evaluateTotes } from './evaluate.js';
import { shiftOf, nowISO } from './shift.js';

const LOC_RE = /^A\d+-T\d+-P\d+$/;

export function preloadStock(st, text, fileName, now = new Date()) {
  const rows = parseCSV(text); if (rows.length < 2) return { ok: false, error: 'File is empty' };
  const hdr = rows[0].map(h => h.trim().toLowerCase()), ix = {}; hdr.forEach((h, i) => ix[h] = i);
  const qc = ['qty', 'pull_qty', 'placed', 'quantity', 'count'].find(c => c in ix), byBarcode = 'barcode' in ix;
  if (!('location' in ix) || !('pid' in ix) || (!qc && !byBarcode)) return { ok: false, error: 'Need columns: location, pid and barcode (best) or qty' };
  const s = st.settings, ts = nowISO(now), bad = [], over = [];

  // replace any earlier preload that is still sitting in the aisles
  let removed = 0;
  for (const b in st.barcodes) {
    const B = st.barcodes[b]; if (!(B.pre || B.t === 'PRELOAD') || B.s !== 'P') continue;
    const L = locByCode(st, B.l), e = L.pids[B.p];
    L.used--; if (e) { e.c--; e.r--; if (e.c <= 0 && e.r <= 0) { delete L.pids[B.p]; delete pid(st, B.p).locs[L.code]; } }
    touch(st, 'locations', L.code);
    if (st.totes[B.t]) { B.s = 'H'; delete B.l; delete B.pre; } else delete st.barcodes[b];
    touch(st, 'barcodes', b);
    removed++;
  }

  let added = 0, lines = 0; const pids = new Set(), locs = new Set();
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]; const loc = (row[ix.location] || '').trim().toUpperCase(), p = (row[ix.pid] || '').trim();
    const bc = byBarcode ? (row[ix.barcode] || '').trim().toUpperCase() : '', q = byBarcode ? (bc ? 1 : 0) : parseInt(row[ix[qc]], 10);
    if (!loc && !p) continue;
    const L = LOC_RE.test(loc) ? locByCode(st, loc) : null;
    if (!L || !p || !(q > 0)) { bad.push(`row ${r + 1}: ${loc || '?'} / ${p || '?'} / ${row[ix[qc]] || '?'}`); continue; }
    const P = pid(st, p), e = L.pids[p] || (L.pids[p] = { c: 0, r: 0 }); P.locs[L.code] = 1;
    if (byBarcode) {
      const ex = st.barcodes[bc];
      if (ex && (ex.s === 'P' || ex.s === 'O')) { bad.push(`row ${r + 1}: ${bc} already ${ex.s === 'P' ? 'at ' + ex.l : 'handed over'}`); continue; }
      const src = ('tote' in ix) ? (row[ix.tote] || '').trim().toUpperCase() : '';
      st.barcodes[bc] = Object.assign(ex || { t: src || 'PRELOAD', pt: '', pr: 1 }, { p, s: 'P', l: L.code, ts, sh: shiftOf(now), st: 'PRELOAD', pre: 1 });
      e.c++; e.r++; L.used++; added++; lines++; pids.add(p); locs.add(L.code);
      touch(st, 'barcodes', bc); touch(st, 'locations', L.code);
      if (L.used > s.cap) over.push(`${L.code} now holds ${L.used} (> ${s.cap})`);
      continue;
    }
    for (let i = 0; i < q; i++) {
      let id; do { id = `PRELOAD-${L.code}-${p}-${++st._pre || (st._pre = 1)}`; } while (st.barcodes[id]);
      st.barcodes[id] = { p, t: 'PRELOAD', pt: '', pr: 1, s: 'P', l: L.code, ts, sh: shiftOf(now), st: 'PRELOAD' };
      touch(st, 'barcodes', id);
    }
    e.c += q; e.r += q; L.used += q; added += q; lines++; pids.add(p); locs.add(L.code);
    touch(st, 'locations', L.code);
    if (L.used > s.cap) over.push(`${L.code} now holds ${L.used} (> ${s.cap})`);
  }
  recount(st);
  const ev = evaluateTotes(st, now);
  st.alerts.push({ ts, type: 'PRELOAD', msg: `Existing aisle stock loaded from ${fileName}: ${added} barcodes, ${pids.size} PIDs, ${locs.size} locations${removed ? ` (replaced earlier preload of ${removed})` : ''}` });
  st.log.push([ts, shiftOf(now), '', '', 'preload', '', String(added)]);
  return { ok: true, added, lines, pids: pids.size, locs: locs.size, removed, bad, over: [...new Set(over)], byBarcode, autoClosed: ev.closed, partial: ev.partial };
}
