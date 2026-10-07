/* ===== Bermuda Sort Station — one-time import of the pilot's backup JSON (PLAN.md §2, §9) =====
 * The pilot (Bermuda_Sort_Station.html) runs the exact core logic in PLAN.md Appendix A, so its
 * "Settings -> Download backup" is expected to be a JSON dump of that same Core state shape
 * (settings/locations/barcodes/totes/pids/loads/alerts, plus a single global openTote/lastScan
 * this build replaces with per-station state). This has not yet been verified against a real
 * pilot backup file — do that before relying on it for the floor migration.
 *
 * A tote left open in the pilot has no owning station in the new multi-station system, so it
 * is reset to waiting ('H') on import: already-placed/handed-over/not-found barcodes are kept
 * exactly as scanned, and the tote just re-enters the shared recommend() pool for pickup.
 */
import { newState, recount, locByCode, pid } from '../core/index.js';

export function importPilotBackup(json) {
  if (!json || typeof json !== 'object') throw new Error('Not a valid backup file');
  // 'settings' is not required — a missing/undefined value falls back to defaultSettings()
  const required = ['locations', 'barcodes', 'totes', 'pids'];
  const missing = required.filter(k => !(k in json));
  if (missing.length) throw new Error('Backup is missing: ' + missing.join(', '));

  const st = newState(json.settings);

  for (const L of json.locations || []) {
    const dst = locByCode(st, L.code); if (!dst) continue;
    dst.used = L.used || 0;
    for (const p in (L.pids || {})) {
      dst.pids[p] = { c: L.pids[p].c || 0, r: L.pids[p].r || 0 };
      pid(st, p).locs[L.code] = 1;
    }
  }
  for (const id in (json.totes || {})) {
    const T = json.totes[id];
    st.totes[id] = T.s === 'O'
      ? { ...T, s: 'H', station: undefined, openedAt: undefined }
      : { ...T };
  }
  for (const b in (json.barcodes || {})) st.barcodes[b] = { ...json.barcodes[b] };

  st.loads = Array.isArray(json.loads) ? json.loads.map(l => ({ ...l })) : [];
  st.alerts = Array.isArray(json.alerts) ? json.alerts.map(a => ({ ...a })) : [];

  recount(st); // rebuilds R/C/H/N from the imported barcodes (source of truth)
  return st;
}
