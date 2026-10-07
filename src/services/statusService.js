/* ===== Bermuda Sort Station — KPIs, aisle fill map, live station board (PLAN.md §6, §9) ===== */
import { summary, nowISO, capacityForecast } from '../core/index.js';

const IDLE_MINUTES = 10;

export function createStatusService({ app, db, persist }) {
  function aisleMap() {
    return app.st.locations.map(L => ({
      code: L.code, used: L.used, cap: app.st.settings.cap, pidCount: Object.values(L.pids).filter(e => e.c > 0).length, // PIDs with barcodes actually placed here; reservations are not shown
    }));
  }

  function stationBoard() {
    const hourAgo = nowISO(new Date(Date.now() - 3600 * 1000));
    const scanCounts = Object.fromEntries(
      db.prepare("SELECT station_id AS sid, COUNT(*) AS n FROM events WHERE type = 'scan' AND ts >= ? GROUP BY station_id").all(hourAgo)
        .map(r => [r.sid, r.n]),
    );
    const now = Date.now();
    return db.prepare('SELECT * FROM stations ORDER BY name').all().map(row => {
      const lastSeenMs = row.last_seen ? Date.parse(row.last_seen.replace(' ', 'T')) : null;
      const idleMinutes = lastSeenMs ? Math.round((now - lastSeenMs) / 60000) : null;
      return {
        id: row.id, name: row.name, active: !!row.active, operator: row.current_operator,
        openTote: row.open_tote, openToteN: row.open_tote ? (app.st.totes[row.open_tote]?.n ?? null) : null, lastSeen: row.last_seen, scansLastHour: scanCounts[row.id] || 0,
        idle: idleMinutes !== null && idleMinutes >= IDLE_MINUTES,
      };
    });
  }

  function full() {
    return {
      summary: summary(app.st), aisleMap: aisleMap(), stations: stationBoard(), forecast: capacityForecast(app.st),
      activeRoute: persist.getSetting('activeRoute', null),
    };
  }

  // cheap (no summary()/DB): operator screens poll this every couple of seconds. A route tote
  // counts as done once it is closed ('C'); waiting/open/missing totes are still outstanding.
  function routeProgress() {
    const r = persist.getSetting('activeRoute', null);
    if (!r) return { route: null };
    const total = r.toteIds.length;
    let done = 0;
    for (const t of r.toteIds) if (app.st.totes[t]?.s === 'C') done++;
    return { route: { id: r.id, total, done } };
  }

  return { aisleMap, stationBoard, full, routeProgress };
}
