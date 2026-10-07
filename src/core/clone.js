/* ===== Bermuda Sort Station — state cloning for sandboxed simulation =====
 * structuredClone() is required, not JSON.parse(JSON.stringify()): st._dirty holds Sets
 * (see state.js), and a JSON round-trip would silently turn them into plain objects, breaking
 * the next touch() call. st._idx/st._coldCursor are plain data and clone fine either way.
 */
export function cloneState(st) {
  return structuredClone(st);
}
