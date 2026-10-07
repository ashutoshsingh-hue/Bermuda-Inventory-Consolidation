/* ===== Bermuda Sort Station — Route (batch) service (owner-requested, not PLAN.md §5) =====
 * Routes are simple rounds of `settings.batchSize` waiting totes (core/routePlanner.js).
 * proposeRoute() is read-only: the next round plus a short preview of the rounds after it.
 * startRoute() checks the totes are still waiting, then activates the batch on live state
 * (st.routeToteIds/st.routeR — ephemeral, never written to the DB itself).
 * completeRoute() releases unused reservations and previews the real (whole-dump) handover —
 * the lead then ticks and releases rows on the Handover tab (release = handed over).
 */
import { planRoutes, waitingTotes, describeTotes, activateRoute, deactivateRoute, buildHandover, shiftOf, nowISO } from '../core/index.js';

export function createRouteService({ app, persist, db, runMutation }) {
  const nextNumber = () => db.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS n FROM route_history').get().n;

  function proposeRoute({ upcoming = 3 } = {}) {
    const st = app.st;
    const size = st.settings.batchSize ?? 50;
    const number = nextNumber();
    const rounds = planRoutes(st, { size, rounds: 1 + Math.max(0, Number(upcoming) || 0) });
    const waiting = waitingTotes(st).length;
    const toteIds = rounds[0] ? rounds[0].toteIds : [];
    return {
      number, size, toteIds, totes: describeTotes(st, toteIds),
      waitingTotes: waiting, roundsLeft: Math.ceil(waiting / size),
      upcoming: rounds.slice(1).map((r, i) => ({ number: number + 1 + i, toteCount: r.toteIds.length, firstTote: st.totes[r.toteIds[0]]?.n ?? r.toteIds[0], lastTote: st.totes[r.toteIds[r.toteIds.length - 1]]?.n ?? r.toteIds[r.toteIds.length - 1] })),
    };
  }

  function getActiveRoute() {
    return persist.getSetting('activeRoute', null);
  }

  function startRoute(toteIds, createdBy) {
    if (getActiveRoute()) return { ok: false, error: 'A route is already active — complete it first' };
    const gone = toteIds.find(t => !app.st.totes[t] || app.st.totes[t].s !== 'H');
    if (gone) return { ok: false, error: `Tote ${gone} is no longer waiting — propose the route again` };

    const now = new Date();
    activateRoute(app.st, toteIds); // ephemeral (routeToteIds/routeR) — nothing here needs a DB write

    const id = nextNumber();
    const createdAt = nowISO(now);
    persist.insertRouteHistory({
      id, status: 'active', created_at: createdAt, started_at: createdAt, created_by: createdBy,
      tote_ids: JSON.stringify(toteIds), projected: JSON.stringify({ toteCount: toteIds.length }),
    });
    const active = { id, number: id, status: 'active', toteIds, createdAt, startedAt: createdAt, createdBy };
    persist.setSetting('activeRoute', active);
    return { ok: true, route: active };
  }

  function completeRoute(actual) {
    const active = getActiveRoute();
    if (!active) return { ok: false, error: 'No active route' };
    const now = new Date();
    let preview;
    runMutation(st => {
      deactivateRoute(st); // release every outstanding (unused) reservation back to what's actually placed
      preview = buildHandover(st, 5); // giveMin=5, whole-dump P.R now that routeR is cleared (PLAN.md §5.3)
      return { result: null, event: { ts: nowISO(now), shift: shiftOf(now), type: 'route_complete', detail: { routeId: active.id } } };
    });
    persist.completeRouteHistory(active.id, nowISO(now), JSON.stringify({ ...(actual || {}), handoverPreview: preview }));
    persist.setSetting('activeRoute', null);
    // the lead releases this from the Handover tab
    return { ok: true, handoverPreview: preview };
  }

  function listHistory(limit = 20) {
    return db.prepare('SELECT * FROM route_history ORDER BY id DESC LIMIT ?').all(limit).map(r => ({
      id: r.id, status: r.status, createdAt: r.created_at, startedAt: r.started_at, completedAt: r.completed_at,
      createdBy: r.created_by, toteIds: JSON.parse(r.tote_ids), projected: JSON.parse(r.projected),
      actual: r.actual ? JSON.parse(r.actual) : null, note: r.note,
    }));
  }

  return { proposeRoute, getActiveRoute, startRoute, completeRoute, listHistory };
}
