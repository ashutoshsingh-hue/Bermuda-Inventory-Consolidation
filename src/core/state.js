/* ===== Bermuda Sort Station — state & settings (pure, no DOM/HTTP/DB) ===== */

export function defaultSettings() {
  return {
    // 3*20*4 = 240 locations on the 60-tote rack (PLAN.md §5.5, rev. 03-Oct-2026), hard cap,
    // no overflow. lastAisleTotes lets the final aisle be shorter than the rest if ever needed.
    aisles: 3, totesPerAisle: 20, lastAisleTotes: 20, partitions: 4,
    cap: 100, headroomPct: 5, softPidCap: 20,
    autoCloseSharePct: 90, // evaluateTotes(): a waiting tote this much already-sorted gets auto-closed
    batchSize: 50, // default Route size (PLAN.md §6 "Batch operation")
    // eligibility (PLAN.md §5.1): a dump row is processable when its status is in
    // processableStatus AND its availability is in processableAvailability
    processableStatus: ['AVAILABLE'],
    processableAvailability: ['NOT_FOUND', 'NOT_FOUND_HOLD', 'AVAILABLE'],
  };
}

export const planCap = s => Math.floor(s.cap * (1 - s.headroomPct / 100));

// Tote numbers run continuously across the whole rack (owner, 06-Oct-2026): with 3 aisles x 20 totes
// that is A1 = T01-T20, A2 = T21-T40, A3 = T41-T60 — matching the physical tote labels 1..60.
export function buildLocations(s) {
  const locs = [];
  let first = 1; // first tote number of the current aisle
  for (let a = 1; a <= s.aisles; a++) {
    const totes = a === s.aisles ? s.lastAisleTotes : s.totesPerAisle;
    for (let t = 0; t < totes; t++)
      for (let p = 1; p <= s.partitions; p++)
        locs.push({ code: `A${a}-T${String(first + t).padStart(2, '0')}-P${p}`, used: 0, pids: {} });
    first += totes;
  }
  return locs;
}

// per-station scratch: which tote a station has open, and its last scan (for undo)
export function stationState(st, sid) {
  return st.stations[sid] || (st.stations[sid] = { openTote: null, lastScan: null });
}

export function newState(settings) {
  const s = settings || defaultSettings();
  return {
    v: 1, settings: s, locations: buildLocations(s), barcodes: {}, totes: {}, pids: {},
    loads: [], log: [], alerts: [], stations: {},
    // rows touched since the caller last cleared this (see touch()/clearDirty()) — lets a
    // persistence layer write exactly what changed instead of diffing the whole state.
    _dirty: { locations: new Set(), totes: new Set(), barcodes: new Set(), pids: new Set(), stations: new Set() },
  };
}

export function touch(st, kind, key) { st._dirty[kind].add(key); }
export function clearDirty(st) { for (const k in st._dirty) st._dirty[k].clear(); }

export function pid(st, p) { return st.pids[p] || (st.pids[p] = { R: 0, C: 0, H: 0, N: 0, M: 0, locs: {} }); }

export const locByCode = (st, code) => st._idx
  ? st.locations[st._idx[code]]
  : (st._idx = Object.fromEntries(st.locations.map((l, i) => [l.code, i])), st.locations[st._idx[code]]);

// recompute R/C/H/N/M counts from barcodes (processable only)
// M = in a tote marked NOT FOUND (physically un-locatable) — distinct from N (not found at finish)
export function recount(st) {
  for (const p in st.pids) { const P = st.pids[p]; P.R = P.C = P.H = P.N = P.M = 0; }
  for (const b in st.barcodes) {
    const B = st.barcodes[b]; if (!B.pr) continue; const P = pid(st, B.p);
    if (B.s === 'H') P.R++; else if (B.s === 'P') P.C++; else if (B.s === 'O') P.H++; else if (B.s === 'N') P.N++; else if (B.s === 'M') P.M++;
  }
}
