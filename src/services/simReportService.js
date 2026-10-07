/* ===== Bermuda Sort Station — tote/operator assignment report (verifies no cross-station clash) =====
 * Reads straight off totes/barcodes/events; no core state involved, since this is presentation
 * over history the app has already recorded, not a decision the running state needs to make.
 */
export function createSimReportService({ db }) {
  function toteAssignments() {
    const rows = db.prepare(`
      SELECT t.tote_id, t.tote_number, t.state, t.station_id, t.operator, t.shift, t.opened_at, t.closed_at,
             COUNT(b.barcode) AS total,
             SUM(CASE WHEN b.state = 'P' THEN 1 ELSE 0 END) AS placed,
             SUM(CASE WHEN b.state = 'X' THEN 1 ELSE 0 END) AS aside,
             SUM(CASE WHEN b.state = 'N' THEN 1 ELSE 0 END) AS notFound
      FROM totes t LEFT JOIN barcodes b ON b.tote_id = t.tote_id
      WHERE t.station_id IS NOT NULL
      GROUP BY t.tote_id
      ORDER BY t.closed_at, t.opened_at
    `).all();
    return rows.map(r => ({
      tote: r.tote_id, n: r.tote_number, state: r.state, station: r.station_id, operator: r.operator,
      openedAt: r.opened_at, closedAt: r.closed_at, total: r.total, placed: r.placed, aside: r.aside, notFound: r.notFound,
    }));
  }

  // a real clash is a station trying to open a tote another station already has open — scan.js
  // logs that exact attempt as a result='error' event with "Tote open at Station X" in its detail,
  // so its presence (or absence) is the authoritative record, not an inference from the totes
  // table's single current owner (which only ever remembers whoever holds/held it, not rivals)
  function clashAttempts() {
    return db.prepare(`
      SELECT ts AS at, station_id AS blockedStation, operator, barcode AS contestedTote, detail
      FROM events WHERE result = 'error' AND detail LIKE '%Tote open at Station%'
      ORDER BY ts
    `).all();
  }

  function summary() {
    const assignments = toteAssignments();
    const byStation = {};
    for (const a of assignments) {
      const s = byStation[a.station] || (byStation[a.station] = { station: a.station, operator: a.operator, totes: 0, placed: 0, aside: 0, notFound: 0 });
      s.totes++; s.placed += a.placed; s.aside += a.aside; s.notFound += a.notFound;
    }
    return {
      stations: Object.values(byStation),
      totalTotes: assignments.length,
      clashes: clashAttempts(),
      assignments,
    };
  }

  // wipes this report's own history only: tote/operator/shift/open-close attribution and
  // logged clash attempts. Never touches barcode state, pid counts or locations — a tote's
  // real sort state (H/O/C/M) and everything already placed/handed-over stays exactly as is,
  // this just forgets *who* worked which tote, same as a fresh install's report would show.
  function clearReport() {
    // never touch a tote that's currently open (state='O') — it's mid-scan right now, and
    // clearing its attribution here would just be overwritten by the live in-memory value on
    // its next write anyway, so skipping it avoids a confusing moment where the report and the
    // tote's own in-progress state disagree
    const totes = db.prepare(`UPDATE totes SET station_id = NULL, operator = NULL, shift = NULL, opened_at = NULL, closed_at = NULL WHERE station_id IS NOT NULL AND state != 'O'`).run();
    const clashes = db.prepare(`DELETE FROM events WHERE result = 'error' AND detail LIKE '%Tote open at Station%'`).run();
    return { ok: true, totesCleared: totes.changes, clashesCleared: clashes.changes };
  }

  return { toteAssignments, clashAttempts, summary, clearReport };
}
