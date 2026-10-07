/* ===== Bermuda Sort Station — uniform error responses (STRUCTURE.md §2) ===== */
export function sendError(reply, code, message) {
  reply.code(code).send({ ok: false, error: message });
}
