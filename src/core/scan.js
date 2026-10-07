/* ===== Bermuda Sort Station — scanning (PLAN.md §5.4, per-station openTote/lastScan) ===== */
import { pid, locByCode, stationState, touch } from './state.js';
import { assign, trimReservations } from './allocate.js';
import { normalize } from './labels.js';
import { reinstateTote } from './missingTote.js';
import { bumpRouteR } from './route.js';
import { shiftOf, nowISO } from './shift.js';

export function scan(st, sid, raw, now = new Date()) {
  const code = normalize(st, raw); if (!code) return null;
  const ss = stationState(st, sid);
  const sh = shiftOf(now), ts = nowISO(now);
  const out = r => { st.log.push([ts, sh, sid, ss.openTote || '', code, r.type, r.loc || '', r.pid || '']); return r; };

  if (st.totes[code]) {
    const T = st.totes[code];
    if (ss.openTote === code) return out({ type: 'info', msg: `Tote ${T.n} is already open` });
    if (ss.openTote) return out({ type: 'error', msg: `Finish tote ${st.totes[ss.openTote].n} first` });
    if (T.s === 'O') return out({ type: 'error', msg: `Tote open at Station ${T.station}` });
    if (T.s === 'C') return out({ type: 'error', msg: `Tote ${T.n} is already finished` });
    const found = T.s === 'M';
    if (found) reinstateTote(st, code, now); // was marked NOT FOUND — its label being scanned means it's found
    T.s = 'O'; T.openedAt = ts; T.shift = sh; T.station = sid; ss.openTote = code; ss.lastScan = null;
    touch(st, 'totes', code); touch(st, 'stations', sid);
    return out({ type: 'tote', msg: found ? `Tote ${T.n} FOUND — was marked missing` : `Tote ${T.n} open`, tote: code, found });
  }
  touch(st, 'stations', sid);
  if (!ss.openTote) return out({ type: 'error', msg: 'Scan the TOTE first' });
  const B = st.barcodes[code];
  if (!B) {
    st.alerts.push({ ts, type: 'UNKNOWN', msg: `Unknown barcode ${code} scanned in tote ${st.totes[ss.openTote].n}` });
    return out({ type: 'unknown', msg: 'NOT IN DATA — keep aside' });
  }
  if (B.s === 'P' || B.s === 'O' || B.s === 'X') return out({ type: 'dup', msg: 'ALREADY SCANNED', loc: B.l, pid: B.p });
  const extra = B.t !== ss.openTote, prev = { s: B.s, t: B.t };
  if (!B.pr) { B.s = 'X'; B.ts = ts; ss.lastScan = { b: code, prev }; touch(st, 'barcodes', code); return out({ type: 'aside', msg: 'SET ASIDE', pid: B.p }); }
  const P = pid(st, B.p);
  if (B.s === 'H') {
    // Under-5 total (PLAN.md §5.1's own threshold, owner override): a PID whose full known
    // quantity never reaches 5 isn't worth dedicating aisle space to — left aside rather than
    // placed. R-- here too (checked before assign(), same as the normal path below) because
    // recount() doesn't count an 'X' barcode toward R either — leaving R untouched here would
    // make the incrementally-tracked R drift from a fresh recount() by exactly one. undoLast()
    // mirrors this with its own R++ for this specific case.
    if (P.C + P.R < 5) {
      B.s = 'X'; B.ts = ts; P.R--; ss.lastScan = { b: code, prev };
      touch(st, 'barcodes', code); touch(st, 'pids', B.p);
      bumpRouteR(st, B.t, B.p, -1);
      return out({ type: 'aside', msg: 'UNDER 5 TOTAL — LEFT ASIDE', pid: B.p });
    }
    P.R--;
  }
  else if (B.s === 'M') { P.M--; st.alerts.push({ ts, type: 'FOUND_LATER', msg: `${code} (PID ${B.p}) from missing tote ${st.totes[B.t]?.n || B.t}, scanned in tote ${st.totes[ss.openTote].n}` }); }
  else if (B.s === 'N') { P.N--; st.alerts.push({ ts, type: 'FOUND_LATER', msg: `${code} (PID ${B.p}) was not-found, now scanned in tote ${st.totes[ss.openTote].n}` }); }
  const loc = assign(st, B.p);
  if (!loc) {
    if (prev.s === 'H') P.R++; else if (prev.s === 'N') P.N++; else if (prev.s === 'M') P.M++;
    return out({ type: 'error', msg: 'NO SPACE LEFT — call admin', pid: B.p });
  }
  const L = locByCode(st, loc); L.used++; L.pids[B.p].c++; P.C++;
  B.s = 'P'; B.l = loc; B.ts = ts; B.sh = sh; B.st = ss.openTote;
  if (extra) st.alerts.push({ ts, type: 'EXTRA', msg: `${code} (PID ${B.p}) belongs to tote ${B.t}, scanned in ${st.totes[ss.openTote].n}` });
  ss.lastScan = { b: code, prev };
  touch(st, 'barcodes', code); touch(st, 'locations', loc); touch(st, 'pids', B.p);
  if (prev.s === 'H') bumpRouteR(st, B.t, B.p, -1);
  return out({ type: extra ? 'extra' : 'place', loc, pid: B.p });
}

