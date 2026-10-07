/* Create a user without the admin UI (needed once, to make the first admin on a fresh database).
   Usage:  node tools/createUser.js <name> <admin|lead|operator> <pin>
   Safe while the server runs (SQLite WAL). Add further people later in /admin -> Users. */
import { buildApp } from '../src/server.js';

const [name, role, pin] = process.argv.slice(2);
if (!name || !role || !pin) {
  console.error('Usage: node tools/createUser.js <name> <admin|lead|operator> <pin>');
  process.exit(1);
}
const ctx = buildApp();
try {
  console.log('Created:', ctx.authService.createUser({ name, role, pin }));
} catch (err) {
  console.error('Failed:', err.message);
  process.exitCode = 1;
} finally {
  ctx.db.close();
}
