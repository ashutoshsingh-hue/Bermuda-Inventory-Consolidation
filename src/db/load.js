/* ===== Bermuda Sort Station — DB -> in-memory state at boot (STRUCTURE.md §4) =====
 * R/C/H/N are NOT trusted from the `pids` table on load — they're rebuilt from `barcodes`
 * via core.recount(), which is the same check the admin "recount" action re-runs live.
 * A station's `lastScan` (undo) does not survive a restart: only the barcode id is stored,
 * not the previous-state needed to revert it safely, so undo is a same-process convenience.
 */
import { newState, recount, pid, locByCode, activateRoute } from '../core/index.js';

export function loadState(db) {
  const settingsRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('settings');
  const st = newState(settingsRow ? JSON.parse(settingsRow.value) : undefined);

  for (const row of db.prepare('SELECT code, used FROM locations').all()) {
    const L = locByCode(st, row.code); if (L) L.used = row.used;
  }
  for (const row of db.prepare('SELECT location_code, pid, placed, reserved FROM loc_pid').all()) {
    const L = locByCode(st, row.location_code); if (!L) continue;
    L.pids[row.pid] = { c: row.placed, r: row.reserved };
    pid(st, row.pid).locs[row.location_code] = 1;
  }
  for (const row of db.prepare('SELECT * FROM totes').all()) {
    st.totes[row.tote_id] = {
      n: row.tote_number, s: row.state, bs: [], load: row.load_id, station: row.station_id,
      operator: row.operator, shift: row.shift, openedAt: row.opened_at, closedAt: row.closed_at,
    };
  }
  for (const row of db.prepare('SELECT * FROM barcodes').all()) {
    st.barcodes[row.barcode] = {
      p: row.pid, t: row.tote_id, pt: row.partition, pr: row.processable, s: row.state,
      l: row.location_code || undefined, ts: row.placed_at || undefined, sh: row.placed_shift || undefined,
      st: row.placed_station || undefined, nfAt: row.nf_at || undefined, hoAt: row.ho_at || undefined,
    };
    if (row.tote_id && st.totes[row.tote_id]) st.totes[row.tote_id].bs.push(row.barcode);
  }
  for (const row of db.prepare('SELECT * FROM loads ORDER BY id').all()) {
    st.loads.push({
      id: row.id, file: row.file_name, at: row.loaded_at, rows: row.rows, newTotes: row.new_totes, refreshed: row.refreshed,
      skippedTaken: row.skipped_taken, conflicts: row.conflicts,
    });
  }
  for (const row of db.prepare('SELECT id, open_tote, current_operator FROM stations').all()) {
    st.stations[row.id] = { openTote: row.open_tote || null, lastScan: null, operator: row.current_operator || null };
  }

  recount(st);

  // rebuild the active batch's routeR fresh from barcode states, same as a running server
  // does on startRoute() — never persisted directly (PLAN.md §6)
  const activeRoute = db.prepare("SELECT tote_ids FROM route_history WHERE status = 'active' ORDER BY id DESC LIMIT 1").get();
  if (activeRoute) activateRoute(st, JSON.parse(activeRoute.tote_ids));

  return st;
}
