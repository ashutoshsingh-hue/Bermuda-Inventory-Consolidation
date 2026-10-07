import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { recount } from '../../src/core/index.js';
import { makeTestServer, seedUser, loginStation, authHeader } from '../helpers/testServer.js';

// the mode field must come BEFORE the file in the multipart body (fastify-multipart reads fields in order)
function upload(filename, content, mode) {
  const boundary = '----nd' + Math.random().toString(16).slice(2);
  const modePart = mode ? `--${boundary}\r\nContent-Disposition: form-data; name="mode"\r\n\r\n${mode}\r\n` : '';
  const body = `${modePart}--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: text/csv\r\n\r\n${content}\r\n--${boundary}--\r\n`;
  return { payload: body, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

const HDR = 'pid,barcode,status,condition,availability,scan_location,tote,tote_simplified,tote_number,partition,scanned_at,nexs_location\n';
const row = (pid, bc, tote, n) => `${pid},${bc},AVAILABLE,GOOD,NOT_FOUND,L,${tote},x,${n},1,2026-10-06 10:00:00,N\n`;
// PA has 8 barcodes in total so it is a "big" PID and PB has 5, both worth placing
const csv1 = HDR + ['B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8'].map(b => row('PA', b, 'TL01', 1)).join('') + ['C1', 'C2', 'C3', 'C4', 'C5'].map(b => row('PB', b, 'TL02', 2)).join('');
// the next day's dump: PID Hunter still lists TL01 (not removed) and adds TL03
const csv2 = csv1 + ['D1', 'D2'].map(b => row('PC', b, 'TL03', 3)).join('');

async function setup() {
  const ctx = makeTestServer();
  const admin = await loginStation(ctx, 'ADMIN1', seedUser(ctx, { role: 'admin', pin: '9999' }));
  const op = await loginStation(ctx, 'S1', seedUser(ctx, { pin: '1111' }));
  const post = (url, token, payload) => ctx.fastify.inject({ method: 'POST', url, headers: authHeader(token), payload });
  const up = (token, name, content, mode) => { const u = upload(name, content, mode); return ctx.fastify.inject({ method: 'POST', url: '/api/dump', headers: { ...authHeader(token), ...u.headers }, payload: u.payload }); };
  assert.equal((await up(admin.token, 'dump-2026-10-06.csv', csv1)).statusCode, 200);
  // operator opens TL01 and places B1, B2, then finishes (the other barcodes become not-found)
  await post('/api/scan', op.token, { raw: 'TL01' });
  await post('/api/scan', op.token, { raw: 'B1' });
  await post('/api/scan', op.token, { raw: 'B2' });
  await post('/api/tote/finish', op.token, undefined);
  return { ctx, admin, op, post, up, st: () => ctx.app.st };
}
const count = (st, s) => Object.values(st.barcodes).filter(b => b.s === s).length;

test('continue — keeps only what is in the aisles; old totes, history and not-found are removed', async () => {
  const { ctx, admin, post, st } = await setup();
  assert.equal(count(st(), 'P'), 2);
  const r = await post('/api/dump/remove', admin.token, { mode: 'continue' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().kept.keptBarcodes, 2);
  assert.ok(fs.readdirSync(path.join(ctx.db.name, '..', 'backups')).some(f => f.startsWith('bermuda-')), 'a backup was saved first');
  assert.deepEqual(Object.keys(st().totes), []);
  assert.deepEqual(Object.keys(st().barcodes).sort(), ['B1', 'B2']);
  assert.equal(st().pids.PA.C, 2);
  assert.equal(st().loads.length, 0);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM totes').get().n, 0);
  assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM barcodes WHERE state = 'P'").get().n, 2);
  await ctx.cleanup();
});

test('continue + new dump — barcodes in the aisles are deducted, everything else comes back as waiting', async () => {
  const { ctx, admin, up, st } = await setup();
  const r = await up(admin.token, 'dump-next.csv', csv2, 'continue');
  assert.equal(r.statusCode, 200);
  const body = r.json();
  assert.equal(body.alreadySorted, 2);          // B1, B2 are physically in the aisles
  assert.equal(count(st(), 'P'), 2);
  assert.equal(st().barcodes.B3.s, 'H');        // old not-found / unplaced: waiting again, NOT deducted
  assert.equal(st().pids.PA.C, 2);
  assert.equal(st().pids.PA.R, 6);              // 8 in the new dump - 2 already in the aisles
  assert.equal(st().totes.TL01.s, 'H');
  assert.equal(Object.keys(st().totes).length, 3);
  await ctx.cleanup();
});

test('continue + new dump with EMPTY aisles — nothing is deducted (handed-over history is not subtracted)', async () => {
  const { ctx, admin, up, st } = await setup();
  for (const b of ['B1', 'B2']) st().barcodes[b].s = 'O'; // handed over: the aisle is empty now
  recount(st());
  const body = (await up(admin.token, 'dump-next.csv', csv2, 'continue')).json();
  assert.equal(body.alreadySorted, 0);
  assert.equal(count(st(), 'P'), 0);
  assert.equal(st().pids.PA.R, 8);
  assert.equal(st().barcodes.B1.s, 'H');
  await ctx.cleanup();
});

test('fresh + new dump — nothing survives, even what was in the aisles', async () => {
  const { ctx, admin, up, st } = await setup();
  const body = (await up(admin.token, 'dump-next.csv', csv2, 'fresh')).json();
  assert.equal(body.alreadySorted, 0);
  assert.equal(count(st(), 'P'), 0);
  assert.equal(st().pids.PA.R, 8);
  await ctx.cleanup();
});

test('a bad file is refused BEFORE anything is removed', async () => {
  const { ctx, admin, up, st } = await setup();
  const r = await up(admin.token, 'bad.csv', 'a,b,c\n1,2,3\n', 'continue');
  assert.equal(r.statusCode, 400);
  assert.equal(count(st(), 'P'), 2);
  assert.ok(st().totes.TL02);
  await ctx.cleanup();
});

test('only an admin can replace the dump; a lead can still merge', async () => {
  const { ctx, op, up } = await setup();
  const lead = await loginStation(ctx, 'LEAD1', seedUser(ctx, { role: 'lead', pin: '8888' }));
  assert.equal((await up(lead.token, 'x.csv', csv2, 'continue')).statusCode, 403);
  assert.equal((await up(lead.token, 'x.csv', csv2)).statusCode, 200);
  assert.equal((await ctx.fastify.inject({ method: 'POST', url: '/api/dump/remove', headers: authHeader(op.token), payload: { mode: 'fresh' } })).statusCode, 403);
  await ctx.cleanup();
});

test('restore — a backup brings the dump and activity back', async () => {
  const { ctx, admin, post, st } = await setup();
  await post('/api/dump/remove', admin.token, { mode: 'fresh' });
  assert.equal(Object.keys(st().barcodes).length, 0);
  const info = (await ctx.fastify.inject({ method: 'GET', url: '/api/dump/info', headers: authHeader(admin.token) })).json();
  assert.equal(info.backups.length, 1);
  const r = await post('/api/backup/restore', admin.token, { name: info.backups[0].name });
  assert.equal(r.statusCode, 200);
  assert.equal(count(st(), 'P'), 2);
  assert.ok(st().totes.TL02);
  assert.equal(st().pids.PA.C, 2);
  assert.equal((await post('/api/backup/restore', admin.token, { name: '../x.db' })).statusCode, 400);
  await ctx.cleanup();
});
