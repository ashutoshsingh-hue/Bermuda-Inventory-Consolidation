/* ===== Bermuda Sort Station — runMutation: one change = one SQLite transaction (PLAN.md §6) =====
 * `app` is a mutable holder ({ st }) rather than a bare state object so that, on an
 * unexpected exception mid-mutation, we can swap in a fresh reload from the (rolled-back)
 * DB instead of trusting a partially-mutated in-memory state (STRUCTURE.md §4).
 */
import { clearDirty, stationState, normalize, shiftOf, nowISO } from '../core/index.js';
import { loadState } from '../db/load.js';

export function createMutator(db, persist, app) {
  function runMutation(fn) {
    const st = app.st;
    const alertsBefore = st.alerts.length, loadsBefore = st.loads.length;
    const tx = db.transaction(() => {
      const { result, event, events } = fn(st);
      persist.persistDirty(st);
      persist.appendNewAlerts(st, alertsBefore);
      persist.appendNewLoads(st, loadsBefore);
      if (event) persist.appendEvent(event);
      if (events) for (const e of events) persist.appendEvent(e);
      return result;
    });
    try {
      const result = tx();
      clearDirty(st);
      return result;
    } catch (err) {
      clearDirty(st);
      app.st = loadState(db); // resync memory with the rolled-back DB truth
      throw err;
    }
  }

  // convenience for the interactive per-station path (scan/undo/finish): runs coreFn(st, now)
  // and builds the matching events-table row (station/operator/shift/openTote/input/result)
  // around it, so scanService/toteService don't each have to assemble it by hand.
  function runStationAction(sid, raw, type, coreFn) {
    const now = new Date();
    return runMutation(st => {
      const code = raw != null ? normalize(st, raw) : null;
      const r = coreFn(st, now);
      const ss = stationState(st, sid);
      const event = {
        ts: nowISO(now), shift: shiftOf(now), station: sid, operator: ss.operator,
        type, openTote: ss.openTote, inputRaw: raw ?? undefined, barcode: code || undefined,
        result: r && r.type, location: r && r.loc, pid: r && r.pid,
        detail: r && r.msg ? { msg: r.msg } : undefined,
      };
      return { result: r, event };
    });
  }

  return { runMutation, runStationAction };
}
