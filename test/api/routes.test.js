import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recount } from '../../src/core/index.js';
import { makeTestServer, seedUser, loginStation, authHeader } from '../helpers/testServer.js';

function seedTote(ctx, toteId, pid, barcodes) {
  ctx.app.st.totes[toteId] = { n: toteId.replace('T', ''), s: 'H', bs: [] };
  for (const b of barcodes) {
    ctx.app.st.barcodes[b] = { p: pid, t: toteId, pt: '1', pr: 1, s: 'H' };
    ctx.app.st.totes[toteId].bs.push(b);
  }
  recount(ctx.app.st);
}

// tops up a pid's known total to >= 5 via a separate holding tote, so it's eligible for
// placement at all (under-5-total pids are left aside, never placed) — used where a test
// scans a pid seeded with fewer than 5 barcodes but needs the scan to actually place it
function padPidTo5(ctx, pid, holdingToteId) {
  const extras = ['x1', 'x2', 'x3', 'x4'].map(s => `${holdingToteId}-${s}`);
  ctx.app.st.totes[holdingToteId] = { n: holdingToteId, s: 'H', bs: extras };
  for (const b of extras) ctx.app.st.barcodes[b] = { p: pid, t: holdingToteId, pt: '1', pr: 1, s: 'H' };
  recount(ctx.app.st);
}

test('POST /api/login — wrong PIN is rejected, correct PIN returns a token', async () => {
  const ctx = makeTestServer();
  const user = seedUser(ctx, { name: 'Alice', pin: '4242' });

  const bad = await ctx.fastify.inject({ method: 'POST', url: '/api/login', payload: { station: 'S1', name: 'Alice', pin: '0000' } });
  assert.equal(bad.statusCode, 401);

  const good = await loginStation(ctx, 'S1', user);
  assert.ok(good.ok);
  assert.ok(good.token);
  assert.equal(good.user.name, 'Alice');

  await ctx.cleanup();
});

test('POST /api/scan — requires a valid session', async () => {
  const ctx = makeTestServer();
  const res = await ctx.fastify.inject({ method: 'POST', url: '/api/scan', payload: { raw: 'ANYTHING' } });
  assert.equal(res.statusCode, 401);
  await ctx.cleanup();
});

test('scan flow over HTTP — open tote, place a barcode, finish tote', async () => {
  const ctx = makeTestServer();
  const user = seedUser(ctx, { pin: '1111' });
  const { token } = await loginStation(ctx, 'S1', user);
  seedTote(ctx, 'T1', 'P1', ['B1']);
  padPidTo5(ctx, 'P1', 'H1');

  const open = await ctx.fastify.inject({ method: 'POST', url: '/api/scan', headers: authHeader(token), payload: { raw: 'T1' } });
  assert.equal(open.json().type, 'tote');

  const place = await ctx.fastify.inject({ method: 'POST', url: '/api/scan', headers: authHeader(token), payload: { raw: 'B1' } });
  const placeBody = place.json();
  assert.equal(placeBody.type, 'place');
  assert.ok(placeBody.loc);
  assert.deepEqual(placeBody.tote_progress, { tote: 'T1', n: '1', exp: 1, done: 1 });

  const current = await ctx.fastify.inject({ method: 'GET', url: '/api/tote/current', headers: authHeader(token) });
  assert.deepEqual(current.json().current, { tote: 'T1', n: '1', exp: 1, done: 1 });

  const finish = await ctx.fastify.inject({ method: 'POST', url: '/api/tote/finish', headers: authHeader(token) });
  const finishBody = finish.json();
  assert.equal(finishBody.ok, true);
  assert.equal(finishBody.notFound.length, 0);

  const currentAfterFinish = await ctx.fastify.inject({ method: 'GET', url: '/api/tote/current', headers: authHeader(token) });
  assert.equal(currentAfterFinish.json().current, null);

  await ctx.cleanup();
});

test('undo over HTTP — only undoes the calling station\'s own last scan', async () => {
  const ctx = makeTestServer();
  const userA = seedUser(ctx, { pin: '1111' });
  const userB = seedUser(ctx, { pin: '2222' });
  const a = await loginStation(ctx, 'S1', userA);
  const b = await loginStation(ctx, 'S2', userB);
  seedTote(ctx, 'T1', 'P1', ['B1']);
  padPidTo5(ctx, 'P1', 'H1');
  ctx.app.st.totes.T2 = { n: '2', s: 'H', bs: ['B2'] };
  ctx.app.st.barcodes.B2 = { p: 'P2', t: 'T2', pt: '1', pr: 1, s: 'H' };
  recount(ctx.app.st);
  padPidTo5(ctx, 'P2', 'H2');

  await ctx.fastify.inject({ method: 'POST', url: '/api/scan', headers: authHeader(a.token), payload: { raw: 'T1' } });
  await ctx.fastify.inject({ method: 'POST', url: '/api/scan', headers: authHeader(a.token), payload: { raw: 'B1' } });
  await ctx.fastify.inject({ method: 'POST', url: '/api/scan', headers: authHeader(b.token), payload: { raw: 'T2' } });
  await ctx.fastify.inject({ method: 'POST', url: '/api/scan', headers: authHeader(b.token), payload: { raw: 'B2' } });

  const undoB = await ctx.fastify.inject({ method: 'POST', url: '/api/undo', headers: authHeader(b.token) });
  assert.equal(undoB.json().barcode, 'B2');
  assert.equal(ctx.app.st.barcodes.B1.s, 'P'); // station A's placement untouched

  await ctx.cleanup();
});

test('GET /api/next-totes — reflects live recommendations for the calling station', async () => {
  const ctx = makeTestServer();
  const user = seedUser(ctx, { pin: '1111' });
  const { token } = await loginStation(ctx, 'S1', user);
  seedTote(ctx, 'T1', 'P1', ['B1', 'B2']);

  const res = await ctx.fastify.inject({ method: 'GET', url: '/api/next-totes?n=5', headers: authHeader(token) });
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.list.length, 1);
  assert.equal(body.list[0].tote, 'T1');

  await ctx.cleanup();
});

test('GET /api/status — is public (no auth) and reflects live summary', async () => {
  const ctx = makeTestServer();
  const res = await ctx.fastify.inject({ method: 'GET', url: '/api/status' });
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.summary.plannedLocs, 240);
  await ctx.cleanup();
});
