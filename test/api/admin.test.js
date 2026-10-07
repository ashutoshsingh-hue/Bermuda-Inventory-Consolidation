import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recount, markToteMissing } from '../../src/core/index.js';
import { makeTestServer, seedUser, loginStation, authHeader } from '../helpers/testServer.js';

function multipart(fieldName, filename, content, contentType = 'text/csv') {
  const boundary = '----testBoundary' + Math.random().toString(16).slice(2);
  const body = `--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n${content}\r\n--${boundary}--\r\n`;
  return { payload: body, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

const SAMPLE_CSV = 'pid,barcode,status,condition,availability,scan_location,tote,tote_simplified,tote_number,partition,scanned_at,nexs_location\n'
  + 'P1,B1,AVAILABLE,GOOD,NOT_FOUND,LOC1,TL01,1-1,1,1,2026-09-25 10:00:00,NEXS1\n'
  + 'P1,B2,AVAILABLE,GOOD,NOT_FOUND,LOC1,TL01,1-1,1,1,2026-09-25 10:00:00,NEXS1\n';

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

test('POST /api/dump — lead can upload, operator cannot, and the load is reflected live', async () => {
  const ctx = makeTestServer();
  const lead = await makeLead(ctx);
  const op = await makeOperator(ctx);

  const denied = await ctx.fastify.inject({ method: 'POST', url: '/api/dump', headers: { ...authHeader(op.token), ...multipart('file', 'x.csv', SAMPLE_CSV).headers }, payload: multipart('file', 'x.csv', SAMPLE_CSV).payload });
  assert.equal(denied.statusCode, 403);

  const mp = multipart('file', 'sample.csv', SAMPLE_CSV);
  const res = await ctx.fastify.inject({ method: 'POST', url: '/api/dump', headers: { ...authHeader(lead.token), ...mp.headers }, payload: mp.payload });
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.newTotes, 1);
  assert.equal(ctx.app.st.barcodes.B1.p, 'P1');

  await ctx.cleanup();
});

test('handover log — release-many logs each location+PID with its quantity, and the log reports totals', async () => {
  const ctx = makeTestServer();
  const lead = await makeLead(ctx);
  ctx.app.st.totes.T1 = { n: '1', s: 'H', bs: ['B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7'] };
  for (let i = 1; i <= 6; i++) ctx.app.st.barcodes['B' + i] = { p: 'P1', t: 'T1', pt: '1', pr: 1, s: 'P', l: 'A1-T01-P1' };
  ctx.app.st.barcodes.B7 = { p: 'P2', t: 'T1', pt: '1', pr: 1, s: 'P', l: 'A1-T01-P2' };
  ctx.app.st.locations[0].used = 6; ctx.app.st.locations[0].pids.P1 = { c: 6, r: 6 };
  ctx.app.st.locations[1].used = 1; ctx.app.st.locations[1].pids.P2 = { c: 1, r: 1 };
  recount(ctx.app.st);

  const empty = await ctx.fastify.inject({ method: 'GET', url: '/api/handover/log', headers: authHeader(lead.token) });
  assert.equal(empty.json().totalQty, 0);

  const rel = await ctx.fastify.inject({ method: 'POST', url: '/api/consolidation/release-many', headers: authHeader(lead.token),
    payload: { items: [{ location: 'A1-T01-P1', pid: 'P1' }, { location: 'A1-T01-P2', pid: 'P2' }, { location: 'A1-T01-P3', pid: 'P9' }] } });
  assert.equal(rel.json().totalGiven, 7);
  assert.equal(rel.json().failed.length, 1); // unknown pid is reported, not logged

  const log = (await ctx.fastify.inject({ method: 'GET', url: '/api/handover/log', headers: authHeader(lead.token) })).json();
  assert.equal(log.totalQty, 7);
  assert.equal(log.entries, 2);
  assert.equal(log.pids, 2);
  const p1 = log.rows.find(r => r.pid === 'P1');
  assert.equal(p1.qty, 6);
  assert.equal(p1.location, 'A1-T01-P1');

  const csv = await ctx.fastify.inject({ method: 'GET', url: '/api/handover/log.csv', headers: authHeader(lead.token) });
  assert.equal(csv.statusCode, 200);
  assert.match(csv.headers['content-type'], /text\/csv/);
  assert.match(csv.body, /qty_processed/);
  assert.match(csv.body, /A1-T01-P1,P1,6/);
  const csvOld = await ctx.fastify.inject({ method: 'GET', url: '/api/handover/log.csv?from=2000-01-01&to=2000-01-02', headers: authHeader(lead.token) });
  assert.doesNotMatch(csvOld.body, /P1,6/); // the export follows the date range

  const old = await ctx.fastify.inject({ method: 'GET', url: '/api/handover/log?from=2000-01-01&to=2000-01-02', headers: authHeader(lead.token) });
  assert.equal(old.json().totalQty, 0); // date filter
  const bad = await ctx.fastify.inject({ method: 'GET', url: '/api/handover/log?from=yesterday', headers: authHeader(lead.token) });
  assert.equal(bad.statusCode, 400);

  await ctx.cleanup();
});

test('release-at-risk — refuses a PID that is not AT RISK, succeeds for one that is', async () => {
  const ctx = makeTestServer();
  const lead = await makeLead(ctx);
  ctx.app.st.totes.T1 = { n: '1', s: 'H', bs: ['B1', 'B2', 'B3'] };
  ctx.app.st.barcodes.B1 = { p: 'P1', t: 'T1', pt: '1', pr: 1, s: 'P', l: 'A1-T01-P1' };
  ctx.app.st.locations[0].used = 1; ctx.app.st.locations[0].pids.P1 = { c: 1, r: 1 };
  recount(ctx.app.st);
  ctx.app.st.pids.P1.N = 2; // R=0, C=1<5, N>0 -> AT RISK

  const notRisk = await ctx.fastify.inject({ method: 'POST', url: '/api/pid/P404/release-at-risk', headers: authHeader(lead.token) });
  assert.equal(notRisk.statusCode, 400);

  const res = await ctx.fastify.inject({ method: 'POST', url: '/api/pid/P1/release-at-risk', headers: authHeader(lead.token) });
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.given, 1);
  assert.equal(ctx.app.st.pids.P1.C, 0);

  await ctx.cleanup();
});

