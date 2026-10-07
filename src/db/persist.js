/* ===== Bermuda Sort Station — write-through helpers (STRUCTURE.md §6) =====
 * Two modes:
 *  - persistDirty(): targeted writes driven by st._dirty (fast path: scan/undo/finish/handover).
 *  - persistFullSync(): wipes and rewrites totes/barcodes/pids/loc_pid/locations from the
 *    in-memory state (bulk path: dump load, pilot import — runs at most a few times a day).
 * Alerts and loads are append-only logs; callers pass the previous length so only the new
 * tail gets written.
 */
import { locByCode, nowISO } from '../core/index.js';

function parseCode(code) {
  const m = /^A(\d+)-T(\d+)-P(\d+)$/.exec(code);
  if (!m) throw new Error(`Bad location code: ${code}`);
  return { aisle: Number(m[1]), tote: Number(m[2]), part: Number(m[3]) };
}

export function createPersistence(db) {
  const stmt = {
    upsertLocation: db.prepare(`
      INSERT INTO locations (code, aisle, tote, part, is_overflow, used)
      VALUES (@code, @aisle, @tote, @part, @is_overflow, @used)
      ON CONFLICT(code) DO UPDATE SET used = excluded.used`),
    deleteLocPidForPid: db.prepare('DELETE FROM loc_pid WHERE pid = ?'),
    insertLocPid: db.prepare('INSERT INTO loc_pid (location_code, pid, placed, reserved) VALUES (?, ?, ?, ?)'),
    upsertPid: db.prepare(`
      INSERT INTO pids (pid, r, c, h, n, m) VALUES (@pid, @r, @c, @h, @n, @m)
      ON CONFLICT(pid) DO UPDATE SET r=excluded.r, c=excluded.c, h=excluded.h, n=excluded.n, m=excluded.m`),
    upsertTote: db.prepare(`
      INSERT INTO totes (tote_id, tote_number, state, load_id, station_id, operator, shift, opened_at, closed_at)
      VALUES (@tote_id, @tote_number, @state, @load_id, @station_id, @operator, @shift, @opened_at, @closed_at)
      ON CONFLICT(tote_id) DO UPDATE SET tote_number=excluded.tote_number, state=excluded.state, load_id=excluded.load_id,
        station_id=excluded.station_id, operator=excluded.operator, shift=excluded.shift,
        opened_at=excluded.opened_at, closed_at=excluded.closed_at`),
    upsertBarcode: db.prepare(`
      INSERT INTO barcodes (barcode, pid, tote_id, partition, processable, state, location_code, placed_at, placed_station, placed_shift, nf_at, ho_at)
      VALUES (@barcode, @pid, @tote_id, @partition, @processable, @state, @location_code, @placed_at, @placed_station, @placed_shift, @nf_at, @ho_at)
      ON CONFLICT(barcode) DO UPDATE SET pid=excluded.pid, tote_id=excluded.tote_id, partition=excluded.partition,
        processable=excluded.processable, state=excluded.state, location_code=excluded.location_code,
        placed_at=excluded.placed_at, placed_station=excluded.placed_station, placed_shift=excluded.placed_shift,
        nf_at=excluded.nf_at, ho_at=excluded.ho_at`),
    upsertStation: db.prepare(`
      INSERT INTO stations (id, name, active, current_operator, open_tote, last_scan_barcode, last_seen)
      VALUES (@id, @id, 1, @current_operator, @open_tote, @last_scan_barcode, @last_seen)
      ON CONFLICT(id) DO UPDATE SET current_operator=excluded.current_operator, open_tote=excluded.open_tote,
        last_scan_barcode=excluded.last_scan_barcode, last_seen=excluded.last_seen`),
    insertEvent: db.prepare(`
      INSERT INTO events (ts, shift, station_id, operator, type, open_tote, input_raw, barcode, result, location_code, pid, detail)
      VALUES (@ts, @shift, @station_id, @operator, @type, @open_tote, @input_raw, @barcode, @result, @location_code, @pid, @detail)`),
    insertAlert: db.prepare('INSERT INTO alerts (ts, type, message) VALUES (@ts, @type, @message)'),
    insertLoad: db.prepare(`
      INSERT INTO loads (id, file_name, loaded_at, loaded_by, rows, new_totes, refreshed, skipped_taken, conflicts)
      VALUES (@id, @file_name, @loaded_at, @loaded_by, @rows, @new_totes, @refreshed, @skipped_taken, @conflicts)
      ON CONFLICT(id) DO NOTHING`),
    upsertSetting: db.prepare(`
      INSERT INTO settings (key, value) VALUES (@key, @value)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`),
    insertRouteHistory: db.prepare(`
      INSERT INTO route_history (id, status, created_at, started_at, created_by, tote_ids, projected)
      VALUES (@id, @status, @created_at, @started_at, @created_by, @tote_ids, @projected)`),
    completeRouteHistory: db.prepare(`
      UPDATE route_history SET status = 'completed', completed_at = @completed_at, actual = @actual WHERE id = @id`),
    deleteAllLocPid: db.prepare('DELETE FROM loc_pid'),
    deleteAllTotes: db.prepare('DELETE FROM totes'),
    deleteAllBarcodes: db.prepare('DELETE FROM barcodes'),
    deleteAllPids: db.prepare('DELETE FROM pids'),
    deleteAllLocations: db.prepare('DELETE FROM locations'),
  };

  function saveLocation(st, code) {
    const L = locByCode(st, code); if (!L) return;
    const { aisle, tote, part } = parseCode(code);
    // is_overflow is vestigial: the overflow concept was removed (PLAN.md §5.5); the column
    // stays in schema.sql only because load.js never reads it back, so dropping it would need
    // an unforced CHECK-style table rebuild for zero benefit — always write 0 going forward.
    stmt.upsertLocation.run({ code, aisle, tote, part, is_overflow: 0, used: L.used });
  }

  function savePidLocations(st, p) {
    stmt.deleteLocPidForPid.run(p);
    const P = st.pids[p]; if (!P) return;
    for (const code in P.locs) {
      const L = locByCode(st, code), e = L.pids[p]; if (!e) continue;
      stmt.insertLocPid.run(code, p, e.c, e.r);
    }
  }

  function savePid(st, p) {
    const P = st.pids[p];
    if (!P) { stmt.deleteLocPidForPid.run(p); return; }
    stmt.upsertPid.run({ pid: p, r: P.R, c: P.C, h: P.H, n: P.N, m: P.M || 0 });
    savePidLocations(st, p);
  }

  function saveTote(st, id) {
    const T = st.totes[id]; if (!T) return;
    stmt.upsertTote.run({
      tote_id: id, tote_number: T.n ?? null, state: T.s, load_id: T.load ?? null,
      station_id: T.station ?? null, operator: T.operator ?? null, shift: T.shift ?? null,
      opened_at: T.openedAt ?? null, closed_at: T.closedAt ?? null,
    });
  }

  function saveBarcode(st, b) {
    const B = st.barcodes[b]; if (!B) return;
    stmt.upsertBarcode.run({
      barcode: b, pid: B.p, tote_id: B.t ?? null, partition: B.pt ?? null,
      processable: B.pr ? 1 : 0, state: B.s, location_code: B.l ?? null,
      placed_at: B.s === 'P' ? (B.ts ?? null) : null, placed_station: B.st ?? null,
      placed_shift: B.sh ?? null, nf_at: B.nfAt ?? null, ho_at: B.hoAt ?? null,
    });
  }

  function saveStation(st, sid) {
    const ss = st.stations[sid]; if (!ss) return;
    stmt.upsertStation.run({
      id: sid, current_operator: ss.operator ?? null, open_tote: ss.openTote ?? null,
      last_scan_barcode: ss.lastScan ? ss.lastScan.b : null, last_seen: nowISO(new Date()),
    });
  }

  function saveSettings(st) {
    stmt.upsertSetting.run({ key: 'settings', value: JSON.stringify(st.settings) });
  }

  // generic key/value settings (not the core layout settings above) — e.g. the dump/auto-sync mode toggle
  function getSetting(key, fallback = null) {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    if (!row) return fallback;
    try { return JSON.parse(row.value); } catch { return fallback; }
  }
  function setSetting(key, value) {
    stmt.upsertSetting.run({ key, value: JSON.stringify(value) });
  }

  function appendEvent(evt) {
    stmt.insertEvent.run({
      ts: evt.ts, shift: evt.shift ?? null, station_id: evt.station ?? null, operator: evt.operator ?? null,
      type: evt.type, open_tote: evt.openTote ?? null, input_raw: evt.inputRaw ?? null, barcode: evt.barcode ?? null,
      result: evt.result ?? null, location_code: evt.location ?? null, pid: evt.pid ?? null,
      detail: evt.detail ? JSON.stringify(evt.detail) : null,
    });
  }

  // append-only: pass the array and the length it had before the mutation
  function appendNewAlerts(st, fromLen) {
    for (let i = fromLen; i < st.alerts.length; i++) {
      const a = st.alerts[i];
      stmt.insertAlert.run({ ts: a.ts, type: a.type, message: a.msg });
    }
  }
  function appendNewLoads(st, fromLen) {
    for (let i = fromLen; i < st.loads.length; i++) {
      const l = st.loads[i];
      stmt.insertLoad.run({
        id: l.id, file_name: l.file ?? null, loaded_at: l.at, loaded_by: l.by ?? null,
        rows: l.rows, new_totes: l.newTotes, refreshed: l.refreshed,
        skipped_taken: l.skippedTaken ?? 0, conflicts: l.conflicts ?? 0,
      });
    }
  }

  // targeted write, driven by st._dirty — the interactive path (scan/undo/finish/handover)
  function persistDirty(st) {
    const d = st._dirty;
    for (const code of d.locations) saveLocation(st, code);
    for (const id of d.totes) saveTote(st, id);
    for (const b of d.barcodes) saveBarcode(st, b);
    for (const p of d.pids) savePid(st, p);
    for (const sid of d.stations) saveStation(st, sid);
  }

  // full rebuild including the location set itself — only a layout change actually alters
  // which location codes exist (a settings change can shrink aisles/totes/partitions and
  // leave stale rows otherwise, since persistFullSync below only ever updates existing codes)
  function persistLayoutChange(st) {
    const tx = db.transaction(() => {
      stmt.deleteAllLocations.run();
      for (const L of st.locations) saveLocation(st, L.code);
      stmt.deleteAllLocPid.run();
      for (const p in st.pids) { stmt.upsertPid.run({ pid: p, r: st.pids[p].R, c: st.pids[p].C, h: st.pids[p].H, n: st.pids[p].N, m: st.pids[p].M || 0 }); savePidLocations(st, p); }
      saveSettings(st);
    });
    tx();
  }

  // bulk rewrite, driven by the full in-memory state — dump load / pilot import
  function persistFullSync(st) {
    const tx = db.transaction(() => {
      for (const L of st.locations) saveLocation(st, L.code);
      stmt.deleteAllLocPid.run();
      for (const p in st.pids) { stmt.upsertPid.run({ pid: p, r: st.pids[p].R, c: st.pids[p].C, h: st.pids[p].H, n: st.pids[p].N, m: st.pids[p].M || 0 }); savePidLocations(st, p); }
      stmt.deleteAllTotes.run();
      for (const id in st.totes) saveTote(st, id);
      stmt.deleteAllBarcodes.run();
      for (const b in st.barcodes) saveBarcode(st, b);
    });
    tx();
  }

  function insertRouteHistory(row) {
    stmt.insertRouteHistory.run({
      id: row.id, status: row.status, created_at: row.created_at, started_at: row.started_at ?? null,
      created_by: row.created_by ?? null, tote_ids: row.tote_ids, projected: row.projected,
    });
  }
  function completeRouteHistory(id, completedAt, actual) {
    stmt.completeRouteHistory.run({ id, completed_at: completedAt, actual });
  }

  return {
    saveLocation, savePid, saveTote, saveBarcode, saveStation, saveSettings, getSetting, setSetting,
    appendEvent, appendNewAlerts, appendNewLoads, persistDirty, persistFullSync, persistLayoutChange,
    insertRouteHistory, completeRouteHistory,
  };
}
