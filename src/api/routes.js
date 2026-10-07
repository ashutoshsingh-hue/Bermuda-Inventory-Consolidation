/* ===== Bermuda Sort Station — routes (PLAN.md §9) ===== */
import { requireAuth } from './auth.js';
import { sendError } from './errors.js';

export function registerRoutes(fastify, ctx) {
  const {
    app, persist, authService, stationService, scanService, toteService,
    dumpService, handoverService, exportService, alertsService, statusService, lookupService, settingsService,
    consolidationService, simReportService, routeService, resetService, handoverLogService,
  } = ctx;

  const SYNC_MODES = new Set(['dump', 'auto']);

  const any = requireAuth(authService);
  const leadUp = requireAuth(authService, ['admin', 'lead']);
  const adminOnly = requireAuth(authService, ['admin']);

  // ---------- landing page: nothing was served at "/" itself, which 404'd for anyone
  // who just opened the bare host/port without knowing the /station/ or /admin/ path ----------
  fastify.get('/', async (request, reply) => {
    reply.type('text/html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>Bermuda Sort Station</title>
<style>body{font-family:system-ui,sans-serif;background:#111318;color:#f1f3f4;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;gap:20px;margin:0}
a{background:#1e8e3e;color:#fff;text-decoration:none;padding:16px 32px;border-radius:10px;font-size:1.2rem;font-weight:700}
a.admin{background:#8430ce}</style></head>
<body><h1>Bermuda Sort Station</h1><a href="/station/">Operator — Scan</a><a class="admin" href="/admin/">Lead / Admin</a></body></html>`);
  });

  // ---------- status (public — floor monitors, no auth needed to view) ----------
  fastify.get('/api/status', async () => ({ ok: true, ...statusService.full() }));

  fastify.get('/api/route-progress', async () => ({ ok: true, ...statusService.routeProgress() }));

  // ---------- auth ----------
  fastify.post('/api/login', async (request, reply) => {
    const { station, name, pin } = request.body || {};
    if (!station || !name || !pin) return sendError(reply, 400, 'station, name and pin are required');
    const result = authService.login({ name, pin, stationId: station });
    if (!result) return sendError(reply, 401, 'Wrong name or PIN');
    stationService.ensureStation(station, station);
    stationService.setOperator(station, name);
    return { ok: true, token: result.token, user: result.user, station };
  });

  // ---------- operator: scan / undo / finish / next-tote ----------
  fastify.post('/api/scan', { preHandler: any }, async (request, reply) => {
    const { raw } = request.body || {};
    if (typeof raw !== 'string' || !raw.trim()) return sendError(reply, 400, 'raw is required');
    return { ok: true, ...scanService.scan(request.session.stationId, raw, request.session.role) };
  });

  fastify.post('/api/undo', { preHandler: any }, async (request) => {
    return { ok: true, barcode: scanService.undo(request.session.stationId) };
  });

  fastify.post('/api/tote/finish', { preHandler: any }, async (request, reply) => {
    const result = toteService.finish(request.session.stationId);
    if (!result) return sendError(reply, 400, 'No tote open');
    return { ok: true, ...result };
  });

  fastify.get('/api/next-totes', { preHandler: any }, async (request) => {
    const n = Number(request.query?.n) || 5;
    return { ok: true, ...scanService.nextTotes(request.session.stationId, n) };
  });

  // the tote (if any) this station currently has open, with its number and scan progress —
  // used to restore the "current tote" banner after a page reload, since that's otherwise
  // only ever known from the last scan response
  fastify.get('/api/tote/current', { preHandler: any }, async (request) => ({
    ok: true, current: scanService.currentTote(request.session.stationId),
  }));

  // a waiting tote physically can't be found on the floor — operator-initiated, since they're
  // the one standing at the shelf. Scanning the tote's label later auto-reinstates it either way.
  fastify.post('/api/tote/:id/missing', { preHandler: any }, async (request, reply) => {
    const { reason } = request.body || {};
    const result = toteService.markMissing(request.params.id, reason || '', request.session.name);
    if (!result.ok) return sendError(reply, 400, result.error);
    return result;
  });

  // ---------- lookup (any logged-in role) ----------
  fastify.get('/api/lookup', { preHandler: any }, async (request, reply) => {
    const result = lookupService.lookup(request.query?.q);
    if (!result.ok) return sendError(reply, 404, result.error);
    return result;
  });

  // ---------- data source mode: manual dump upload (current, working) vs. auto-sync
  // (direct PID Hunter connection — not built yet; this is a placeholder toggle so the
  // admin UI can switch to it later without another routes/UI change) ----------
  fastify.get('/api/settings/sync-mode', { preHandler: leadUp }, async () => ({
    ok: true, mode: persist.getSetting('sync_mode', 'dump'),
  }));

  fastify.post('/api/settings/sync-mode', { preHandler: leadUp }, async (request, reply) => {
    const { mode } = request.body || {};
    if (!SYNC_MODES.has(mode)) return sendError(reply, 400, `mode must be one of ${[...SYNC_MODES].join(', ')}`);
    persist.setSetting('sync_mode', mode);
    return { ok: true, mode };
  });

  // ---------- layout settings: aisles/totes/partitions/capacity (admin) —
  // locked once anything is placed, same rule the pilot enforced ----------
  fastify.get('/api/settings/layout', { preHandler: adminOnly }, async () => ({ ok: true, ...settingsService.getLayout() }));

  fastify.post('/api/settings/layout', { preHandler: adminOnly }, async (request, reply) => {
    const result = settingsService.updateLayout(request.body || {});
    if (!result.ok) return reply.code(result.errors ? 400 : 409).send(result);
    return result;
  });

  // ---------- dump upload (admin/lead) ----------
  // mode: merge (default, normal daily merge) | continue (new dump, keep what is in the aisles) |
  // fresh (new dump, start over). continue/fresh remove the current dump + activity after a backup (admin only).
  fastify.post('/api/dump', { preHandler: leadUp }, async (request, reply) => {
    const data = await request.file();
    if (!data) return sendError(reply, 400, 'CSV file is required (multipart field "file")');
    const mode = String(data.fields?.mode?.value || 'merge');
    const text = (await data.toBuffer()).toString('utf8');
    if (mode === 'merge') {
      const result = dumpService.load(text, data.filename);
      if (!result.ok) return sendError(reply, 400, result.error);
      return { ok: true, ...result };
    }
    if (request.session.role !== 'admin') return sendError(reply, 403, 'Only an admin can replace the current dump');
    if (mode !== 'continue' && mode !== 'fresh') return sendError(reply, 400, 'mode must be merge, continue or fresh');
    const result = await resetService.startNewDump(request.session.name, mode, text, data.filename);
    if (!result.ok) return sendError(reply, 400, result.error);
    return result;
  });

  fastify.get('/api/dump/info', { preHandler: leadUp }, async () => resetService.dumpInfo());

  // remove the current dump + activity (backup first): continue = keep the aisles, fresh = everything
  fastify.post('/api/dump/remove', { preHandler: adminOnly }, async (request, reply) => {
    const result = await resetService.removeDump(request.session.name, (request.body || {}).mode);
    if (!result.ok) return sendError(reply, 400, result.error);
    return result;
  });

  fastify.post('/api/backup/restore', { preHandler: adminOnly }, async (request, reply) => {
    const result = await resetService.restoreBackup(request.session.name, (request.body || {}).name);
    if (!result.ok) return sendError(reply, 400, result.error);
    return result;
  });

  fastify.post('/api/import/pilot', { preHandler: adminOnly }, async (request, reply) => {
    const data = await request.file();
    if (!data) return sendError(reply, 400, 'Backup JSON file is required (multipart field "file")');
    const text = (await data.toBuffer()).toString('utf8');
    const result = dumpService.importPilot(text);
    if (!result.ok) return sendError(reply, 400, result.error);
    return result;
  });

  // disaster recovery (PLAN.md §2): upload existing aisle stock BEFORE the main dump
  fastify.post('/api/preload', { preHandler: leadUp }, async (request, reply) => {
    const data = await request.file();
    if (!data) return sendError(reply, 400, 'CSV file is required (multipart field "file")');
    const text = (await data.toBuffer()).toString('utf8');
    const result = dumpService.preload(text, data.filename);
    if (!result.ok) return sendError(reply, 400, result.error);
    return { ok: true, ...result };
  });

  // missing-totes list + explicit reinstate (a normal scan of the tote's label does this too)
  fastify.get('/api/totes/missing', { preHandler: leadUp }, async () => ({ ok: true, totes: toteService.listMissing() }));

  fastify.post('/api/tote/:id/reinstate', { preHandler: leadUp }, async (request, reply) => {
    const result = toteService.reinstate(request.params.id, request.session.name);
    if (!result.ok) return sendError(reply, 400, result.error);
    return result;
  });

  // ---------- handover (lead) ----------
  fastify.post('/api/pid/:pid/release-at-risk', { preHandler: leadUp }, async (request, reply) => {
    const result = handoverService.releaseAtRisk(request.params.pid);
    if (!result.ok) return sendError(reply, 400, result.error);
    return result;
  });

  // ---------- consolidation: per-location PID breakdown + manual release (lead) ----------
  fastify.get('/api/consolidation', { preHandler: leadUp }, async () => ({ ok: true, ...consolidationService.list() }));

  // operators can release too, but only once 30+ is collected at that location
  // (consolidationService.release enforces the threshold for the operator role) —
  // lead/admin remain unrestricted, as before
  fastify.post('/api/consolidation/release', { preHandler: any }, async (request, reply) => {
    const { location, pid } = request.body || {};
    if (!location || !pid) return sendError(reply, 400, 'location and pid are required');
    const result = consolidationService.release(location, pid, request.session.name, request.session.role);
    if (!result.ok) return sendError(reply, 400, result.error);
    return result;
  });

  // handover log: quantity released/processed (lead/admin); ?from=YYYY-MM-DD&to=YYYY-MM-DD
  const isDay = v => typeof v === 'string' && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(v);
  fastify.get('/api/handover/log', { preHandler: leadUp }, async (request, reply) => {
    const { from, to } = request.query || {};
    if ((from && !isDay(from)) || (to && !isDay(to))) return sendError(reply, 400, 'from/to must be YYYY-MM-DD');
    return { ok: true, ...handoverLogService.list({ from, to }) };
  });

  fastify.get('/api/handover/log.csv', { preHandler: leadUp }, async (request, reply) => {
    const { from, to } = request.query || {};
    if ((from && !isDay(from)) || (to && !isDay(to))) return sendError(reply, 400, 'from/to must be YYYY-MM-DD');
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', 'attachment; filename="handoverlog.csv"');
    return exportService.handoverLogCsv({ from, to });
  });

  // lead/admin: release only the rows ticked on the Handover tab, in one transaction
  fastify.post('/api/consolidation/release-many', { preHandler: leadUp }, async (request, reply) => {
    const items = (request.body || {}).items;
    if (!Array.isArray(items) || !items.length) return sendError(reply, 400, 'items (location + pid) are required');
    if (items.some(it => !it || !it.location || !it.pid)) return sendError(reply, 400, 'every item needs location and pid');
    return consolidationService.releaseMany(items, request.session.name);
  });

  // wipe all results/dump data (admin only; takes a backup first)
  fastify.post('/api/admin/clear-all', { preHandler: adminOnly }, async (request) => resetService.clearAll(request.session.name));

  // full reset: release everything, everywhere — admin only, not lead
  fastify.post('/api/consolidation/release-all', { preHandler: adminOnly }, async (request) => {
    return consolidationService.releaseAll(request.session.name);
  });

  // ---------- multi-station report (lead/admin) — per-tote station/operator assignment history,
  // plus any logged cross-station clash attempts, so a multi-station run can be verified live ----------
  fastify.get('/api/sim-report', { preHandler: leadUp }, async () => ({ ok: true, ...simReportService.summary() }));

  // wipes the report's own tote/operator attribution + logged clash attempts (admin only,
  // same bar as the other full-reset actions) — never touches barcode/pid/location state
  fastify.post('/api/sim-report/clear', { preHandler: adminOnly }, async () => simReportService.clearReport());

  // ---------- route planner (lead/admin propose/start/complete; any role reads active) ----------
  fastify.get('/api/route/propose', { preHandler: leadUp }, async (request) => ({ ok: true, route: routeService.proposeRoute(request.query || {}) }));

  fastify.get('/api/route/active', { preHandler: any }, async () => ({ ok: true, active: routeService.getActiveRoute() }));

  fastify.post('/api/route/start', { preHandler: leadUp }, async (request, reply) => {
    const { toteIds } = request.body || {};
    if (!Array.isArray(toteIds) || !toteIds.length) return sendError(reply, 400, 'toteIds (array) is required');
    const result = routeService.startRoute(toteIds, request.session.name);
    if (!result.ok) return reply.code(409).send(result);
    return result;
  });

  fastify.post('/api/route/complete', { preHandler: leadUp }, async (request, reply) => {
    const result = routeService.completeRoute(request.body || {});
    if (!result.ok) return sendError(reply, 400, result.error);
    return result;
  });

  fastify.get('/api/route/history', { preHandler: leadUp }, async (request) => ({ ok: true, routes: routeService.listHistory(Number(request.query?.limit) || 20) }));

  // ---------- stations (admin) ----------
  fastify.get('/api/stations', { preHandler: adminOnly }, async () => ({ ok: true, stations: stationService.list() }));

  fastify.post('/api/stations', { preHandler: adminOnly }, async (request, reply) => {
    const { id, name } = request.body || {};
    if (!id) return sendError(reply, 400, 'id is required');
    try { return { ok: true, station: stationService.add(id, name) }; }
    catch (err) { return sendError(reply, 409, err.message); }
  });

  fastify.patch('/api/stations/:id', { preHandler: adminOnly }, async (request, reply) => {
    const { name, active } = request.body || {};
    let station = null;
    if (name !== undefined) station = stationService.rename(request.params.id, name);
    if (active !== undefined) station = stationService.setActive(request.params.id, active);
    if (!station) return sendError(reply, 404, 'Unknown station');
    return { ok: true, station };
  });

  fastify.post('/api/tote/:id/release', { preHandler: adminOnly }, async (request, reply) => {
    const result = toteService.forceRelease(request.params.id, request.session.name);
    if (!result) return sendError(reply, 400, 'Tote is not open');
    return { ok: true, ...result };
  });

  // ---------- users (admin) — "delete" deactivates: blocks login and kills existing
  // sessions immediately, but never removes the row (past events keep their operator name) ----------
  fastify.get('/api/users', { preHandler: adminOnly }, async () => ({ ok: true, users: authService.listUsers() }));

  fastify.post('/api/users', { preHandler: adminOnly }, async (request, reply) => {
    const { name, role, pin } = request.body || {};
    if (!name || !role || !pin) return sendError(reply, 400, 'name, role and pin are required');
    try { return { ok: true, user: authService.createUser({ name, role, pin }) }; }
    catch (err) { return sendError(reply, 409, err.message); }
  });

  fastify.delete('/api/users/:id', { preHandler: adminOnly }, async (request, reply) => {
    const result = authService.deactivateUser(Number(request.params.id));
    if (!result.ok) return sendError(reply, 409, result.error);
    return result;
  });

  fastify.patch('/api/users/:id', { preHandler: adminOnly }, async (request, reply) => {
    if (request.body?.active !== true) return sendError(reply, 400, 'PATCH only supports {"active": true} (reactivate) — use DELETE to deactivate');
    const result = authService.reactivateUser(Number(request.params.id));
    if (!result.ok) return sendError(reply, 404, result.error);
    return result;
  });

  // ---------- alerts (admin) ----------
  fastify.get('/api/alerts', { preHandler: adminOnly }, async (request) => {
    const unresolvedOnly = request.query?.unresolved === '1' || request.query?.unresolved === 'true';
    return { ok: true, alerts: alertsService.list({ unresolvedOnly }) };
  });

  fastify.post('/api/alerts/:id/resolve', { preHandler: adminOnly }, async (request, reply) => {
    const alert = alertsService.resolve(Number(request.params.id), request.session.name);
    if (!alert) return sendError(reply, 404, 'Unknown alert');
    return { ok: true, alert };
  });

  // ---------- exports (admin) ----------
  const csvRoute = (path, fn, filename) => fastify.get(path, { preHandler: adminOnly }, async (request, reply) => {
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="${filename}"`);
    return fn();
  });
  csvRoute('/api/export/locations.csv', exportService.locationsCsv, 'locations.csv');
  csvRoute('/api/export/notfound.csv', exportService.notFoundCsv, 'notfound.csv');
  csvRoute('/api/export/events.csv', exportService.eventsCsv, 'events.csv');
  csvRoute('/api/export/missingtotes.csv', exportService.missingTotesCsv, 'missingtotes.csv');
  csvRoute('/api/export/aislestock.csv', exportService.aisleStockCsv, 'aislestock.csv');
}