test('stations admin — add/rename/deactivate, admin-only', async () => {
  const ctx = makeTestServer();
  const admin = await makeAdmin(ctx);
  const lead = await makeLead(ctx);

  const forbidden = await ctx.fastify.inject({ method: 'POST', url: '/api/stations', headers: authHeader(lead.token), payload: { id: 'S9' } });
  assert.equal(forbidden.statusCode, 403);

  const add = await ctx.fastify.inject({ method: 'POST', url: '/api/stations', headers: authHeader(admin.token), payload: { id: 'S9', name: 'Station 9' } });
  assert.equal(add.json().station.name, 'Station 9');

  const rename = await ctx.fastify.inject({ method: 'PATCH', url: '/api/stations/S9', headers: authHeader(admin.token), payload: { name: 'Station Nine' } });
  assert.equal(rename.json().station.name, 'Station Nine');

  const deactivate = await ctx.fastify.inject({ method: 'PATCH', url: '/api/stations/S9', headers: authHeader(admin.token), payload: { active: false } });
  assert.equal(deactivate.json().station.active, false);

  await ctx.cleanup();
});

test('force-release tote — admin-only, releases a tote stuck open at a crashed station', async () => {
  const ctx = makeTestServer();
  const admin = await makeAdmin(ctx);
  const op = await makeOperator(ctx, 'OP1');
  ctx.app.st.totes.T1 = { n: '1', s: 'H', bs: [] };
  await ctx.fastify.inject({ method: 'POST', url: '/api/scan', headers: authHeader(op.token), payload: { raw: 'T1' } });

  const denied = await ctx.fastify.inject({ method: 'POST', url: '/api/tote/T1/release', headers: authHeader(op.token) });
  assert.equal(denied.statusCode, 403);

  const res = await ctx.fastify.inject({ method: 'POST', url: '/api/tote/T1/release', headers: authHeader(admin.token) });
  assert.equal(res.json().ok, true);
  assert.equal(ctx.app.st.totes.T1.s, 'H');

  await ctx.cleanup();
});

test('alerts — list and resolve, admin-only', async () => {
  const ctx = makeTestServer();
  const admin = await makeAdmin(ctx);
  const op = await makeOperator(ctx);
  ctx.app.st.totes.T1 = { n: '1', s: 'H', bs: [] };
  await ctx.fastify.inject({ method: 'POST', url: '/api/scan', headers: authHeader(op.token), payload: { raw: 'T1' } });
  await ctx.fastify.inject({ method: 'POST', url: '/api/scan', headers: authHeader(op.token), payload: { raw: 'UNKNOWNCODE' } });

  const list = await ctx.fastify.inject({ method: 'GET', url: '/api/alerts', headers: authHeader(admin.token) });
  const alerts = list.json().alerts;
  assert.ok(alerts.length >= 1);
  const id = alerts[0].id;

  const resolve = await ctx.fastify.inject({ method: 'POST', url: `/api/alerts/${id}/resolve`, headers: authHeader(admin.token) });
  assert.ok(resolve.json().alert.resolved_at);

  await ctx.cleanup();
});

