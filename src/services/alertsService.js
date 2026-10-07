/* ===== Bermuda Sort Station — alerts list/resolve (PLAN.md §9) =====
 * Alerts are an append-only audit log (persist.appendNewAlerts); resolving one is metadata
 * (who/when), not a state change core needs to know about, so this talks to the DB directly.
 */
export function createAlertsService({ db }) {
  function list({ unresolvedOnly = false } = {}) {
    const sql = unresolvedOnly
      ? 'SELECT * FROM alerts WHERE resolved_at IS NULL ORDER BY id DESC'
      : 'SELECT * FROM alerts ORDER BY id DESC';
    return db.prepare(sql).all();
  }

  function resolve(id, resolvedBy) {
    const row = db.prepare('SELECT id FROM alerts WHERE id = ?').get(id);
    if (!row) return null;
    db.prepare('UPDATE alerts SET resolved_by = ?, resolved_at = ? WHERE id = ?').run(resolvedBy, new Date().toISOString(), id);
    return db.prepare('SELECT * FROM alerts WHERE id = ?').get(id);
  }

  return { list, resolve };
}