export function undoLast(st, sid) {
  const ss = stationState(st, sid);
  touch(st, 'stations', sid);
  const u = ss.lastScan; if (!u) return null; const B = st.barcodes[u.b]; if (!B) return null;
  if (B.s === 'P') {
    const L = locByCode(st, B.l), P = pid(st, B.p); L.used--; L.pids[B.p].c--; P.C--;
    if (u.prev.s === 'H') P.R++; else if (u.prev.s === 'N') P.N++; else if (u.prev.s === 'M') P.M++; delete B.l;
    touch(st, 'locations', L.code); touch(st, 'pids', B.p);
  } else if (B.s === 'X' && B.pr && u.prev.s === 'H') {
    // this X came from the under-5-total exclusion (a processable barcode that was 'H'
    // before this scan) — that path decremented R since recount() won't count an 'X'
    // barcode toward it either, so undo needs to give it back
    pid(st, B.p).R++; touch(st, 'pids', B.p);
  }
  B.s = u.prev.s; ss.lastScan = null;
  touch(st, 'barcodes', u.b);
  if (B.pr && u.prev.s === 'H') bumpRouteR(st, B.t, B.p, 1);
  st.log.push([nowISO(new Date()), '', sid, ss.openTote || '', u.b, 'undo', '', B.p]);
  return u.b;
}

export function toteProgress(st, t) {
  const T = st.totes[t]; if (!T) return null; let exp = 0, done = 0;
  for (const b of T.bs) { const B = st.barcodes[b]; if (!B) continue; exp++; if (B.s !== 'H' && B.s !== 'N' && B.s !== 'M') done++; }
  return { exp, done };
}

// admin recovery for a station that crashed with a tote open (PLAN.md §6 "Tote lock")
export function forceReleaseTote(st, toteId, now = new Date()) {
  const T = st.totes[toteId]; if (!T || T.s !== 'O') return null;
  for (const sid in st.stations) {
    const ss = st.stations[sid];
    if (ss.openTote === toteId) { ss.openTote = null; ss.lastScan = null; touch(st, 'stations', sid); break; }
  }
  T.s = 'H'; T.station = undefined; T.openedAt = undefined; T.shift = undefined;
  touch(st, 'totes', toteId);
  st.log.push([nowISO(now), '', '', toteId, 'release', '', '']);
  return { tote: toteId, n: T.n };
}

export function finishTote(st, sid, now = new Date()) {
  const ss = stationState(st, sid);
  const t = ss.openTote; if (!t) return null;
  const T = st.totes[t], ts = nowISO(now), nf = [], touched = new Set();
  const routeDrop = {};
  for (const b of T.bs) {
    const B = st.barcodes[b]; if (!B || B.s !== 'H' || B.t !== t) continue;
    B.s = 'N'; B.nfAt = ts; touch(st, 'barcodes', b);
    if (B.pr) { const P = pid(st, B.p); P.R--; P.N++; touched.add(B.p); nf.push([b, B.p, T.n, B.pt]); routeDrop[B.p] = (routeDrop[B.p] || 0) + 1; }
  }
  touched.forEach(p => { trimReservations(st, p); touch(st, 'pids', p); });
  for (const p in routeDrop) bumpRouteR(st, t, p, -routeDrop[p]);
  T.s = 'C'; T.closedAt = ts; ss.openTote = null; ss.lastScan = null;
  touch(st, 'totes', t); touch(st, 'stations', sid);
  st.log.push([ts, shiftOf(now), sid, t, '', 'finish', '', String(nf.length)]);
  return { tote: t, n: T.n, notFound: nf };
}
