import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../src/db/migrate.js';
import { createAuthService } from '../../src/services/authService.js';

function makeAuth() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bermuda-auth-'));
  const db = openDb(path.join(dir, 'test.db'));
  return { db, auth: createAuthService(db), cleanup: () => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('createUser — rejects a duplicate name with a clean error, not a raw SQLite constraint error', () => {
  const { auth, cleanup } = makeAuth();
  auth.createUser({ name: 'Alice', role: 'operator', pin: '1111' });
  assert.throws(() => auth.createUser({ name: 'Alice', role: 'operator', pin: '2222' }), /already exists/);
  cleanup();
});

test('createUser — rejects an invalid role', () => {
  const { auth, cleanup } = makeAuth();
  assert.throws(() => auth.createUser({ name: 'Bob', role: 'superuser', pin: '1111' }), /role must be one of/);
  cleanup();
});

test('listUsers — never exposes pin_hash, reflects active as a real boolean', () => {
  const { auth, cleanup } = makeAuth();
  auth.createUser({ name: 'Alice', role: 'operator', pin: '1111' });
  const users = auth.listUsers();
  assert.equal(users.length, 1);
  assert.equal(users[0].name, 'Alice');
  assert.equal(users[0].active, true);
  assert.equal('pin_hash' in users[0], false);
  cleanup();
});

test('deactivateUser — blocks future login and immediately kills existing sessions', () => {
  const { auth, cleanup } = makeAuth();
  auth.createUser({ name: 'Alice', role: 'operator', pin: '1111' });
  const { token } = auth.login({ name: 'Alice', pin: '1111', stationId: 'S1' });
  assert.ok(auth.validate(token));

  const alice = auth.listUsers().find(u => u.name === 'Alice');
  const result = auth.deactivateUser(alice.id);
  assert.equal(result.ok, true);

  assert.equal(auth.validate(token), null); // existing session killed
  assert.equal(auth.login({ name: 'Alice', pin: '1111', stationId: 'S1' }), null); // can't log back in
  cleanup();
});

test('deactivateUser — refuses to remove the last active admin', () => {
  const { auth, cleanup } = makeAuth();
  auth.createUser({ name: 'OnlyAdmin', role: 'admin', pin: '1234' });
  const admin = auth.listUsers().find(u => u.name === 'OnlyAdmin');
  const result = auth.deactivateUser(admin.id);
  assert.equal(result.ok, false);
  assert.match(result.error, /last active admin/);
  assert.equal(auth.listUsers().find(u => u.id === admin.id).active, true);
  cleanup();
});

test('deactivateUser — allows removing an admin when another active admin remains', () => {
  const { auth, cleanup } = makeAuth();
  auth.createUser({ name: 'Admin1', role: 'admin', pin: '1234' });
  auth.createUser({ name: 'Admin2', role: 'admin', pin: '5678' });
  const a1 = auth.listUsers().find(u => u.name === 'Admin1');
  const result = auth.deactivateUser(a1.id);
  assert.equal(result.ok, true);
  cleanup();
});

test('reactivateUser — restores login access', () => {
  const { auth, cleanup } = makeAuth();
  auth.createUser({ name: 'Alice', role: 'operator', pin: '1111' });
  const alice = auth.listUsers().find(u => u.name === 'Alice');
  auth.deactivateUser(alice.id);
  assert.equal(auth.login({ name: 'Alice', pin: '1111', stationId: 'S1' }), null);

  const result = auth.reactivateUser(alice.id);
  assert.equal(result.ok, true);
  assert.ok(auth.login({ name: 'Alice', pin: '1111', stationId: 'S1' }));
  cleanup();
});

test('reactivateUser — unknown id reports an error', () => {
  const { auth, cleanup } = makeAuth();
  const result = auth.reactivateUser(9999);
  assert.equal(result.ok, false);
  cleanup();
});
