/* ===== Bermuda Sort Station — login (station + name + PIN), sessions, roles, users (PLAN.md §6, §9) =====
 * PINs are hashed with scrypt (salt:hash hex, no extra dependency) — adequate for an
 * internal-LAN floor tool, not a public-facing auth system.
 * "Delete" is a soft delete (active=0): it blocks login and immediately kills any existing
 * sessions, but keeps the row so past events/exports attributed to that name stay meaningful.
 */
import crypto from 'node:crypto';

const SESSION_HOURS = 12; // comfortably covers one 8h shift plus handover overlap
const ROLES = new Set(['admin', 'lead', 'operator']);

function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pin), salt, 32).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPin(pin, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const check = crypto.scryptSync(String(pin), salt, 32);
  const expected = Buffer.from(hash, 'hex');
  return check.length === expected.length && crypto.timingSafeEqual(check, expected);
}

export function createAuthService(db) {
  function createUser({ name, role, pin }) {
    if (!name || !pin) throw new Error('name and pin are required');
    if (!ROLES.has(role)) throw new Error(`role must be one of ${[...ROLES].join(', ')}`);
    if (db.prepare('SELECT id FROM users WHERE name = ?').get(name)) throw new Error('A user with that name already exists');
    const info = db.prepare('INSERT INTO users (name, role, pin_hash, active) VALUES (?, ?, ?, 1)').run(name, role, hashPin(pin));
    return { id: info.lastInsertRowid, name, role, active: true };
  }

  function login({ name, pin, stationId }) {
    const user = db.prepare('SELECT * FROM users WHERE name = ? AND active = 1').get(name);
    if (!user || !verifyPin(pin, user.pin_hash)) return null;
    const token = crypto.randomUUID();
    const now = new Date(), expires = new Date(now.getTime() + SESSION_HOURS * 3600 * 1000);
    db.prepare('INSERT INTO sessions (token, user_id, station_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
      .run(token, user.id, stationId, now.toISOString(), expires.toISOString());
    return { token, user: { id: user.id, name: user.name, role: user.role } };
  }

  function validate(token) {
    if (!token) return null;
    const row = db.prepare(`
      SELECT sessions.token AS token, sessions.station_id AS stationId, sessions.expires_at AS expiresAt,
             users.id AS userId, users.name AS name, users.role AS role
      FROM sessions JOIN users ON users.id = sessions.user_id
      WHERE sessions.token = ? AND users.active = 1`).get(token);
    if (!row) return null;
    if (new Date(row.expiresAt).getTime() < Date.now()) return null;
    return row;
  }

  function logout(token) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  }

  function listUsers() {
    return db.prepare('SELECT id, name, role, active FROM users ORDER BY name').all().map(u => ({ ...u, active: !!u.active }));
  }

  function activeAdminCount() {
    return db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1").get().n;
  }

  // "delete": deactivates (blocks login, kills existing sessions), never a hard DELETE —
  // refuses if this would leave zero active admins, so the panel can never lock everyone out.
  function deactivateUser(id) {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!user) return { ok: false, error: 'Unknown user' };
    if (user.role === 'admin' && user.active && activeAdminCount() <= 1) {
      return { ok: false, error: 'Cannot delete the last active admin account' };
    }
    db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    return { ok: true };
  }

  function reactivateUser(id) {
    const res = db.prepare('UPDATE users SET active = 1 WHERE id = ?').run(id);
    return res.changes > 0 ? { ok: true } : { ok: false, error: 'Unknown user' };
  }

  return { createUser, login, validate, logout, listUsers, deactivateUser, reactivateUser };
}
