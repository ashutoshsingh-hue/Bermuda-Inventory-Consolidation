/* ===== Bermuda Sort Station — PID / location / barcode lookup (PLAN.md §9) ===== */
import { pidInfo } from '../core/index.js';

export function createLookupService({ app }) {
  function lookup(q) {
    const query = String(q || '').trim().toUpperCase();
    if (!query) return { ok: false, error: 'q is required' };
    if (app.st.pids[query]) return { ok: true, kind: 'pid', pid: pidInfo(app.st, query) };
    const loc = app.st.locations.find(l => l.code === query);
    if (loc) return { ok: true, kind: 'location', location: { code: loc.code, used: loc.used, cap: app.st.settings.cap, pids: loc.pids } };
    const B = app.st.barcodes[query];
    if (B) return { ok: true, kind: 'barcode', barcode: { code: query, pid: B.p, tote: B.t, partition: B.pt, processable: !!B.pr, state: B.s, location: B.l || null } };
    return { ok: false, error: 'Not found' };
  }
  return { lookup };
}
