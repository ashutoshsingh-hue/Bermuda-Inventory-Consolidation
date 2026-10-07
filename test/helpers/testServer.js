/* ===== Bermuda Sort Station — shared test harness: isolated DB + fastify.inject() ===== */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildServer } from '../../src/server.js';

export function makeTestServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bermuda-api-'));
  const dbPath = path.join(dir, 'test.db');
  const ctx = buildServer(dbPath, { logger: false, backupsDir: path.join(dir, 'backups') });
  ctx.cleanup = async () => { await ctx.fastify.close(); fs.rmSync(dir, { recursive: true, force: true }); };
  return ctx;
}

let seq = 0;
export function seedUser(ctx, { name, role = 'operator', pin = '1234' } = {}) {
  const n = name || `User${++seq}`;
  ctx.authService.createUser({ name: n, role, pin });
  return { name: n, pin };
}

export async function loginStation(ctx, station, user) {
  const res = await ctx.fastify.inject({ method: 'POST', url: '/api/login', payload: { station, name: user.name, pin: user.pin } });
  return res.json();
}

export function authHeader(token) { return { authorization: `Bearer ${token}` }; }
