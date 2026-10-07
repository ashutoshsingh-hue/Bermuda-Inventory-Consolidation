/* ===== Bermuda Sort Station — auth middleware: Bearer token -> {user, role, station} ===== */
import { sendError } from './errors.js';

export function requireAuth(authService, roles) {
  return async (request, reply) => {
    const header = request.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    const session = authService.validate(token);
    if (!session) return sendError(reply, 401, 'Unauthorized — log in again');
    if (roles && !roles.includes(session.role)) return sendError(reply, 403, 'Forbidden');
    request.session = session;
  };
}