test('CSV exports — UTF-8 BOM, admin-only', async () => {
  const ctx = makeTestServer();
  const admin = await makeAdmin(ctx);
  ctx.app.st.totes.T1 = { n: '1', s: 'H', bs: ['B1'] };
  ctx.app.st.barcodes.B1 = { p: 'P1', t: 'T1', pt: '1', pr: 1, s: 'N', nfAt: '2026-09-28 10:00:00' };
  recount(ctx.app.st);

  const res = await ctx.fastify.inject({ method: 'GET', url: '/api/export/notfound.csv', headers: authHeader(admin.token) });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /text\/csv/);
  assert.equal(res.body.charCodeAt(0), 0xFEFF);
  assert.match(res.body, /B1,P1,T1,1/);

  await ctx.cleanup();
});

test('lookup — resolves a pid, a location and a barcode', async () => {
  const ctx = makeTestServer();
  const op = await makeOperator(ctx);
  ctx.app.st.totes.T1 = { n: '1', s: 'H', bs: ['B1'] };
  ctx.app.st.barcodes.B1 = { p: 'P1', t: 'T1', pt: '1', pr: 1, s: 'P', l: 'A1-T01-P1' };
  ctx.app.st.locations[0].used = 1; ctx.app.st.locations[0].pids.P1 = { c: 1, r: 1 };
  recount(ctx.app.st);

  const byPid = await ctx.fastify.inject({ method: 'GET', url: '/api/lookup?q=P1', headers: authHeader(op.token) });
  assert.equal(byPid.json().kind, 'pid');

  const byLoc = await ctx.fastify.inject({ method: 'GET', url: '/api/lookup?q=A1-T01-P1', headers: authHeader(op.token) });
  assert.equal(byLoc.json().kind, 'location');

  const byBarcode = await ctx.fastify.inject({ method: 'GET', url: '/api/lookup?q=B1', headers: authHeader(op.token) });
  assert.equal(byBarcode.json().kind, 'barcode');

  const missing = await ctx.fastify.inject({ method: 'GET', url: '/api/lookup?q=NOPE', headers: authHeader(op.token) });
  assert.equal(missing.statusCode, 404);

  await ctx.cleanup();
});

test('status — includes the aisle map and live station board', async () => {
  const ctx = makeTestServer();
  const op = await makeOperator(ctx, 'S1');
  ctx.app.st.totes.T1 = { n: '1', s: 'H', bs: [] };
  await ctx.fastify.inject({ method: 'POST', url: '/api/scan', headers: authHeader(op.token), payload: { raw: 'T1' } });

  const res = await ctx.fastify.inject({ method: 'GET', url: '/api/status' });
  const body = res.json();
  assert.equal(body.aisleMap.length, 240);
  const station = body.stations.find(s => s.id === 'S1');
  assert.equal(station.openTote, 'T1');

  await ctx.cleanup();
});

test('import pilot backup — admin-only, replaces live state from the uploaded JSON', async () => {
  const ctx = makeTestServer();
  const admin = await makeAdmin(ctx);
  const backup = {
    settings: undefined,
    locations: [{ code: 'A1-T01-P1', used: 1, pids: { P1: { c: 1, r: 1 } } }],
    barcodes: { B1: { p: 'P1', t: 'TL01', pt: '1', pr: 1, s: 'P', l: 'A1-T01-P1' } },
    totes: { TL01: { n: '1', s: 'O', bs: ['B1'], station: 'PILOT' } },
    pids: {},
    loads: [], alerts: [],
  };
  const mp = multipart('file', 'backup.json', JSON.stringify(backup), 'application/json');
  const res = await ctx.fastify.inject({ method: 'POST', url: '/api/import/pilot', headers: { ...authHeader(admin.token), ...mp.headers }, payload: mp.payload });
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(ctx.app.st.barcodes.B1.s, 'P');
  assert.equal(ctx.app.st.totes.TL01.s, 'H'); // pilot's open tote re-enters the pool

  await ctx.cleanup();
});

test('POST /api/preload — lead can upload existing aisle stock, operator cannot', async () => {
  const ctx = makeTestServer();
  const lead = await makeLead(ctx);
  const op = await makeOperator(ctx);
  const csv = 'location,pid,barcode,tote\nA1-T01-P1,P1,B1,TOTE1';

  const mpOp = multipart('file', 'stock.csv', csv);
  const denied = await ctx.fastify.inject({ method: 'POST', url: '/api/preload', headers: { ...authHeader(op.token), ...mpOp.headers }, payload: mpOp.payload });
  assert.equal(denied.statusCode, 403);

  const mp = multipart('file', 'stock.csv', csv);
  const res = await ctx.fastify.inject({ method: 'POST', url: '/api/preload', headers: { ...authHeader(lead.token), ...mp.headers }, payload: mp.payload });
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.added, 1);
  assert.equal(ctx.app.st.barcodes.B1.s, 'P');

  await ctx.cleanup();
});

