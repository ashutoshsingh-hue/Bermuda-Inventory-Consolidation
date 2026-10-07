/* ===== Bermuda Sort Station — preload existing aisle stock (disaster recovery, PLAN.md §2) =====
 * Upload BEFORE the day's main dump, when the server's own data is lost but the physical
 * aisles still hold real inventory: a CSV of what's already placed (location + pid + barcode
 * is the accurate form; location + pid + qty works but then totes can't be matched to it).
 * Creates synthetic PRELOAD-sourced barcodes in state 'P' so counts, capacity and handover all
 * see them as already there — then loadDump()'s "already sorted" reconciliation and
 * evaluateTotes()'s auto-close take it from there once the main dump lands on top of it.
 * Uploading again replaces the earlier preload (only the parts still sitting in the aisles).
 *
 * Full migration (new site): with a barcode column the file may also carry optional columns
 *   state (P placed = default | O handed over | X set aside | N not found | C tote done), at (timestamp),
 *   processable (1/0), tote_number. A C row (tote only) recreates a finished tote, so the dump skips it as usual.
 * O, X and N rows restore those barcodes WITHOUT touching rack space, so when the dump lands on top
 * (loadDump treats P/O/X as "already sorted") nothing handed over is offered or placed again.
 * O/X rows are additive and idempotent: a barcode already O/X is counted as a duplicate, not an error.
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
  let handedOver = 0, setAside = 0, notFound = 0, totesDone = 0, dupes = 0;

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
    const stRaw = byBarcode && ('state' in ix) ? (row[ix.state] || '').trim().toUpperCase() : '';
    if (stRaw === 'C') { // finished tote: later dumps skip it ("taken tote"), exactly as on the old site
      const t = ('tote' in ix) ? (row[ix.tote] || '').trim().toUpperCase() : '';
      if (!t) { bad.push(`row ${r + 1}: C row needs a tote`); continue; }
      const at = ('at' in ix) ? (row[ix.at] || '').trim() : '';
      const num = ('tote_number' in ix) ? (row[ix.tote_number] || '').trim() : '';
      const T = st.totes[t];
      if (T) { if (T.s === 'C') { dupes++; continue; } bad.push(`row ${r + 1}: tote ${t} is already ${T.s} here, not marked done`); continue; }
      st.totes[t] = { n: num, s: 'C', bs: [], load: 0, closedAt: at || ts };
      touch(st, 'totes', t); totesDone++;
      continue;
    }
    if (!loc && !p) continue;
    if (stRaw && stRaw !== 'P') {
      if (stRaw !== 'O' && stRaw !== 'X' && stRaw !== 'N') { bad.push(`row ${r + 1}: unknown state "${stRaw}" for ${bc}`); continue; }
      if (!bc || !p) { bad.push(`row ${r + 1}: ${stRaw} row needs pid and barcode`); continue; }
      const ex = st.barcodes[bc];
      if (ex && (ex.s === 'O' || ex.s === 'X' || ex.s === 'N')) { dupes++; continue; }
      if (ex && ex.s === 'P') { bad.push(`row ${r + 1}: ${bc} is ${stRaw} in the file but placed at ${ex.l}`); continue; }
      const src = ('tote' in ix) ? (row[ix.tote] || '').trim().toUpperCase() : '';
      const at = ('at' in ix) ? (row[ix.at] || '').trim() : '';
      const pr = ('processable' in ix) ? (row[ix.processable] || '').trim() !== '0' : true;
      const base = ex || { t: src || 'PRELOAD', pt: '', pr: pr ? 1 : 0 };
      if (stRaw === 'O') { Object.assign(base, { p, s: 'O', hoAt: at || ts, st: 'PRELOAD' }); if (LOC_RE.test(loc)) base.l = loc; handedOver++; }
      else if (stRaw === 'X') { Object.assign(base, { p, s: 'X', ts: at || ts, st: 'PRELOAD' }); setAside++; }
      else { Object.assign(base, { p, s: 'N', nfAt: at || ts, st: 'PRELOAD' }); notFound++; }
      st.barcodes[bc] = base; pid(st, p);
      if (!ex && st.totes[base.t] && !st.totes[base.t].bs.includes(bc)) st.totes[base.t].bs.push(bc);
      touch(st, 'barcodes', bc);
      pids.add(p);
      continue;
    }
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
  st.alerts.push({ ts, type: 'PRELOAD', msg: `Existing aisle stock loaded from ${fileName}: ${added} barcodes, ${pids.size} PIDs, ${locs.size} locations${handedOver ? `, ${handedOver} handed over` : ''}${setAside ? `, ${setAside} set aside` : ''}${notFound ? `, ${notFound} not found` : ''}${totesDone ? `, ${totesDone} done totes` : ''}${removed ? ` (replaced earlier preload of ${removed})` : ''}` });
  st.log.push([ts, shiftOf(now), '', '', 'preload', '', String(added + handedOver + setAside)]);
  return { ok: true, added, handedOver, setAside, notFound, totesDone, dupes, lines, pids: pids.size, locs: locs.size, removed, bad, over: [...new Set(over)], byBarcode, autoClosed: ev.closed, partial: ev.partial };
}
