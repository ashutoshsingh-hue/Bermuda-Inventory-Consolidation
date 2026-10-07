/* ===== Bermuda Sort Station — CSV exports, UTF-8 BOM (PLAN.md §9, STRUCTURE.md §8) ===== */
import { missingTotes } from '../core/index.js';
import { createHandoverLogService } from './handoverLogService.js';

const BOM = '﻿';

function csvField(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function toCsv(rows) {
  return BOM + rows.map(row => row.map(csvField).join(',')).join('\r\n') + '\r\n';
}

function parseCode(code) {
  const m = /^A(\d+)-T(\d+)-P(\d+)$/.exec(code);
  return m ? { aisle: m[1], tote: m[2], part: m[3] } : { aisle: '', tote: '', part: '' };
}

export function createExportService({ app, db }) {
  function locationsCsv() {
    const rows = [['location', 'aisle', 'tote', 'partition', 'used', 'pid', 'placed', 'reserved']];
    for (const L of app.st.locations) {
      const { aisle, tote, part } = parseCode(L.code);
      const pids = Object.keys(L.pids);
      if (!pids.length) { rows.push([L.code, aisle, tote, part, L.used, '', '', '']); continue; }
      for (const p of pids) rows.push([L.code, aisle, tote, part, L.used, p, L.pids[p].c, L.pids[p].r]);
    }
    return toCsv(rows);
  }

  function notFoundCsv() {
    const rows = [['barcode', 'pid', 'tote', 'partition', 'not_found_at']];
    for (const b in app.st.barcodes) {
      const B = app.st.barcodes[b];
      if (B.s === 'N') rows.push([b, B.p, B.t, B.pt, B.nfAt]);
    }
    return toCsv(rows);
  }

  function eventsCsv() {
    const rows = [['ts', 'shift', 'station', 'operator', 'type', 'open_tote', 'input_raw', 'barcode', 'result', 'location', 'pid', 'detail']];
    for (const e of db.prepare('SELECT * FROM events ORDER BY id').all()) {
      rows.push([e.ts, e.shift, e.station_id, e.operator, e.type, e.open_tote, e.input_raw, e.barcode, e.result, e.location_code, e.pid, e.detail]);
    }
    return toCsv(rows);
  }

  function handoverLogCsv({ from, to } = {}) {
    const rows = [['time', 'shift', 'by', 'type', 'location', 'pid', 'qty_processed']];
    for (const x of createHandoverLogService({ db }).entries(from, to).reverse()) rows.push([x.ts, x.shift, x.operator, x.kind, x.location, x.pid, x.qty]);
    return toCsv(rows);
  }

  function missingTotesCsv() {
    const rows = [['tote_number', 'tote_id', 'barcodes', 'processable', 'pids_affected', 'marked_at', 'reason']];
    for (const x of missingTotes(app.st)) rows.push([x.n, x.tote, x.barcodes, x.processable, x.pids, x.at, x.reason]);
    return toCsv(rows);
  }

  // what's currently placed, for the preload recovery flow's "download current aisle stock" step
  function aisleStockCsv() {
    const rows = [['location', 'pid', 'barcode', 'tote']];
    const entries = [];
    for (const b in app.st.barcodes) { const B = app.st.barcodes[b]; if (B.s === 'P') entries.push([B.l, B.p, b, B.t]); }
    entries.sort((x, y) => x[0].localeCompare(y[0]) || x[1].localeCompare(y[1]));
    rows.push(...entries);
    return toCsv(rows);
  }

  return { locationsCsv, notFoundCsv, eventsCsv, handoverLogCsv, missingTotesCsv, aisleStockCsv };
}