test('tote not-found flow — operator marks a tote missing, lead sees it and can reinstate it', async () => {
  const ctx = makeTestServer();
  const op = await makeOperator(ctx);
  const lead = await makeLead(ctx);
  ctx.app.st.totes.T1 = { n: '1', s: 'H', bs: ['B1'] };
  ctx.app.st.barcodes.B1 = { p: 'P1', t: 'T1', pt: '1', pr: 1, s: 'H' };
  recount(ctx.app.st);

  const mark = await ctx.fastify.inject({ method: 'POST', url: '/api/tote/T1/missing', headers: authHeader(op.token), payload: { reason: 'Pallet not found' } });
  const markBody = mark.json();
  assert.equal(markBody.ok, true);
  assert.equal(ctx.app.st.totes.T1.s, 'M');

  const listDenied = await ctx.fastify.inject({ method: 'GET', url: '/api/totes/missing', headers: authHeader(op.token) });
  assert.equal(listDenied.statusCode, 403); // operator can report, but the list is lead/admin

  const list = await ctx.fastify.inject({ method: 'GET', url: '/api/totes/missing', headers: authHeader(lead.token) });
  const listBody = list.json();
  assert.equal(listBody.totes.length, 1);
  assert.equal(listBody.totes[0].tote, 'T1');

  const reinstate = await ctx.fastify.inject({ method: 'POST', url: '/api/tote/T1/reinstate', headers: authHeader(lead.token) });
  assert.equal(reinstate.json().ok, true);
  assert.equal(ctx.app.st.totes.T1.s, 'H');
});

test('CSV exports — missingtotes.csv and aislestock.csv are correct and admin-only', async () => {
  const ctx = makeTestServer();
  const admin = await makeAdmin(ctx);
  ctx.app.st.totes.T1 = { n: '1', s: 'H', bs: ['B1'] };
  ctx.app.st.barcodes.B1 = { p: 'P1', t: 'T1', pt: '1', pr: 1, s: 'H' };
  ctx.app.st.barcodes.B2 = { p: 'P1', t: 'T2', pt: '1', pr: 1, s: 'P', l: 'A1-T01-P1' };
  recount(ctx.app.st);

  markToteMissing(ctx.app.st, 'T1', new Date(), 'test reason');

  const missing = await ctx.fastify.inject({ method: 'GET', url: '/api/export/missingtotes.csv', headers: authHeader(admin.token) });
  assert.equal(missing.statusCode, 200);
  assert.match(missing.body, /test reason/);

  const stock = await ctx.fastify.inject({ method: 'GET', url: '/api/export/aislestock.csv', headers: authHeader(admin.token) });
  assert.equal(stock.statusCode, 200);
  assert.match(stock.body, /A1-T01-P1,P1,B2,T2/);

  const denied = await ctx.fastify.inject({ method: 'GET', url: '/api/export/aislestock.csv' });
  assert.equal(denied.statusCode, 401);

  await ctx.cleanup();
});

test('sync-mode setting — defaults to dump, lead can switch it, operator cannot, value persists', async () => {
  const ctx = makeTestServer();
  const lead = await makeLead(ctx);
  const op = await makeOperator(ctx);

  const initial = await ctx.fastify.inject({ method: 'GET', url: '/api/settings/sync-mode', headers: authHeader(lead.token) });
  assert.equal(initial.json().mode, 'dump');

  const denied = await ctx.fastify.inject({ method: 'POST', url: '/api/settings/sync-mode', headers: authHeader(op.token), payload: { mode: 'auto' } });
  assert.equal(denied.statusCode, 403);

  const bad = await ctx.fastify.inject({ method: 'POST', url: '/api/settings/sync-mode', headers: authHeader(lead.token), payload: { mode: 'bogus' } });
  assert.equal(bad.statusCode, 400);

  const set = await ctx.fastify.inject({ method: 'POST', url: '/api/settings/sync-mode', headers: authHeader(lead.token), payload: { mode: 'auto' } });
  assert.equal(set.json().mode, 'auto');

  const after = await ctx.fastify.inject({ method: 'GET', url: '/api/settings/sync-mode', headers: authHeader(lead.token) });
  assert.equal(after.json().mode, 'auto');

  await ctx.cleanup();
});

