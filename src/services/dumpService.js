/* ===== Bermuda Sort Station — PID Hunter dump upload (PLAN.md §4, §9) =====
 * Runs loadDump() against the live state, then does a bulk resync to the DB (persistFullSync)
 * rather than trying to diff a load that can touch thousands of rows in one go. A dump load
 * happens at most twice a day, so the extra write cost is irrelevant against its own budget
 * (§10: "dump load plus recount under 10s"), unlike the per-scan interactive path.
 */
import { loadDump, preloadStock, recount } from '../core/index.js';
import { importPilotBackup } from './importPilot.js';

export function createDumpService({ app, persist, db }) {
  function load(csvText, fileName) {
    const alertsBefore = app.st.alerts.length, loadsBefore = app.st.loads.length;
    const res = loadDump(app.st, csvText, fileName, new Date());
    if (!res.ok) return res;
    recount(app.st);
    db.transaction(() => {
      persist.persistFullSync(app.st);
      persist.appendNewAlerts(app.st, alertsBefore);
      persist.appendNewLoads(app.st, loadsBefore);
    })();
    return res;
  }

  // disaster recovery (PLAN.md §2): upload what's already in the aisles BEFORE the main dump
  function preload(csvText, fileName) {
    const alertsBefore = app.st.alerts.length;
    const res = preloadStock(app.st, csvText, fileName, new Date());
    if (!res.ok) return res;
    db.transaction(() => {
      persist.persistFullSync(app.st);
      persist.appendNewAlerts(app.st, alertsBefore);
    })();
    return res;
  }

  // one-time: bring in the single-station pilot's backup JSON (PLAN.md §2)
  function importPilot(jsonText) {
    let json;
    try { json = JSON.parse(jsonText); } catch { return { ok: false, error: 'Not valid JSON' }; }
    let imported;
    try { imported = importPilotBackup(json); } catch (err) { return { ok: false, error: err.message }; }
    app.st = imported;
    persist.persistFullSync(app.st);
    return { ok: true, pids: Object.keys(app.st.pids).length, barcodes: Object.keys(app.st.barcodes).length, totes: Object.keys(app.st.totes).length };
  }

  return { load, preload, importPilot };
}
