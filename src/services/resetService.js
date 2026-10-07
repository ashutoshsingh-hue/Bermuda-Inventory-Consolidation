/* ===== Bermuda Sort Station — admin "clear all results" =====
 * Wipes every inventory/result table (dump data, placements, events, loads, alerts, route
 * history) and reloads the in-memory state from the now-empty DB. Keeps users, sessions,
 * stations and settings (layout). A backup snapshot is taken first so it can be undone.
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadState } from '../db/load.js';
import { nowISO, shiftOf, checkDump, keepAisleStockOnly } from '../core/index.js';
import { backupOnce } from '../jobs/nightlyBackup.js';
import { config } from '../config.js';

const BACKUP_NAME = /^bermuda-[\w.-]+\.db$/;
const CLEAR_TABLES = ['barcodes', 'totes', 'pids', 'loc_pid', 'loads', 'route_history', 'alerts', 'events'];

export function createResetService({ app, db, persist, dumpService, backupsDir = config.backupsDir }) {
  async function clearAll(adminName) {
    const backup = await backupOnce(db, backupsDir);
    const counts = {};
    db.transaction(() => {
      for (const t of CLEAR_TABLES) counts[t] = db.prepare(`DELETE FROM ${t}`).run().changes;
      db.prepare('UPDATE locations SET used = 0').run();
      db.prepare('UPDATE stations SET open_tote = NULL, last_scan_barcode = NULL').run();
      db.prepare("DELETE FROM settings WHERE key = 'activeRoute'").run();
    })();
    app.st = loadState(db);
    persist.appendEvent({ ts: nowISO(new Date()), shift: shiftOf(new Date()), type: 'clear_all', operator: adminName, detail: counts });
    return { ok: true, cleared: counts, backup: path.basename(backup) };
  }
  // "Remove the current dump" with a backup saved first. Two ways to go on:
  //   fresh    = same as clearAll (nothing survives)
  //   continue = keep only what is physically in the aisles (state P); the next dump reconciles against it
  async function removeDump(adminName, mode) {
    if (mode === 'fresh') return clearAll(adminName);
    if (mode !== 'continue') return { ok: false, error: 'mode must be "continue" or "fresh"' };
    const backup = await backupOnce(db, backupsDir);
    const kept = keepAisleStockOnly(app.st);
    db.transaction(() => {
      for (const t of ['events', 'alerts', 'loads', 'route_history', 'pids']) db.prepare(`DELETE FROM ${t}`).run();
      db.prepare('UPDATE stations SET open_tote = NULL, last_scan_barcode = NULL').run();
      db.prepare("DELETE FROM settings WHERE key = 'activeRoute'").run();
      persist.persistFullSync(app.st);
    })();
    app.st = loadState(db);
    persist.appendEvent({ ts: nowISO(new Date()), shift: shiftOf(new Date()), type: 'remove_dump', operator: adminName, detail: { mode, ...kept } });
    return { ok: true, mode, kept, backup: path.basename(backup) };
  }

  // upload a new dump on top of a reset. The file is checked BEFORE anything is removed.
  async function startNewDump(adminName, mode, csvText, fileName) {
    const chk = checkDump(csvText);
    if (!chk.ok) return chk;
    const removed = await removeDump(adminName, mode);
    if (!removed.ok) return removed;
    const res = dumpService.load(csvText, fileName);
    return { ...res, removed };
  }

  // what the Dump tab shows: what is loaded now and which backups can be restored
  function dumpInfo() {
    const st = app.st, totes = {};
    for (const t in st.totes) totes[st.totes[t].s] = (totes[st.totes[t].s] || 0) + 1;
    let inAisles = 0, handedOver = 0;
    for (const b in st.barcodes) { const s = st.barcodes[b].s; if (s === 'P') inAisles++; else if (s === 'O') handedOver++; }
    const last = st.loads[st.loads.length - 1] || null;
    return { ok: true, lastLoad: last && { file: last.file, at: last.at }, loads: st.loads.length, totes, inAisles, handedOver, backups: listBackups() };
  }

  function listBackups() {
    if (!fs.existsSync(backupsDir)) return [];
    return fs.readdirSync(backupsDir).filter(f => BACKUP_NAME.test(f)).map(f => {
      const stat = fs.statSync(path.join(backupsDir, f));
      return { name: f, bytes: stat.size, at: stat.mtime.toISOString() };
    }).sort((a, b) => (a.at < b.at ? 1 : -1));
  }

  // put a saved backup back as the live data (dump + activity). Users/stations/layout stay as they are.
  async function restoreBackup(adminName, name) {
    if (!BACKUP_NAME.test(name || '')) return { ok: false, error: 'Not a backup file name' };
    const file = path.join(backupsDir, name);
    if (!fs.existsSync(file)) return { ok: false, error: 'Backup not found' };
    const safety = await backupOnce(db, backupsDir, { keep: 3 }); // current data stays recoverable; the next backup trims back to 2
    db.prepare('ATTACH DATABASE ? AS bk').run(file);
    try {
      const liveLocs = db.prepare('SELECT COUNT(*) AS n FROM main.locations').get().n;
      const bkLocs = db.prepare('SELECT COUNT(*) AS n FROM bk.locations').get().n;
      if (liveLocs !== bkLocs) return { ok: false, error: `Backup has ${bkLocs} locations but the layout now has ${liveLocs} - restore refused`, safety: path.basename(safety) };
      db.transaction(() => {
        for (const t of CLEAR_TABLES) {
          const bkCols = db.prepare(`PRAGMA bk.table_info(${t})`).all().map(c => c.name);
          const cols = db.prepare(`PRAGMA main.table_info(${t})`).all().map(c => c.name).filter(c => bkCols.includes(c));
          db.prepare(`DELETE FROM main.${t}`).run();
          db.prepare(`INSERT INTO main.${t} (${cols.join(',')}) SELECT ${cols.join(',')} FROM bk.${t}`).run();
        }
        db.prepare('UPDATE main.locations SET used = COALESCE((SELECT used FROM bk.locations b WHERE b.code = main.locations.code), 0)').run();
        db.prepare("UPDATE main.totes SET state = 'H', station_id = NULL, operator = NULL, opened_at = NULL WHERE state = 'O'").run();
        db.prepare('UPDATE main.stations SET open_tote = NULL, last_scan_barcode = NULL').run();
        db.prepare("DELETE FROM main.settings WHERE key = 'activeRoute'").run();
        db.prepare("INSERT INTO main.settings (key, value) SELECT key, value FROM bk.settings WHERE key = 'activeRoute'").run();
      })();
    } finally { db.exec('DETACH DATABASE bk'); }
    app.st = loadState(db);
    persist.appendEvent({ ts: nowISO(new Date()), shift: shiftOf(new Date()), type: 'restore_backup', operator: adminName, detail: { name } });
    return { ok: true, restored: name, safety: path.basename(safety) };
  }

  return { clearAll, removeDump, startNewDump, dumpInfo, restoreBackup };
}
