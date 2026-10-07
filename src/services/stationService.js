/* ===== Bermuda Sort Station — station registry (PLAN.md §6 "Stations are data, not code") =====
 * Login auto-registers a station id the first time it's used, so the floor can run before
 * anyone visits the admin screen — add/rename/deactivate below just upsert the same row.
 */
import { stationState } from '../core/index.js';

export function createStationService({ db, app, persist }) {
  function ensureStation(id, name) {
    const row = db.prepare('SELECT id, name FROM stations WHERE id = ?').get(id);
    if (!row) db.prepare('INSERT INTO stations (id, name, active) VALUES (?, ?, 1)').run(id, name || id);
    else if (name && name !== row.name) db.prepare('UPDATE stations SET name = ? WHERE id = ?').run(name, id);
  }

  function setOperator(id, operatorName) {
    stationState(app.st, id).operator = operatorName;
    persist.saveStation(app.st, id);
  }

  // better-sqlite3 returns INTEGER columns as JS numbers — coerce active to a real boolean
  const mapStation = row => row && { ...row, active: !!row.active };

  function list() {
    return db.prepare('SELECT * FROM stations ORDER BY name').all().map(mapStation);
  }

  function add(id, name) {
    if (db.prepare('SELECT id FROM stations WHERE id = ?').get(id)) throw new Error('Station already exists');
    db.prepare('INSERT INTO stations (id, name, active) VALUES (?, ?, 1)').run(id, name || id);
    return mapStation(db.prepare('SELECT * FROM stations WHERE id = ?').get(id));
  }

  function rename(id, name) {
    const res = db.prepare('UPDATE stations SET name = ? WHERE id = ?').run(name, id);
    if (res.changes === 0) return null;
    return mapStation(db.prepare('SELECT * FROM stations WHERE id = ?').get(id));
  }

  function setActive(id, active) {
    const res = db.prepare('UPDATE stations SET active = ? WHERE id = ?').run(active ? 1 : 0, id);
    if (res.changes === 0) return null;
    return mapStation(db.prepare('SELECT * FROM stations WHERE id = ?').get(id));
  }

  return { ensureStation, setOperator, list, add, rename, setActive };
}
