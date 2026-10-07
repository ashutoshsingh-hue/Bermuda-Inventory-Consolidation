import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recount } from '../../src/core/index.js';
import { makeTestServer, seedUser, loginStation, authHeader } from '../helpers/testServer.js';

async function makeAdmin(ctx, station = 'ADMIN1') {
  const user = seedUser(ctx, { role: 'admin', pin: '9999' });
  return loginStation(ctx, station, user);
}
async function makeLead(ctx, station = 'LEAD1') {
  const user = seedUser(ctx, { role: 'lead', pin: '8888' });
  return loginStation(ctx, station, user);
}
async function makeOperator(ctx, station = 'OP1') {
  const user = seedUser(ctx, { role: 'operator', pin: '1111' });
  return loginStation(ctx, station, user);
}

function addTote(ctx, toteId, toteNum, p, count) {
  ctx.app.st.totes[toteId] = { n: toteNum, s: 'H', bs: [] };
  for (let i = 0; i < count; i++) {
    const b = `${toteId}-B${i}`;
    ctx.app.st.barcodes[b] = { p, t: toteId, pt: '1', pr: 1, s: 'H' };
    ctx.app.st.totes[toteId].bs.push(b);
  }
}

test('GET /api/route/propose and POST /api/route/start — operator denied, lead/admin allowed', async () => {
  const ctx = makeTestServer();
  const admin = await makeAdmin(ctx);
  const op = await makeOperator(ctx);
  addTote(ctx, 'T1', '1', 'PA', 5);
  recount(ctx.app.st);

  const deniedPropose = await ctx.fastify.inject({ method: 'GET', url: '/api/route/propose', headers: authHeader(op.token) });
  assert.equal(deniedPropose.statusCode, 403);
  const deniedStart = await ctx.fastify.inject({ method: 'POST', url: '/api/route/start', headers: authHeader(op.token), payload: { toteIds: ['T1'] } });
  assert.equal(deniedStart.statusCode, 403);

  const proposed = await ctx.fastify.inject({ method: 'GET', url: '/api/route/propose', headers: authHeader(admin.token) });
  const body = proposed.json();
  assert.equal(body.ok, true);
  assert.ok(Array.isArray(body.route.toteIds));

  await ctx.cleanup();
});

test('GET /api/route/active — readable by any logged-in role, including operator', async () => {
  const ctx = makeTestServer();
  const op = await makeOperator(ctx);
  const res = await ctx.fastify.inject({ method: 'GET', url: '/api/route/active', headers: authHeader(op.token) });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().active, null);
  await ctx.cleanup();
});

test('POST /api/route/start — a tote that is no longer waiting is rejected with 409, and the next proposal numbers rounds from history', async () => {
  const ctx = makeTestServer();
  const admin = await makeAdmin(ctx);
  addTote(ctx, 'T1', '1', 'PA', 5);
  addTote(ctx, 'T2', '2', 'PA', 5);
  recount(ctx.app.st);
  ctx.app.st.totes.T2.s = 'C';

  const bad = await ctx.fastify.inject({ method: 'POST', url: '/api/route/start', headers: authHeader(admin.token), payload: { toteIds: ['T1', 'T2'] } });
  assert.equal(bad.statusCode, 409);
  assert.match(bad.json().error, /no longer waiting/);

  const p1 = (await ctx.fastify.inject({ method: 'GET', url: '/api/route/propose', headers: authHeader(admin.token) })).json().route;
  assert.equal(p1.number, 1);
  assert.deepEqual(p1.toteIds, ['T1']);
  await ctx.fastify.inject({ method: 'POST', url: '/api/route/start', headers: authHeader(admin.token), payload: { toteIds: p1.toteIds } });
  await ctx.fastify.inject({ method: 'POST', url: '/api/route/complete', headers: authHeader(admin.token), payload: {} });
  const p2 = (await ctx.fastify.inject({ method: 'GET', url: '/api/route/propose', headers: authHeader(admin.token) })).json().route;
  assert.equal(p2.number, 2);

  await ctx.cleanup();
});

test('route membership — an operator scanning a tote outside the active route is blocked; lead/admin can still scan it', async () => {
  const ctx = makeTestServer();
  const admin = await makeAdmin(ctx);
  const lead = await makeLead(ctx);
  const op = await makeOperator(ctx);
  addTote(ctx, 'T1', '1', 'PA', 5);
  addTote(ctx, 'T2', '2', 'PB', 5);
  recount(ctx.app.st);

  const start = await ctx.fastify.inject({ method: 'POST', url: '/api/route/start', headers: authHeader(admin.token), payload: { toteIds: ['T1'] } });
  assert.equal(start.json().ok, true);

  // T2 is not in the active route
  const opScan = await ctx.fastify.inject({ method: 'POST', url: '/api/scan', headers: authHeader(op.token), payload: { raw: 'T2' } });
  assert.match(opScan.json().msg, /not in current batch/i);
  assert.equal(ctx.app.st.totes.T2.s, 'H'); // not actually opened

  const leadScan = await ctx.fastify.inject({ method: 'POST', url: '/api/scan', headers: authHeader(lead.token), payload: { raw: 'T2' } });
  assert.equal(leadScan.json().type, 'tote'); // override succeeds
  assert.equal(ctx.app.st.totes.T2.s, 'O');

  // T1 (in the route) scans normally for the operator too
  const opScanT1 = await ctx.fastify.inject({ method: 'POST', url: '/api/scan', headers: authHeader(op.token), payload: { raw: 'T1' } });
  assert.equal(opScanT1.json().type, 'tote');

  await ctx.cleanup();
});

test('POST /api/route/complete — clears activeRoute and finalizes the route_history row', async () => {
  const ctx = makeTestServer();
  const admin = await makeAdmin(ctx);
  addTote(ctx, 'T1', '1', 'PA', 5);
  recount(ctx.app.st);

  const start = await ctx.fastify.inject({ method: 'POST', url: '/api/route/start', headers: authHeader(admin.token), payload: { toteIds: ['T1'] } });
  const routeId = start.json().route.id;

  const complete = await ctx.fastify.inject({ method: 'POST', url: '/api/route/complete', headers: authHeader(admin.token), payload: { barcodesProcessed: 5 } });
  assert.equal(complete.json().ok, true);

  const active = await ctx.fastify.inject({ method: 'GET', url: '/api/route/active', headers: authHeader(admin.token) });
  assert.equal(active.json().active, null);

  const history = await ctx.fastify.inject({ method: 'GET', url: '/api/route/history', headers: authHeader(admin.token) });
  const row = history.json().routes.find(r => r.id === routeId);
  assert.equal(row.status, 'completed');
  assert.equal(row.actual.barcodesProcessed, 5);

  await ctx.cleanup();
});

test('route persistence — an active route survives a server restart against the same database', async () => {
  const ctx = makeTestServer();
  const admin = await makeAdmin(ctx);
  addTote(ctx, 'T1', '1', 'PA', 5);
  recount(ctx.app.st);
  const start = await ctx.fastify.inject({ method: 'POST', url: '/api/route/start', headers: authHeader(admin.token), payload: { toteIds: ['T1'] } });
  assert.equal(start.json().ok, true);

  const dbPath = ctx.db.name; // better-sqlite3 exposes the file path as .name
  await ctx.fastify.close();

  const { buildServer } = await import('../../src/server.js');
  const ctx2 = buildServer(dbPath, { logger: false });
  assert.ok(ctx2.routeService.getActiveRoute());
  assert.deepEqual(ctx2.routeService.getActiveRoute().toteIds, ['T1']);

  await ctx2.fastify.close();
});
