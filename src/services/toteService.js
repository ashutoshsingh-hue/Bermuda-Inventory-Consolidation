/* ===== Bermuda Sort Station — finish tote / not-found tracking / admin force-release ===== */
import { finishTote, forceReleaseTote, markToteMissing, reinstateTote, missingTotes, nowISO } from '../core/index.js';

export function createToteService({ app, runStationAction, runMutation }) {
  function finish(sid) {
    return runStationAction(sid, null, 'finish', (st, now) => finishTote(st, sid, now));
  }

  function forceRelease(toteId, adminName) {
    const now = new Date();
    return runMutation(st => {
      const r = forceReleaseTote(st, toteId, now);
      const event = r ? { ts: nowISO(now), type: 'release', operator: adminName, detail: { toteId } } : null;
      return { result: r, event };
    });
  }

  // operator reports a waiting tote can't be located on the floor
  function markMissing(toteId, reason, operatorName) {
    const now = new Date();
    return runMutation(st => {
      const r = markToteMissing(st, toteId, now, reason);
      const event = r.ok ? { ts: nowISO(now), type: 'tote_missing', operator: operatorName, detail: { toteId, reason } } : null;
      return { result: r, event };
    });
  }

  // admin marks a tote found again without a physical rescan (a normal scan of its label
  // does this automatically too — see core/scan.js)
  function reinstate(toteId, operatorName) {
    const now = new Date();
    return runMutation(st => {
      const r = reinstateTote(st, toteId, now);
      const event = r.ok ? { ts: nowISO(now), type: 'tote_found', operator: operatorName, detail: { toteId } } : null;
      return { result: r, event };
    });
  }

  function listMissing() {
    return missingTotes(app.st);
  }

  return { finish, forceRelease, markMissing, reinstate, listMissing };
}
