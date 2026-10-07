import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestServer, seedUser, loginStation, authHeader } from '../helpers/testServer.js';

const HDR = 'pid,barcode,status,condition,availability,scan_location,tote,tote_simplified,tote_number,partition,scanned_at,nexs_location\n';
const row = (pid, bc, tote, n) => `${pid},${bc},AVAILABLE,GOOD,NOT_FOUND,L,${tote},x,${n},1,2026-10-06 10:00:00,N\n`;
const csv = HDR
  + ['A1', 'A2', 'A3', 'A4', 'A5', 'A6'].map(b => row('PA', b, 'TL01', 1)).join('')
  + ['B1', 'B2', 'B3', 'B4', 'B5'].map(b => row('PB', b, 'TL02', 2)).join('')
  + ['C1', 'C2', 'C3', 'C4', 'C5'].map(b => row('PC', b, 'TL03', 3)).join('');

async function setup() {
  const ctx = makeTestServer();
  ctx.dumpService.load(csv, 'dump.csv');
  const s1 = await loginStation(ctx, 'S1', seedUser(ctx, { pin: '1111' }));
  const s2 = await loginStation(ctx, 'S2', seedUser(ctx, { pin: '2222' }));
  const next = async t => (await ctx.fastify.inject({ method: 'GET', url: '/api/next-totes?n=8', headers: authHeader(t.token) })).json();
  const scan = (t, raw) => ctx.fastify.inject({ method: 'POST', url: '/api/scan', headers: authHeader(t.token), payload: { raw } });
  return { ctx, s1, s2, next, scan };
}

test('two idle stations are offered different totes, and each keeps its own offer', async () => {
  const { ctx, s1, s2, next } = await setup();
  const a = (await next(s1)).list[0].tote;
  const b = (await next(s2)).list[0].tote;
  assert.notEqual(a, b, 'station 2 must not be told to scan the tote station 1 was just offered');
  assert.equal((await next(s1)).list[0].tote, a, 'station 1 keeps its tote on repeat polls');
  assert.equal((await next(s2)).list[0].tote, b);
  // the other station's tote is not in my queue
  assert.ok(!(await next(s1)).list.some(x => x.tote === b));
  await ctx.cleanup();
});

test('once a station opens a tote, its offer is released and is not shown to itself again', async () => {
  const { ctx, s1, s2, next, scan } = await setup();
  const a = (await next(s1)).list[0].tote;
  await scan(s1, a);                                  // station 1 opens its tote
  const forS2 = (await next(s2)).list.map(x => x.tote);
  assert.ok(!forS2.includes(a), 'an open tote is never offered');
  const forS1 = (await next(s1)).list.map(x => x.tote);
  assert.ok(!forS1.includes(a));
  await ctx.cleanup();
});

test('a station that opens a different tote than it was offered frees the offer for others', async () => {
  const { ctx, s1, s2, next, scan } = await setup();
  const a = (await next(s1)).list[0].tote;            // offered to station 1
  const other = (await next(s1)).list[1].tote;
  await scan(s1, other);                              // but it opened another one
  const forS2 = (await next(s2)).list.map(x => x.tote);
  assert.ok(forS2.includes(a), 'the unused offer is available to station 2 again');
  await ctx.cleanup();
});
