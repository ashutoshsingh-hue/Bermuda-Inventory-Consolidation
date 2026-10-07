/* ===== Bermuda Sort Station — KPI summary ===== */
import { planCap } from './state.js';
import { outstanding, activePids } from './allocate.js';

export function summary(st) {
  const s = st.settings, plan = planCap(s); let used = 0, locUsed = 0, reservedOut = 0, planned = 0;
  for (const L of st.locations) {
    planned++; used += L.used; reservedOut += outstanding(L); if (L.used || activePids(L)) locUsed++;
  }
  let pend = 0, open = 0, done = 0, miss = 0;
  for (const t in st.totes) { const x = st.totes[t].s; if (x === 'H') pend++; else if (x === 'O') open++; else if (x === 'M') miss++; else done++; }
  let R = 0, C = 0, H = 0, N = 0, M = 0, p5 = 0;
  for (const p in st.pids) { const P = st.pids[p]; R += P.R; C += P.C; H += P.H; N += P.N; M += P.M || 0; if (P.R + P.C >= 5) p5++; }
  return { plannedLocs: planned, planCapTotal: planned * plan, used, reservedOut, locUsed, pend, open, done, miss, R, C, H, N, M, p5 };
}
