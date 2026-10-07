/* ===== Bermuda Sort Station — layout settings (aisles/totes/partitions/capacity) =====
 * Mirrors the pilot's rule exactly: the physical layout can only change before anything has
 * been placed, since every placed barcode's location is a real physical spot under the
 * CURRENT layout — changing aisles/totes/partitions afterward would invalidate it. Barcodes,
 * totes, pids, loads and alerts are untouched; only the location array is rebuilt and each
 * pid's location associations are cleared (all safe because, by the lock check, nothing was
 * actually placed anywhere yet).
 */
import { buildLocations } from './state.js';

const INT_FIELDS = ['aisles', 'totesPerAisle', 'lastAisleTotes', 'partitions', 'cap', 'softPidCap', 'batchSize'];
const PCT_FIELDS = ['headroomPct', 'autoCloseSharePct'];
// eligibility (PLAN.md §5.1): which status/availability values from a dump row count as
// processable — moved out of dump.js's hard-coded set so it's editable without a code change
const ARRAY_FIELDS = ['processableStatus', 'processableAvailability'];

export function locationsInUse(st) {
  return st.locations.some(L => L.used > 0 || Object.keys(L.pids).length > 0);
}

export function validateLayoutSettings(input) {
  const errors = [];
  const out = {};
  for (const k of INT_FIELDS) {
    const n = Number(input[k]);
    if (!Number.isInteger(n) || n < 1) errors.push(`${k} must be a positive whole number`);
    out[k] = n;
  }
  for (const k of PCT_FIELDS) {
    const n = Number(input[k]);
    if (!Number.isFinite(n) || n < 0 || n > 100) errors.push(`${k} must be a number between 0 and 100`);
    out[k] = n;
  }
  for (const k of ARRAY_FIELDS) {
    const v = input[k];
    if (!Array.isArray(v) || v.length === 0 || !v.every(s => typeof s === 'string' && s.length > 0 && s === s.toUpperCase())) {
      errors.push(`${k} must be a non-empty array of uppercase strings`);
    }
    out[k] = v;
  }
  return errors.length ? { ok: false, errors } : { ok: true, settings: out };
}

export function updateLayoutSettings(st, newSettings) {
  if (locationsInUse(st)) return { ok: false, error: 'Locked — barcodes are already placed. Layout can only change before anything is placed.' };
  st.settings = newSettings;
  st.locations = buildLocations(newSettings);
  delete st._idx;
  for (const p in st.pids) st.pids[p].locs = {};
  return { ok: true, settings: newSettings };
}
