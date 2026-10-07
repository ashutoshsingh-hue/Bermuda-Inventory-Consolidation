/* Concurrency test (PLAN.md §10): fire scans from many stations "at once" over HTTP and
 * prove the single-process, one-transaction-per-mutation design (PLAN.md §6) serializes
 * them correctly — no location over capacity, no barcode placed twice, events == requests. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recount } from '../src/core/index.js';
import { makeTestServer, seedUser, loginStation, authHeader } from './helpers/testServer.js';

test('concurrency — 8 stations scanning in parallel: no overfill, no double placement, events == requests', async () => {
  const ctx = makeTestServer();
  const stations = [];
  for (let i = 1; i <= 8; i++) {
    const user = seedUser(ctx, { pin: '1111' });
    const login = await loginStation(ctx, 'S' + i, user);
    stations.push({ sid: 'S' + i, token: login.token });
  }

  // 8 totes (one per station), barcodes drawn from a small shared PID pool so assign()
  // contends for the same locations across stations.
  const PIDS = Array.from({ length: 5 }, (_, i) => 'PID' + i);
  let bcIdx = 0;
  for (let i = 1; i <= 8; i++) {
    const toteId = 'TOTE' + i;
    ctx.app.st.totes[toteId] = { n: String(i), s: 'H', bs: [] };
    for (let j = 0; j < 30; j++) {
      const b = 'BC' + (bcIdx++);
      const p = PIDS[(i + j) % PIDS.length];
      ctx.app.st.barcodes[b] = { p, t: toteId, pt: '1', pr: 1, s: 'H' };
      ctx.app.st.totes[toteId].bs.push(b);
    }
  }
  recount(ctx.app.st);

  let requestCount = 0;
  const openResults = await Promise.all(stations.map(({ token }, idx) => {
    requestCount++;
    return ctx.fastify.inject({ method: 'POST', url: '/api/scan', headers: authHeader(token), payload: { raw: 'TOTE' + (idx + 1) } });
  }));
  for (const res of openResults) assert.equal(res.json().type, 'tote');

  const barcodesByStation = stations.map((_, idx) => ctx.app.st.totes['TOTE' + (idx + 1)].bs.slice());
  const scanPromises = [];
  stations.forEach(({ token }, idx) => {
    for (const b of barcodesByStation[idx]) {
      scanPromises.push(ctx.fastify.inject({ method: 'POST', url: '/api/scan', headers: authHeader(token), payload: { raw: b } }));
      requestCount++;
    }
  });
  const results = await Promise.all(scanPromises);
  for (const res of results) assert.equal(res.statusCode, 200);

  for (const L of ctx.app.st.locations) {
    assert.ok(L.used <= ctx.app.st.settings.cap, `${L.code} over physical cap (${L.used})`);
    assert.ok(Object.keys(L.pids).length <= ctx.app.st.settings.softPidCap, `${L.code} over PID cap`);
  }

  const placedCount = Object.values(ctx.app.st.barcodes).filter(B => B.s === 'P').length;
  assert.equal(placedCount, 8 * 30); // every barcode placed exactly once (state machine forbids re-placing)

  const eventCount = ctx.db.prepare('SELECT COUNT(*) AS n FROM events').get().n;
  assert.equal(eventCount, requestCount);

  await ctx.cleanup();
});

test('concurrency — tote lock: a station scanning a tote open at another station is rejected', async () => {
  const ctx = makeTestServer();
  const userA = seedUser(ctx, { pin: '1111' });
  const userB = seedUser(ctx, { pin: '2222' });
  const a = await loginStation(ctx, 'S1', userA);
  const b = await loginStation(ctx, 'S2', userB);
  ctx.app.st.totes.T1 = { n: '1', s: 'H', bs: [] };

  await ctx.fastify.inject({ method: 'POST', url: '/api/scan', headers: authHeader(a.token), payload: { raw: 'T1' } });
  const res = await ctx.fastify.inject({ method: 'POST', url: '/api/scan', headers: authHeader(b.token), payload: { raw: 'T1' } });
  const body = res.json();
  assert.equal(body.type, 'error');
  assert.match(body.msg, /Tote open at Station S1/);

  await ctx.cleanup();
});

test('concurrency — with N stations open, each is offered a different next tote', async () => {
  const ctx = makeTestServer();
  const stations = [];
  for (let i = 1; i <= 4; i++) {
    const user = seedUser(ctx, { pin: '1111' });
    const login = await loginStation(ctx, 'S' + i, user);
    stations.push({ sid: 'S' + i, token: login.token });
  }
  for (let i = 1; i <= 4; i++) {
    ctx.app.st.totes['T' + i] = { n: String(i), s: 'H', bs: ['B' + i] };
    ctx.app.st.barcodes['B' + i] = { p: 'P' + i, t: 'T' + i, pt: '1', pr: 1, s: 'H' };
  }
  recount(ctx.app.st);

  const offered = new Set();
  for (const { token } of stations) {
    const res = await ctx.fastify.inject({ method: 'GET', url: '/api/next-totes?n=1', headers: authHeader(token) });
    const tote = res.json().list[0].tote;
    assert.ok(!offered.has(tote), `tote ${tote} already offered`);
    offered.add(tote);
    await ctx.fastify.inject({ method: 'POST', url: '/api/scan', headers: authHeader(token), payload: { raw: tote } });
  }
  assert.equal(offered.size, 4);

  await ctx.cleanup();
});
