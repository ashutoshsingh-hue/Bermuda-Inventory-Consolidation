/* ===== Bermuda Sort Station — consolidation view: per-location PID breakdown + manual release ===== */
import { consolidationView, releaseFromLocation, releaseAllPlaced, placedByPid, nowISO, shiftOf, RELEASE_NUDGE_THRESHOLD, locByCode } from '../core/index.js';

export function createConsolidationService({ app, runMutation }) {
  function list() {
    const view = consolidationView(app.st);
    const now = Date.now();
    const rows = view.rows.map(r => ({
      ...r,
      ageMinutes: r.placedAt ? Math.max(0, Math.round((now - Date.parse(r.placedAt.replace(' ', 'T'))) / 60000)) : null,
    }));
    return { locationsActive: view.locationsActive, pidsOpen: view.pidsOpen, rows };
  }

  // role: operators may release too, but only once RELEASE_NUDGE_THRESHOLD+ is collected at
  // that location — the owner's "give the operator a release button, but only worth it once
  // there's a real batch" rule. Lead/admin stay unrestricted, as before.
  function release(location, pid, actorName, role) {
    const now = new Date();
    if (role === 'operator') {
      const L = locByCode(app.st, location);
      const qtyHere = L?.pids?.[pid]?.c || 0;
      if (qtyHere < RELEASE_NUDGE_THRESHOLD) {
        return { ok: false, error: `Operators can only release once ${RELEASE_NUDGE_THRESHOLD}+ units are collected (currently ${qtyHere})` };
      }
    }
    return runMutation(st => {
      const r = releaseFromLocation(st, location, pid, now);
      const event = r.ok
        ? { ts: nowISO(now), shift: shiftOf(now), type: 'release_location', operator: actorName, pid, location, detail: { given: r.given } }
        : null;
      return { result: r, event };
    });
  }

  // lead/admin: release exactly the ticked location+PID rows, all in one transaction
  function releaseMany(items, actorName) {
    const now = new Date();
    return runMutation(st => {
      const idx = placedByPid(st);
      const done = [], failed = [];
      let totalGiven = 0;
      for (const it of items) {
        const r = releaseFromLocation(st, it.location, it.pid, now, idx);
        if (r.ok) { totalGiven += r.given; done.push({ location: it.location, pid: it.pid, given: r.given }); }
        else failed.push({ location: it.location, pid: it.pid, error: r.error });
      }
      // one events row per released location+PID, so the handover log shows exactly what quantity left where
      const batch = nowISO(now);
      const events = done.map(d => ({ ts: batch, shift: shiftOf(now), type: 'release_location', operator: actorName, pid: d.pid, location: d.location, detail: { given: d.given, batch } }));
      return { result: { ok: true, totalGiven, done, failed }, events };
    });
  }

  // admin-only bulk reset: releases everything sitting in every location, in one transaction
  function releaseAll(adminName) {
    const now = new Date();
    return runMutation(st => {
      const r = releaseAllPlaced(st, now);
      const event = { ts: nowISO(now), shift: shiftOf(now), type: 'release_all', operator: adminName, detail: r };
      return { result: r, event };
    });
  }

  return { list, release, releaseMany, releaseAll };
}
