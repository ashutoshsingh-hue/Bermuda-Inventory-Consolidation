/* ===== Bermuda Sort Station — scan/undo/next-tote for one station (PLAN.md §9) ===== */
import { scan, undoLast, toteProgress, recommend, locByCode, normalize, RELEASE_NUDGE_THRESHOLD } from '../core/index.js';

export function createScanService({ app, runStationAction, persist }) {
  // the tote a station currently has open, with its friendly number and scan progress —
  // shared shape used by scan responses AND by a fresh page load re-syncing after a reload
  function currentTote(sid) {
    const ss = app.st.stations[sid];
    if (!ss || !ss.openTote) return null;
    const T = app.st.totes[ss.openTote];
    const progress = toteProgress(app.st, ss.openTote);
    return progress && { tote: ss.openTote, n: T ? T.n : null, ...progress };
  }

  // Route-membership gate (operational layer above core, not a §5 business rule — core
  // scan() itself is untouched). Lead/admin can always override, same as other floor overrides.
  function blockedByRoute(raw, role) {
    const active = persist.getSetting('activeRoute', null);
    if (!active || active.status !== 'active' || role === 'admin' || role === 'lead') return false;
    const code = normalize(app.st, raw);
    return !!app.st.totes[code] && !active.toteIds.includes(code);
  }

  function doScan(sid, raw, role) {
    if (blockedByRoute(raw, role)) {
      return { type: 'error', msg: 'Tote not in current batch — ask lead', tote_progress: currentTote(sid), readyToRelease: null };
    }
    const result = runStationAction(sid, raw, 'scan', (st, now) => scan(st, sid, raw, now));
    let readyToRelease = null;
    if ((result.type === 'place' || result.type === 'extra') && result.loc && result.pid) {
      const L = locByCode(app.st, result.loc);
      const qtyHere = L?.pids?.[result.pid]?.c || 0;
      if (qtyHere >= RELEASE_NUDGE_THRESHOLD) readyToRelease = { location: result.loc, pid: result.pid, qty: qtyHere };
    }
    // the scanned barcode itself, so the station can show Location / PID / Barcode together
    const barcode = ['place', 'extra', 'dup'].includes(result.type) ? normalize(app.st, raw) : undefined;
    return { ...result, ...(barcode ? { barcode } : {}), tote_progress: currentTote(sid), readyToRelease };
  }

  function undo(sid) {
    return runStationAction(sid, null, 'undo', st => undoLast(st, sid));
  }

  // Each idle station is offered its OWN tote (PLAN.md §6: "N stations are all offered different
  // totes"). Totes already open are excluded by recommend(); on top of that, the tote offered to
  // one station is held back from the others for OFFER_TTL_MS, so two operators standing at
  // empty stations never get told to scan the same tote. A station keeps its offer (sticky) until
  // it opens a tote, the tote is no longer waiting, or the station stops asking.
  const OFFER_TTL_MS = 2 * 60 * 1000;
  const offers = new Map(); // sid -> { tote, at }

  function nextTotes(sid, n = 5) {
    const now = Date.now();
    for (const [s, o] of offers) {
      // expired, no longer waiting, or its station already has a tote in hand (it may have opened a different one)
      if (now - o.at > OFFER_TTL_MS || app.st.totes[o.tote]?.s !== 'H' || app.st.stations[s]?.openTote) offers.delete(s);
    }
    const heldByOthers = [...offers].filter(([s]) => s !== sid).map(([, o]) => o.tote);
    const r = recommend(app.st, { limit: 0, excludeTotes: heldByOthers });
    const mine = offers.get(sid);
    if (mine) { // keep this station's tote on top while it is still a valid candidate
      const i = r.list.findIndex(x => x.tote === mine.tote);
      if (i > 0) r.list.unshift(...r.list.splice(i, 1));
    }
    if (r.list.length && !app.st.stations[sid]?.openTote) offers.set(sid, { tote: r.list[0].tote, at: now });
    return { ...r, list: n ? r.list.slice(0, n) : r.list };
  }

  return { scan: doScan, undo, nextTotes, currentTote };
}