test('layout settings — admin-only, locked once anything is placed, lets the 60-tote rack be reconfigured', async () => {
  const ctx = makeTestServer();
  const admin = await makeAdmin(ctx);
  const lead = await makeLead(ctx);

  const denied = await ctx.fastify.inject({ method: 'GET', url: '/api/settings/layout', headers: authHeader(lead.token) });
  assert.equal(denied.statusCode, 403);

  const initial = await ctx.fastify.inject({ method: 'GET', url: '/api/settings/layout', headers: authHeader(admin.token) });
  const initialBody = initial.json();
  assert.equal(initialBody.locked, false);
  assert.equal(initialBody.settings.totesPerAisle, 20);
  assert.equal(initialBody.settings.aisles, 3);

  const newLayout = { ...initialBody.settings, totesPerAisle: 25, lastAisleTotes: 25 };
  const set = await ctx.fastify.inject({ method: 'POST', url: '/api/settings/layout', headers: authHeader(admin.token), payload: newLayout });
  const setBody = set.json();
  assert.equal(setBody.ok, true);
  assert.equal(setBody.settings.totesPerAisle, 25);
  assert.equal(ctx.app.st.locations.length, 3 * 25 * 4);

  const bad = await ctx.fastify.inject({ method: 'POST', url: '/api/settings/layout', headers: authHeader(admin.token), payload: { ...newLayout, aisles: 0 } });
  assert.equal(bad.statusCode, 400);

  // once anything is placed, the layout locks
  ctx.app.st.totes.T1 = { n: '1', s: 'H', bs: ['B1'] };
  ctx.app.st.barcodes.B1 = { p: 'P1', t: 'T1', pt: '1', pr: 1, s: 'H' };
  // P1 needs a known total >= 5 to be placeable at all (under-5 PIDs are left aside)
  ctx.app.st.totes.T9 = { n: '9', s: 'H', bs: ['B1b', 'B1c', 'B1d', 'B1e'] };
  for (const b of ['B1b', 'B1c', 'B1d', 'B1e']) ctx.app.st.barcodes[b] = { p: 'P1', t: 'T9', pt: '1', pr: 1, s: 'H' };
  recount(ctx.app.st);
  await ctx.fastify.inject({ method: 'POST', url: '/api/scan', headers: authHeader(admin.token), payload: { raw: 'T1' } });
  await ctx.fastify.inject({ method: 'POST', url: '/api/scan', headers: authHeader(admin.token), payload: { raw: 'B1' } });

  const lockedStatus = await ctx.fastify.inject({ method: 'GET', url: '/api/settings/layout', headers: authHeader(admin.token) });
  assert.equal(lockedStatus.json().locked, true);

  const lockedSet = await ctx.fastify.inject({ method: 'POST', url: '/api/settings/layout', headers: authHeader(admin.token), payload: { ...newLayout, totesPerAisle: 15 } });
  assert.equal(lockedSet.statusCode, 409);

  await ctx.cleanup();
});

test('users admin — add/list/delete/reactivate, admin-only, and cannot delete the last admin', async () => {
  const ctx = makeTestServer();
  const admin = await makeAdmin(ctx);
  const op = await makeOperator(ctx);

  const denied = await ctx.fastify.inject({ method: 'POST', url: '/api/users', headers: authHeader(op.token), payload: { name: 'NewOp', role: 'operator', pin: '4444' } });
  assert.equal(denied.statusCode, 403);

  const add = await ctx.fastify.inject({ method: 'POST', url: '/api/users', headers: authHeader(admin.token), payload: { name: 'NewOp', role: 'operator', pin: '4444' } });
  const addBody = add.json();
  assert.equal(addBody.ok, true);
  assert.equal(addBody.user.role, 'operator');
  const newOpId = addBody.user.id;

  const dupe = await ctx.fastify.inject({ method: 'POST', url: '/api/users', headers: authHeader(admin.token), payload: { name: 'NewOp', role: 'operator', pin: '5555' } });
  assert.equal(dupe.statusCode, 409);

  const list = await ctx.fastify.inject({ method: 'GET', url: '/api/users', headers: authHeader(admin.token) });
  assert.ok(list.json().users.some(u => u.name === 'NewOp' && u.active === true));

  // the new operator can actually log in
  const opLogin = await ctx.fastify.inject({ method: 'POST', url: '/api/login', payload: { station: 'S9', name: 'NewOp', pin: '4444' } });
  assert.equal(opLogin.json().ok, true);

  // delete (soft) — blocks login going forward
  const del = await ctx.fastify.inject({ method: 'DELETE', url: `/api/users/${newOpId}`, headers: authHeader(admin.token) });
  assert.equal(del.json().ok, true);
  const opLoginAfterDelete = await ctx.fastify.inject({ method: 'POST', url: '/api/login', payload: { station: 'S9', name: 'NewOp', pin: '4444' } });
  assert.equal(opLoginAfterDelete.statusCode, 401);

  // reactivate
  const react = await ctx.fastify.inject({ method: 'PATCH', url: `/api/users/${newOpId}`, headers: authHeader(admin.token), payload: { active: true } });
  assert.equal(react.json().ok, true);
  const opLoginAfterReactivate = await ctx.fastify.inject({ method: 'POST', url: '/api/login', payload: { station: 'S9', name: 'NewOp', pin: '4444' } });
  assert.equal(opLoginAfterReactivate.json().ok, true);

  // cannot delete the last admin
  const selfDelete = await ctx.fastify.inject({ method: 'DELETE', url: '/api/users/1', headers: authHeader(admin.token) });
  assert.equal(selfDelete.statusCode, 409);

  await ctx.cleanup();
});

