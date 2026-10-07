/* ===== Bermuda Sort Station — handover log: quantity released/processed, read off the events table =====
 * Every release writes an events row (release_location per location+PID, release_all, release for AT RISK,
 * and legacy 'handover' rows from the old Confirm button), each carrying the quantity in detail.given
 * (release_all: detail.totalGiven). Read-only: nothing here changes stock.
 */
const TYPES = ['release_location', 'release_all', 'release', 'handover'];
const LABEL = { release_location: 'Release', release_all: 'Release ALL', release: 'At-risk release', handover: 'Handover (old)' };

function qtyOf(d) { return Number(d?.given ?? d?.totalGiven ?? 0) || 0; }

export function createHandoverLogService({ db }) {
  // from/to are YYYY-MM-DD (inclusive, local time like every events.ts); omitted = all
  function entries(from, to) {
    const where = [`type IN (${TYPES.map(() => '?').join(',')})`], args = [...TYPES];
    if (from) { where.push('ts >= ?'); args.push(from + ' 00:00:00'); }
    if (to) { where.push('ts <= ?'); args.push(to + ' 23:59:59'); }
    const out = [];
    for (const e of db.prepare(`SELECT id, ts, shift, operator, type, location_code, pid, detail FROM events WHERE ${where.join(' AND ')} ORDER BY id DESC`).all(...args)) {
      let d = null; try { d = e.detail ? JSON.parse(e.detail) : null; } catch { /* keep null */ }
      if (d?.many) continue; // aggregate-only row, superseded by per-row events
      out.push({ id: e.id, ts: e.ts, shift: e.shift, operator: e.operator, type: e.type, kind: LABEL[e.type], location: e.location_code, pid: e.pid, qty: qtyOf(d) });
    }
    return out;
  }

  function list({ from, to, limit = 500 } = {}) {
    const all = entries(from, to);
    const pids = new Set(all.filter(x => x.pid).map(x => x.pid));
    const byDay = {};
    for (const x of all) { const day = x.ts.slice(0, 10); byDay[day] = (byDay[day] || 0) + x.qty; }
    return {
      totalQty: all.reduce((n, x) => n + x.qty, 0), entries: all.length, pids: pids.size,
      byDay: Object.entries(byDay).sort((a, b) => b[0].localeCompare(a[0])).map(([day, qty]) => ({ day, qty })),
      rows: all.slice(0, limit), truncated: all.length > limit,
    };
  }

  return { list, entries };
}