test('consolidation — lists per-location PID breakdown; lead can always release, operator only once 30+ is collected there', async () => {
  const ctx = makeTestServer();
  const lead = await makeLead(ctx);
  const op = await makeOperator(ctx);
  ctx.app.st.totes.T1 = { n: '1', s: 'H', bs: ['B1', 'B2'] };
  ctx.app.st.barcodes.B1 = { p: 'P1', t: 'T1', pt: '1', pr: 1, s: 'H' };
  ctx.app.st.barcodes.B2 = { p: 'P1', t: 'T1', pt: '1', pr: 1, s: 'H' };
  // P1 needs a known total >= 5 to be placeable at all (under-5 PIDs are left aside) — the
  // other 3 live in a separate holding tote so qtyHere below still reflects just T1's 2
  ctx.app.st.totes.T9 = { n: '9', s: 'H', bs: ['B1c', 'B1d', 'B1e'] };
  for (const b of ['B1c', 'B1d', 'B1e']) ctx.app.st.barcodes[b] = { p: 'P1', t: 'T9', pt: '1', pr: 1, s: 'H' };
  recount(ctx.app.st);
  await ctx.fastify.inject({ method: 'POST', url: '/api/scan', headers: authHeader(op.token), payload: { raw: 'T1' } });
  await ctx.fastify.inject({ method: 'POST', url: '/api/scan', headers: authHeader(op.token), payload: { raw: 'B1' } });
  await ctx.fastify.inject({ method: 'POST', url: '/api/scan', headers: authHeader(op.token), payload: { raw: 'B2' } });

  const deniedList = await ctx.fastify.inject({ method: 'GET', url: '/api/consolidation', headers: authHeader(op.token) });
  assert.equal(deniedList.statusCode, 403);

  const list = await ctx.fastify.inject({ method: 'GET', url: '/api/consolidation', headers: authHeader(lead.token) });
  const listBody = list.json();
  assert.equal(listBody.pidsOpen, 1);
  assert.equal(listBody.rows[0].pid, 'P1');
  assert.equal(listBody.rows[0].qtyHere, 2);
  assert.equal(listBody.rows[0].knownTotal, 5); // 2 placed here + 3 still waiting in the holding tote
  assert.ok(listBody.rows[0].ageMinutes !== null);
  const location = listBody.rows[0].location;

  // operator CAN call this route now, but is blocked by the 30+ threshold, not by role
  const deniedRelease = await ctx.fastify.inject({ method: 'POST', url: '/api/consolidation/release', headers: authHeader(op.token), payload: { location, pid: 'P1' } });
  assert.equal(deniedRelease.statusCode, 400);
  assert.match(deniedRelease.json().error, /30\+/);

  const release = await ctx.fastify.inject({ method: 'POST', url: '/api/consolidation/release', headers: authHeader(lead.token), payload: { location, pid: 'P1' } });
  const releaseBody = release.json();
  assert.equal(releaseBody.ok, true);
  assert.equal(releaseBody.given, 2);
  assert.equal(ctx.app.st.pids.P1.H, 2);

  const afterList = await ctx.fastify.inject({ method: 'GET', url: '/api/consolidation', headers: authHeader(lead.token) });
  assert.equal(afterList.json().rows.length, 0);

  await ctx.cleanup();
});

test('consolidation release — an operator CAN release once 30+ is collected at that location', async () => {
  const ctx = makeTestServer();
  const op = await makeOperator(ctx);
  const L = ctx.app.st.locations[0];
  L.used = 30; L.pids.P1 = { c: 30, r: 30 };
  ctx.app.st.pids.P1 = { C: 30, R: 0, H: 0, N: 0, M: 0, locs: { [L.code]: 1 } };
  for (let i = 0; i < 30; i++) ctx.app.st.barcodes['B' + i] = { p: 'P1', t: 'T1', pt: '1', pr: 1, s: 'P', l: L.code, ts: '2026-01-01 00:00:00' };

  const release = await ctx.fastify.inject({ method: 'POST', url: '/api/consolidation/release', headers: authHeader(op.token), payload: { location: L.code, pid: 'P1' } });
  const body = release.json();
  assert.equal(body.ok, true);
  assert.equal(body.given, 30);
  assert.equal(ctx.app.st.pids.P1.H, 30);

  await ctx.cleanup();
});

test('scan — the response nudges readyToRelease once a PID crosses 30 collected at its location, and not before', async () => {
  const ctx = makeTestServer();
  const op = await makeOperator(ctx);
  const barcodes = [];
  for (let i = 0; i < 35; i++) barcodes.push('B' + i);
  ctx.app.st.totes.T1 = { n: '1', s: 'H', bs: barcodes.slice() };
  for (const b of barcodes) ctx.app.st.barcodes[b] = { p: 'BIGPID', t: 'T1', pt: '1', pr: 1, s: 'H' };
  recount(ctx.app.st);

  await ctx.fastify.inject({ method: 'POST', url: '/api/scan', headers: authHeader(op.token), payload: { raw: 'T1' } });
  let lastBody;
  for (const b of barcodes) {
    const r = await ctx.fastify.inject({ method: 'POST', url: '/api/scan', headers: authHeader(op.token), payload: { raw: b } });
    lastBody = r.json();
  }
  // after 35 scans (all placed, since BIGPID's total is 35 >= 10), the last one should carry
  // the nudge; earlier ones (below 30) should not
  assert.ok(lastBody.readyToRelease);
  assert.equal(lastBody.readyToRelease.pid, 'BIGPID');
  assert.ok(lastBody.readyToRelease.qty >= 30);

  await ctx.cleanup();
});

test('consolidation reset — releases everything in one shot, admin-only (lead cannot)', async () => {
  const ctx = makeTestServer();
  const admin = await makeAdmin(ctx);
  const lead = await makeLead(ctx);
  const op = await makeOperator(ctx);
  ctx.app.st.totes.T1 = { n: '1', s: 'H', bs: ['B1', 'B2'] };
  ctx.app.st.barcodes.B1 = { p: 'P1', t: 'T1', pt: '1', pr: 1, s: 'H' };
  ctx.app.st.barcodes.B2 = { p: 'P2', t: 'T1', pt: '1', pr: 1, s: 'H' };
  // both P1 and P2 need a known total >= 5 to be placeable at all (under-5 PIDs are left aside)
  ctx.app.st.totes.T9 = { n: '9', s: 'H', bs: ['B1b', 'B1c', 'B1d', 'B1e'] };
  for (const b of ['B1b', 'B1c', 'B1d', 'B1e']) ctx.app.st.barcodes[b] = { p: 'P1', t: 'T9', pt: '1', pr: 1, s: 'H' };
  ctx.app.st.totes.T10 = { n: '10', s: 'H', bs: ['B2b', 'B2c', 'B2d', 'B2e'] };
  for (const b of ['B2b', 'B2c', 'B2d', 'B2e']) ctx.app.st.barcodes[b] = { p: 'P2', t: 'T10', pt: '1', pr: 1, s: 'H' };
  recount(ctx.app.st);
  await ctx.fastify.inject({ method: 'POST', url: '/api/scan', headers: authHeader(op.token), payload: { raw: 'T1' } });
  await ctx.fastify.inject({ method: 'POST', url: '/api/scan', headers: authHeader(op.token), payload: { raw: 'B1' } });
  await ctx.fastify.inject({ method: 'POST', url: '/api/scan', headers: authHeader(op.token), payload: { raw: 'B2' } });

  const deniedOperator = await ctx.fastify.inject({ method: 'POST', url: '/api/consolidation/release-all', headers: authHeader(op.token) });
  assert.equal(deniedOperator.statusCode, 403);
  const deniedLead = await ctx.fastify.inject({ method: 'POST', url: '/api/consolidation/release-all', headers: authHeader(lead.token) });
  assert.equal(deniedLead.statusCode, 403);

  const reset = await ctx.fastify.inject({ method: 'POST', url: '/api/consolidation/release-all', headers: authHeader(admin.token) });
  const resetBody = reset.json();
  assert.equal(resetBody.totalGiven, 2);
  assert.equal(resetBody.pidsReleased, 2);

  const after = await ctx.fastify.inject({ method: 'GET', url: '/api/consolidation', headers: authHeader(admin.token) });
  assert.equal(after.json().rows.length, 0);

  await ctx.cleanup();
});

test('sim report — two stations each get their own tote with no clash, and a real clash attempt is recorded', async () => {
  const ctx = makeTestServer();
  const admin = await makeAdmin(ctx);
  const op1 = await makeOperator(ctx, 'OP1');
  const op2 = await makeOperator(ctx, 'OP2');

  ctx.app.st.totes.T1 = { n: '1', s: 'H', bs: ['B1'] };
  ctx.app.st.totes.T2 = { n: '2', s: 'H', bs: ['B2'] };
  ctx.app.st.barcodes.B1 = { p: 'P1', t: 'T1', pt: '1', pr: 1, s: 'H' };
  ctx.app.st.barcodes.B2 = { p: 'P2', t: 'T2', pt: '1', pr: 1, s: 'H' };
  // both P1 and P2 need a known total >= 5 to be placeable at all (under-5 PIDs are left aside)
  ctx.app.st.totes.T9 = { n: '9', s: 'H', bs: ['B1b', 'B1c', 'B1d', 'B1e'] };
  for (const b of ['B1b', 'B1c', 'B1d', 'B1e']) ctx.app.st.barcodes[b] = { p: 'P1', t: 'T9', pt: '1', pr: 1, s: 'H' };
  ctx.app.st.totes.T10 = { n: '10', s: 'H', bs: ['B2b', 'B2c', 'B2d', 'B2e'] };
  for (const b of ['B2b', 'B2c', 'B2d', 'B2e']) ctx.app.st.barcodes[b] = { p: 'P2', t: 'T10', pt: '1', pr: 1, s: 'H' };
  recount(ctx.app.st);

  const deniedOperator = await ctx.fastify.inject({ method: 'GET', url: '/api/sim-report', headers: authHeader(op1.token) });
  assert.equal(deniedOperator.statusCode, 403);

  // both stations open their own tote concurrently — no clash
  await ctx.fastify.inject({ method: 'POST', url: '/api/scan', headers: authHeader(op1.token), payload: { raw: 'T1' } });
  await ctx.fastify.inject({ method: 'POST', url: '/api/scan', headers: authHeader(op2.token), payload: { raw: 'T2' } });
  await ctx.fastify.inject({ method: 'POST', url: '/api/scan', headers: authHeader(op1.token), payload: { raw: 'B1' } });
  await ctx.fastify.inject({ method: 'POST', url: '/api/scan', headers: authHeader(op2.token), payload: { raw: 'B2' } });
  await ctx.fastify.inject({ method: 'POST', url: '/api/tote/finish', headers: authHeader(op1.token) });

  // OP1 is now free (T1 finished) and tries to grab T2, which OP2 still has open — a real clash
  const clash = await ctx.fastify.inject({ method: 'POST', url: '/api/scan', headers: authHeader(op1.token), payload: { raw: 'T2' } });
  assert.match(clash.json().msg, /Tote open at Station OP2/);
  await ctx.fastify.inject({ method: 'POST', url: '/api/tote/finish', headers: authHeader(op2.token) });

  const report = await ctx.fastify.inject({ method: 'GET', url: '/api/sim-report', headers: authHeader(admin.token) });
  const body = report.json();
  assert.equal(body.ok, true);
  assert.equal(body.totalTotes, 2);
  const byStation = Object.fromEntries(body.stations.map(s => [s.station, s]));
  assert.equal(byStation.OP1.totes, 1);
  assert.equal(byStation.OP1.placed, 1);
  assert.equal(byStation.OP2.totes, 1);
  assert.equal(byStation.OP2.placed, 1);
  assert.equal(body.clashes.length, 1);
  assert.equal(body.clashes[0].blockedStation, 'OP1');
  assert.equal(body.clashes[0].contestedTote, 'T2');

  await ctx.cleanup();
});

test('POST /api/sim-report/clear — admin only, wipes tote/operator/clash history but never touches placed barcodes or pid counts', async () => {
  const ctx = makeTestServer();
  const admin = await makeAdmin(ctx);
  const lead = await makeLead(ctx);
  const op1 = await makeOperator(ctx, 'OP1');
  const op2 = await makeOperator(ctx, 'OP2');

  ctx.app.st.totes.T1 = { n: '1', s: 'H', bs: ['B1'] };
  ctx.app.st.totes.T2 = { n: '2', s: 'H', bs: ['B2'] };
  ctx.app.st.barcodes.B1 = { p: 'P1', t: 'T1', pt: '1', pr: 1, s: 'H' };
  ctx.app.st.barcodes.B2 = { p: 'P2', t: 'T2', pt: '1', pr: 1, s: 'H' };
  ctx.app.st.totes.T9 = { n: '9', s: 'H', bs: ['B1b', 'B1c', 'B1d', 'B1e'] };
  for (const b of ['B1b', 'B1c', 'B1d', 'B1e']) ctx.app.st.barcodes[b] = { p: 'P1', t: 'T9', pt: '1', pr: 1, s: 'H' };
  recount(ctx.app.st);

  await ctx.fastify.inject({ method: 'POST', url: '/api/scan', headers: authHeader(op1.token), payload: { raw: 'T1' } });
  await ctx.fastify.inject({ method: 'POST', url: '/api/scan', headers: authHeader(op1.token), payload: { raw: 'B1' } });
  await ctx.fastify.inject({ method: 'POST', url: '/api/tote/finish', headers: authHeader(op1.token) });
  await ctx.fastify.inject({ method: 'POST', url: '/api/scan', headers: authHeader(op2.token), payload: { raw: 'T2' } }); // still open — must survive the clear

  const deniedLead = await ctx.fastify.inject({ method: 'POST', url: '/api/sim-report/clear', headers: authHeader(lead.token) });
  assert.equal(deniedLead.statusCode, 403);

  const res = await ctx.fastify.inject({ method: 'POST', url: '/api/sim-report/clear', headers: authHeader(admin.token) });
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.totesCleared, 1); // only T1 (closed) — T2 is still open, left alone
  assert.equal(body.clashesCleared, 0);

  const report = (await ctx.fastify.inject({ method: 'GET', url: '/api/sim-report', headers: authHeader(admin.token) })).json();
  assert.equal(report.totalTotes, 1); // T1 dropped out of the report; T2 (still open) remains
  assert.equal(report.assignments[0].tote, 'T2');

  // the real, physical outcome of T1's work is completely untouched
  assert.equal(ctx.app.st.barcodes.B1.s, 'P');
  assert.equal(ctx.app.st.pids.P1.C, 1);

  await ctx.cleanup();
});
