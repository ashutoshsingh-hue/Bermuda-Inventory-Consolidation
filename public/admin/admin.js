/* ===== Bermuda Sort Station — admin screen wiring ===== */
import { apiFetch, login, getToken, getStation, getRole, clearSession, onUnauthorized } from '../shared/api.js';

// Only admin (and lead, if ever used again) belong on this screen — an operator who ends up
// here would otherwise see every tab render, then get 403s from nearly every button, which
// is a confusing dead end. Gate it right at login instead.
const ADMIN_PANEL_ROLES = new Set(['admin', 'lead']);

const loginView = document.getElementById('login-view');
const appView = document.getElementById('app-view');
const stationIdEl = document.getElementById('station-id');
const nameEl = document.getElementById('name');
const pinEl = document.getElementById('pin');
const loginBtn = document.getElementById('login-btn');
const loginError = document.getElementById('login-error');
const logoutBtn = document.getElementById('logout-btn');

function showApp() {
  loginView.classList.add('hidden'); appView.classList.remove('hidden');
  document.querySelectorAll('.admin-only').forEach(el => el.classList.toggle('hidden', getRole() !== 'admin'));
  refreshActiveTab();
}
function showLogin() { appView.classList.add('hidden'); loginView.classList.remove('hidden'); }
onUnauthorized(() => {
  if (loginView.classList.contains('hidden')) { clearSession(); showLogin(); loginError.textContent = 'Session expired — log in again.'; }
});

loginBtn.addEventListener('click', async () => {
  loginError.textContent = '';
  const station = stationIdEl.value.trim(), name = nameEl.value.trim(), pin = pinEl.value.trim();
  if (!station || !name || !pin) { loginError.textContent = 'Fill in all three fields.'; return; }
  const r = await login(station, name, pin);
  if (!r.ok) { loginError.textContent = r.error || 'Login failed'; return; }
  if (!ADMIN_PANEL_ROLES.has(r.user.role)) {
    clearSession();
    loginError.textContent = `${r.user.name} is an operator account — use the station scan screen instead.`;
    return;
  }
  showApp();
});
logoutBtn.addEventListener('click', () => { clearSession(); showLogin(); });

// ---------- tabs ----------
const tabButtons = [...document.querySelectorAll('.tabs button')];
tabButtons.forEach(btn => btn.addEventListener('click', () => {
  tabButtons.forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('panel-' + btn.dataset.tab).classList.add('active');
  refreshActiveTab();
}));
function activeTab() { return tabButtons.find(b => b.classList.contains('active'))?.dataset.tab; }
function refreshActiveTab() {
  const tab = activeTab();
  if (tab === 'status') loadStatus();
  if (tab === 'route') loadRoute();
  if (tab === 'dump') loadDumpInfo();
  if (tab === 'recovery') loadMissing();
  if (tab === 'handover') loadHandover();
  if (tab === 'hlog') loadHandoverLog();
  if (tab === 'stations') loadUsers();
  if (tab === 'settings') loadLayout();
}

// ---------- status ----------
async function loadStatus() {
  const r = await apiFetch('/api/status');
  if (!r.ok) return;
  const kpis = document.getElementById('kpis');
  const s = r.summary;
  kpis.innerHTML = ['R', 'C', 'H', 'N', 'M', 'p5'].map(k => `<div class="kpi"><div class="n">${s[k]}</div><div class="l">${labelFor(k)}</div></div>`).join('')
    + `<div class="kpi"><div class="n">${s.used}/${s.planCapTotal}</div><div class="l">planned used/cap</div></div>`
    + `<div class="kpi"><div class="n">${s.pend}/${s.open}/${s.done}</div><div class="l">totes waiting/open/done</div></div>`
    + `<div class="kpi"><div class="n">${s.miss}</div><div class="l">totes not found</div></div>`;

  const board = document.getElementById('station-board');
  // active stations only; an idle station that still holds an open tote stays listed so it can be released
  const shown = r.stations.filter(st => !st.idle || st.openTote);
  const isAdmin = getRole() === 'admin';
  board.innerHTML = shown.map(st => `<tr class="${st.idle ? 'idle' : ''}">
    <td>${st.name}</td><td>${st.operator || ''}</td><td>${st.openToteN ?? st.openTote ?? ''}</td>
    <td>${st.scansLastHour}</td><td>${st.lastSeen || ''}</td>
    <td>${st.openTote && isAdmin ? `<button class="danger" data-release="${st.openTote}" data-n="${st.openToteN ?? st.openTote}" data-station="${st.name}">Release tote</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="6">No active stations</td></tr>';

  document.getElementById('aisle-map').innerHTML = buildRackHtml(r.aisleMap);
  loadStationSummary();
  loadAlerts();
}

document.getElementById('station-board').addEventListener('click', async e => {
  const btn = e.target.closest('button[data-release]'); if (!btn) return;
  const msg = document.getElementById('station-board-msg');
  if (!window.confirm(`Release tote ${btn.dataset.n} from station ${btn.dataset.station}? It goes back to waiting and the operator's open tote is cleared. Barcodes already placed stay placed.`)) return;
  const r = await apiFetch(`/api/tote/${encodeURIComponent(btn.dataset.release)}/release`, { method: 'POST' });
  msg.textContent = r.ok ? `Tote ${btn.dataset.n} released.` : (r.error || 'Release failed');
  msg.className = r.ok ? 'msg ok' : 'msg error';
  loadStatus();
});

// Physical rack layout: each aisle is two shelf rows sharing the same columns
// (column N holds "Tote N" on the top shelf and the next tote number down on the
// bottom shelf), each tote split into a 2x2 grid of its 4 partitions.
function buildRackHtml(aisleMap) {
  const byAisle = {};
  for (const L of aisleMap) {
    const m = /^A(\d+)-T(\d+)-P(\d+)$/.exec(L.code);
    if (!m) continue;
    const [, a, t, p] = m;
    ((byAisle[a] ||= {})[t] ||= {})[p] = L;
  }
  const aisleKeys = Object.keys(byAisle).sort((x, y) => Number(x) - Number(y));
  return aisleKeys.map(a => {
    const totes = byAisle[a];
    // keys are zero-padded ("01".."22", matching the T01/T02 location codes) — sort
    // numerically but keep the original padded string as the lookup key
    const toteKeys = Object.keys(totes).sort((x, y) => Number(x) - Number(y));
    const half = Math.ceil(toteKeys.length / 2);
    const row = keys => `<div class="rack-row">${keys.map(t => rackTote(t, totes[t])).join('')}</div>`;
    return `<div class="rack-aisle"><div class="rack-aisle-title">Aisle ${a}</div>${row(toteKeys.slice(0, half))}${row(toteKeys.slice(half))}</div>`;
  }).join('');
}
function rackTote(toteKey, partitions) {
  const cells = [1, 2, 3, 4].map(p => {
    const L = partitions[p];
    if (!L) return '<div class="rack-cell"></div>';
    const pct = L.cap ? Math.min(100, Math.round((L.used / L.cap) * 100)) : 0;
    const over = L.used >= L.cap;
    return `<div class="rack-cell${over ? ' over' : ''}" title="${L.code}: ${L.used} of ${L.cap} barcodes · ${L.pidCount} PID${L.pidCount === 1 ? '' : 's'}">
      <div class="rack-cell-fill" style="height:${pct}%"></div><div class="rack-cell-num">${p}</div>
    </div>`;
  }).join('');
  return `<div class="rack-tote"><div class="rack-tote-label">Tote ${Number(toteKey)}</div><div class="rack-partitions">${cells}</div></div>`;
}
function labelFor(k) { return { R: 'in totes', C: 'in aisles', H: 'handed over', N: 'not found', M: 'in missing totes', p5: 'PIDs >= 5' }[k]; }

// ---------- route planner ----------
let proposedRoute = null; // { number, toteIds, ... } from the last /api/route/propose call

function kpiHtml(pairs) { return pairs.map(([n, l]) => `<div class="kpi"><div class="n">${n}</div><div class="l">${l}</div></div>`).join(''); }

function renderActiveRoute(active) {
  document.getElementById('route-active-card').classList.remove('hidden');
  document.getElementById('route-active-kpis').innerHTML = kpiHtml([
    [`Route ${active.number ?? active.id}`, 'active'], [active.toteIds.length, 'totes in route'],
    [active.createdBy || '', 'started by'], [active.startedAt || '', 'started at'],
  ]);
}

function renderProposedRoute(route) {
  proposedRoute = route;
  document.getElementById('route-propose-title').textContent = `Route ${route.number}`;
  document.getElementById('route-propose-summary').textContent = route.toteIds.length
    ? `${route.toteIds.length} totes` : 'no waiting totes left';
  document.getElementById('route-propose-kpis').innerHTML = kpiHtml([
    [route.toteIds.length, 'totes in this route'], [route.waitingTotes, 'totes waiting in total'], [route.roundsLeft, 'rounds left'],
  ]);
  document.getElementById('route-tote-table').innerHTML = route.totes.map((t, i) => `<tr>
    <td>${i + 1}</td><td>${t.n ?? t.tote}</td><td>${t.barcodes}</td><td>${t.processable}</td></tr>`).join('') || '<tr><td colspan="4">No totes</td></tr>';
  document.getElementById('route-upcoming-table').innerHTML = route.upcoming.map(u => `<tr>
    <td>Route ${u.number}</td><td>${u.toteCount}</td><td>${u.firstTote}</td><td>${u.lastTote}</td></tr>`).join('') || '<tr><td colspan="4">Nothing after this route</td></tr>';
  document.getElementById('route-start-btn').classList.toggle('hidden', !route.toteIds.length);
}

async function loadRoute() {
  const activeR = await apiFetch('/api/route/active');
  const hasActive = activeR.ok && !!activeR.active;
  document.getElementById('route-active-card').classList.toggle('hidden', !hasActive);
  if (hasActive) renderActiveRoute(activeR.active);
  document.getElementById('route-propose-card').classList.toggle('hidden', hasActive);
  if (!hasActive) loadProposal();
  loadRouteHistory();
}
async function loadProposal() {
  const r = await apiFetch('/api/route/propose');
  if (r.ok) renderProposedRoute(r.route);
}
document.getElementById('route-propose-btn').addEventListener('click', loadProposal);
document.getElementById('route-start-btn').addEventListener('click', async () => {
  const msg = document.getElementById('route-propose-msg');
  if (!proposedRoute) return;
  const r = await apiFetch('/api/route/start', { method: 'POST', body: JSON.stringify({ toteIds: proposedRoute.toteIds }) });
  if (!r.ok) { msg.textContent = r.error || 'Failed to start route'; msg.className = 'msg error'; return; }
  msg.textContent = 'Route started.'; msg.className = 'msg ok';
  proposedRoute = null;
  loadRoute();
});
document.getElementById('route-complete-btn').addEventListener('click', async () => {
  if (!window.confirm('Mark the active route complete? This records the final numbers and lets a new route be proposed.')) return;
  const msg = document.getElementById('route-complete-msg');
  const statusR = await apiFetch('/api/status');
  const actual = statusR.ok ? { endingLocations: statusR.summary.locUsed } : {};
  const r = await apiFetch('/api/route/complete', { method: 'POST', body: JSON.stringify(actual) });
  msg.textContent = r.ok ? 'Route completed.' : (r.error || 'Failed');
  msg.className = 'msg ' + (r.ok ? 'ok' : 'error');
  loadRoute();
});
async function loadRouteHistory() {
  const r = await apiFetch('/api/route/history');
  if (!r.ok) return;
  document.getElementById('route-history-table').innerHTML = r.routes.map(x => `<tr>
    <td>Route ${x.id}</td><td>${x.status}</td><td>${x.toteIds.length}</td>
    <td>${x.createdAt || ''}</td><td>${x.completedAt || ''}</td>
  </tr>`).join('') || '<tr><td colspan="5">No routes yet</td></tr>';
}
document.getElementById('route-history-refresh-btn').addEventListener('click', loadRouteHistory);

// ---------- dump (upload / remove / backups) ----------
const fmtBytes = n => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB';
const dumpMode = () => document.querySelector('input[name="dump-mode"]:checked').value;
let dumpInfo = null;

async function loadDumpInfo() {
  const r = await apiFetch('/api/dump/info');
  if (!r.ok) return;
  dumpInfo = r;
  const t = r.totes, n = k => t[k] || 0;
  document.getElementById('dump-info-kpis').innerHTML = kpiHtml([
    [n('H'), 'totes waiting'], [n('O'), 'totes open'], [n('C'), 'totes done'], [r.inAisles, 'barcodes in aisles'], [r.handedOver, 'barcodes handed over'],
  ]);
  document.getElementById('dump-info-text').textContent = r.lastLoad
    ? `Last dump: ${r.lastLoad.file} (loaded ${r.lastLoad.at}). ${r.loads} load(s) since the data was last cleared.`
    : 'No dump loaded.';
  document.getElementById('dump-backups-table').innerHTML = r.backups.map(b => `<tr>
    <td>${b.name}</td><td>${b.at.replace('T', ' ').slice(0, 19)}</td><td>${fmtBytes(b.bytes)}</td>
    <td><button class="secondary" data-restore="${b.name}">Restore</button></td></tr>`).join('') || '<tr><td colspan="4">No backups yet</td></tr>';
}

document.getElementById('dump-upload-btn').addEventListener('click', async () => {
  const fileEl = document.getElementById('dump-file');
  const msg = document.getElementById('dump-msg'), report = document.getElementById('dump-report');
  if (!fileEl.files.length) { msg.textContent = 'Choose a CSV file first'; msg.className = 'msg error'; return; }
  const mode = dumpMode();
  if (mode !== 'merge') {
    const what = mode === 'continue'
      ? `This removes the old dump and all activity, but keeps the ${dumpInfo ? dumpInfo.inAisles : '?'} barcodes now in the aisles.`
      : 'This removes EVERYTHING, including what is in the aisles.';
    if (!window.confirm(`${what} A backup is saved first. Continue?`)) return;
  }
  msg.textContent = 'Uploading...'; msg.className = 'msg';
  const form = new FormData();
  form.append('mode', mode); // must come before the file
  form.append('file', fileEl.files[0]);
  const res = await fetch('/api/dump', { method: 'POST', headers: { Authorization: `Bearer ${getToken()}` }, body: form });
  const body = await res.json();
  if (!res.ok) { msg.textContent = body.error || 'Upload failed'; msg.className = 'msg error'; return; }
  msg.textContent = body.removed ? `Loaded. Old data removed first (backup ${body.removed.backup}).` : 'Loaded.'; msg.className = 'msg ok';
  report.textContent = JSON.stringify(body, null, 2);
  loadDumpInfo();
});

// ---------- aisle stock: move what is on the racks to a new site (POST /api/preload) ----------
document.getElementById('aislestock-download-btn').addEventListener('click', async () => {
  const res = await fetch('/api/export/aislestock.csv', { headers: { Authorization: `Bearer ${getToken()}` } });
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url; a.download = 'aislestock.csv'; a.click();
  URL.revokeObjectURL(url);
});

document.getElementById('aislestock-upload-btn').addEventListener('click', async () => {
  const fileEl = document.getElementById('aislestock-file');
  const msg = document.getElementById('aislestock-msg'), report = document.getElementById('aislestock-report');
  if (!fileEl.files.length) { msg.textContent = 'Choose the aisle stock CSV first'; msg.className = 'msg error'; return; }
  if (!window.confirm('Load this file as what is physically on the racks? Do this BEFORE uploading the dump.')) return;
  msg.textContent = 'Uploading...'; msg.className = 'msg';
  const form = new FormData();
  form.append('file', fileEl.files[0]);
  const res = await fetch('/api/preload', { method: 'POST', headers: { Authorization: `Bearer ${getToken()}` }, body: form });
  const body = await res.json();
  if (!res.ok) { msg.textContent = body.error || 'Upload failed'; msg.className = 'msg error'; return; }
  const extra = [[body.handedOver, 'handed over'], [body.setAside, 'set aside'], [body.notFound, 'not found'], [body.totesDone, 'done totes']].filter(x => x[0]).map(x => `${x[0]} ${x[1]}`).join(', ');
  msg.textContent = `Loaded ${body.added} barcodes on the racks (${body.pids} PIDs, ${body.locs} locations)` + (extra ? `, ${extra}` : '') + '.' + (body.bad.length ? ` ${body.bad.length} row(s) skipped (see below).` : '');
  msg.className = 'msg ' + (body.bad.length ? 'error' : 'ok');
  report.textContent = JSON.stringify(body, null, 2);
  loadDumpInfo();
});

async function removeDump(mode) {
  const msg = document.getElementById('dump-remove-msg');
  const what = mode === 'continue'
    ? `Remove the current dump and all activity, keeping the ${dumpInfo ? dumpInfo.inAisles : '?'} barcodes now in the aisles?`
    : 'Remove EVERYTHING — dump, activity and aisle stock?';
  if (!window.confirm(`${what} A backup is saved first.`)) return;
  if (mode === 'fresh' && window.prompt('Type CLEAR to confirm') !== 'CLEAR') return;
  msg.textContent = 'Working...'; msg.className = 'msg';
  const r = await apiFetch('/api/dump/remove', { method: 'POST', body: JSON.stringify({ mode }), timeoutMs: 120000 });
  msg.textContent = r.ok ? `Removed. Backup saved as ${r.backup}.` : (r.error || 'Failed');
  msg.className = 'msg ' + (r.ok ? 'ok' : 'error');
  loadDumpInfo();
}
document.getElementById('dump-remove-continue-btn').addEventListener('click', () => removeDump('continue'));
document.getElementById('dump-remove-fresh-btn').addEventListener('click', () => removeDump('fresh'));

document.getElementById('dump-backups-table').addEventListener('click', async e => {
  const btn = e.target.closest('button[data-restore]'); if (!btn) return;
  const msg = document.getElementById('dump-restore-msg');
  if (!window.confirm(`Restore ${btn.dataset.restore}? The data now in the system is replaced by it (and saved as a backup first).`)) return;
  if (window.prompt('Type RESTORE to confirm') !== 'RESTORE') return;
  msg.textContent = 'Restoring...'; msg.className = 'msg';
  const r = await apiFetch('/api/backup/restore', { method: 'POST', body: JSON.stringify({ name: btn.dataset.restore }), timeoutMs: 120000 });
  msg.textContent = r.ok ? `Restored ${r.restored}. Previous data saved as ${r.safety}.` : (r.error || 'Failed');
  msg.className = 'msg ' + (r.ok ? 'ok' : 'error');
  loadDumpInfo();
});

// ---------- not-found totes ----------
async function loadMissing() {
  const r = await apiFetch('/api/totes/missing');
  if (!r.ok) return;
  document.getElementById('missing-table').innerHTML = r.totes.map(x => `<tr>
    <td>${x.n}</td><td>${x.tote}</td><td>${x.processable}</td><td>${x.pids}</td><td>${x.at}</td><td>${x.reason}</td>
    <td><button class="secondary" data-found="${x.tote}">Mark found</button></td>
  </tr>`).join('') || '<tr><td colspan="7">None</td></tr>';
  document.querySelectorAll('[data-found]').forEach(btn => btn.addEventListener('click', async () => {
    await apiFetch(`/api/tote/${encodeURIComponent(btn.dataset.found)}/reinstate`, { method: 'POST' });
    loadMissing();
  }));
}
document.getElementById('missing-refresh-btn').addEventListener('click', loadMissing);

// ---------- handover (merged with consolidation) ----------
async function loadHandover() {
  const [consR, statusR] = await Promise.all([apiFetch('/api/consolidation'), apiFetch('/api/status')]);
  if (!consR.ok) return;

  const forecastCard = document.getElementById('capacity-forecast-card');
  if (statusR.ok && statusR.forecast && statusR.forecast.warning) {
    const f = statusR.forecast;
    document.getElementById('capacity-forecast-text').textContent =
      `Known remaining demand needs ${f.locationsNeeded} locations, but only ${f.locationsAvailable} are available — ${f.shortfall} short.`;
    const b = f.breakdown;
    document.getElementById('capacity-forecast-kpis').innerHTML =
      `<div class="kpi"><div class="n">${b.pids}</div><div class="l">PIDs active</div></div>` +
      `<div class="kpi"><div class="n">${b.units.toLocaleString()}</div><div class="l">units active</div></div>` +
      `<div class="kpi"><div class="n">${b.locations}</div><div class="l">locations needed</div></div>`;
    forecastCard.classList.remove('hidden');
  } else {
    forecastCard.classList.add('hidden');
  }

  document.getElementById('handover-summary').textContent = `${consR.locationsActive} locations active · ${consR.pidsOpen} PIDs open`;
  handoverRows = new Map(consR.rows.map(row => [row.location + '|' + row.pid, row]));
  for (const k of [...handoverTicked]) if (!handoverRows.has(k)) handoverTicked.delete(k); // row gone since last refresh
  renderHandoverTable();
}
// default order: highest give first, so the most actionable rows aren't buried when capacity is tight;
// clicking a column header sorts by it (click again to flip), ticks are kept
const handoverSort = { key: 'give', dir: -1 };
function renderHandoverTable() {
  const { key, dir } = handoverSort;
  const sortedRows = [...handoverRows.values()].sort((a, b) => {
    const x = a[key], y = b[key];
    if (x == null && y == null) return 0;
    if (x == null) return 1; if (y == null) return -1; // blanks always last
    const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true });
    return c * dir || a.location.localeCompare(b.location, undefined, { numeric: true });
  });
  document.querySelectorAll('#panel-handover th[data-sort]').forEach(th => {
    th.querySelector('.arrow').textContent = th.dataset.sort === key ? (dir > 0 ? ' ▲' : ' ▼') : ' ⇅';
  });
  document.getElementById('handover-table').innerHTML = sortedRows.map(row => `<tr class="${row.risk ? 'risk-row' : row.give >= 5 ? 'give-row' : ''}">
    <td><input type="checkbox" data-pick="${row.location}|${row.pid}"${handoverTicked.has(row.location + '|' + row.pid) ? ' checked' : ''}></td>
    <td>${row.location}</td><td>${row.pid}</td><td>${row.qtyHere}</td><td>${row.knownTotal}</td>
    <td>${row.give}</td><td>${row.why}${row.risk ? ' ⚠️' : ''}</td><td>${formatAge(row.ageMinutes)}</td>
  </tr>`).join('') || '<tr><td colspan="8">Nothing placed right now</td></tr>';
  updateHandoverSelection();
}
document.querySelector('#panel-handover thead').addEventListener('click', e => {
  const th = e.target.closest('th[data-sort]'); if (!th) return;
  handoverSort.dir = handoverSort.key === th.dataset.sort ? -handoverSort.dir : 1;
  handoverSort.key = th.dataset.sort;
  renderHandoverTable();
});
// ticked rows are keyed "location|pid"; nothing is released until the button is pressed and confirmed
let handoverRows = new Map();
const handoverTicked = new Set();
function updateHandoverSelection() {
  let units = 0;
  for (const k of handoverTicked) units += handoverRows.get(k)?.qtyHere || 0;
  const btn = document.getElementById('handover-release-btn');
  btn.textContent = `Release selected (${handoverTicked.size})`;
  btn.disabled = handoverTicked.size === 0;
  const all = document.getElementById('handover-all');
  all.checked = handoverRows.size > 0 && handoverTicked.size === handoverRows.size;
  all.indeterminate = handoverTicked.size > 0 && handoverTicked.size < handoverRows.size;
  return units;
}
document.getElementById('handover-table').addEventListener('change', e => {
  const cb = e.target.closest('[data-pick]'); if (!cb) return;
  cb.checked ? handoverTicked.add(cb.dataset.pick) : handoverTicked.delete(cb.dataset.pick);
  updateHandoverSelection();
});
function setAllTicks(keys) {
  handoverTicked.clear(); keys.forEach(k => handoverTicked.add(k));
  document.querySelectorAll('[data-pick]').forEach(cb => { cb.checked = handoverTicked.has(cb.dataset.pick); });
  updateHandoverSelection();
}
document.getElementById('handover-all').addEventListener('change', e => setAllTicks(e.target.checked ? [...handoverRows.keys()] : []));
document.getElementById('handover-clear-btn').addEventListener('click', () => setAllTicks([]));
document.getElementById('handover-pick-rec-btn').addEventListener('click', () => setAllTicks([...handoverRows].filter(([, r]) => r.give > 0).map(([k]) => k)));
document.getElementById('handover-release-btn').addEventListener('click', async () => {
  const msg = document.getElementById('handover-msg');
  const items = [...handoverTicked].map(k => { const r = handoverRows.get(k); return r && { location: r.location, pid: r.pid }; }).filter(Boolean);
  if (!items.length) return;
  const units = updateHandoverSelection();
  if (!window.confirm(`Release ${items.length} location row(s) — ${units} unit(s) — for processing?\nThis cannot be undone.`)) return;
  const r = await apiFetch('/api/consolidation/release-many', { method: 'POST', body: JSON.stringify({ items }) });
  if (!r.ok) { msg.textContent = r.error || 'Release failed'; msg.className = 'msg error'; return; }
  msg.textContent = `Released ${r.totalGiven} unit(s) from ${r.done.length} row(s).` + (r.failed.length ? ` ${r.failed.length} could not be released.` : '');
  msg.className = 'msg ' + (r.failed.length ? 'error' : 'ok');
  handoverTicked.clear();
  loadHandover();
});
// ---------- Handover log tab: quantity released/processed (read off the events table) ----------
const hlogFrom = document.getElementById('hlog-from'), hlogTo = document.getElementById('hlog-to');
const localDay = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
hlogFrom.value = hlogTo.value = localDay(); // opens on today
const hlogQuery = () => { const q = new URLSearchParams(); if (hlogFrom.value) q.set('from', hlogFrom.value); if (hlogTo.value) q.set('to', hlogTo.value); return q; };
async function loadHandoverLog() {
  const r = await apiFetch('/api/handover/log?' + hlogQuery());
  if (!r.ok) { document.getElementById('hlog-summary').textContent = r.error || 'Could not load the log'; return; }
  document.getElementById('hlog-summary').textContent = r.truncated ? `showing newest ${r.rows.length} of ${r.entries}` : '';
  document.getElementById('hlog-kpis').innerHTML =
    `<div class="kpi"><div class="n">${r.totalQty.toLocaleString()}</div><div class="l">units processed</div></div>` +
    `<div class="kpi"><div class="n">${r.entries.toLocaleString()}</div><div class="l">release entries</div></div>` +
    `<div class="kpi"><div class="n">${r.pids.toLocaleString()}</div><div class="l">PIDs</div></div>` +
    r.byDay.slice(0, 3).map(d => `<div class="kpi"><div class="n">${d.qty.toLocaleString()}</div><div class="l">${d.day}</div></div>`).join('');
  document.getElementById('hlog-table').innerHTML = r.rows.map(x => `<tr>
    <td>${x.ts}</td><td>${x.shift || ''}</td><td>${x.operator || ''}</td><td>${x.kind}</td><td>${x.location || ''}</td><td>${x.pid || ''}</td><td>${x.qty}</td>
  </tr>`).join('') || '<tr><td colspan="7">No releases in this period</td></tr>';
}
hlogFrom.addEventListener('change', loadHandoverLog);
hlogTo.addEventListener('change', loadHandoverLog);
document.getElementById('hlog-export-btn').addEventListener('click', async () => {
  const res = await fetch('/api/handover/log.csv?' + hlogQuery(), { headers: { Authorization: `Bearer ${getToken()}` } });
  if (!res.ok) { document.getElementById('hlog-summary').textContent = 'Export failed'; return; }
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url; a.download = `handoverlog_${hlogFrom.value || 'start'}_to_${hlogTo.value || 'now'}.csv`; a.click();
  URL.revokeObjectURL(url);
});
document.getElementById('hlog-refresh-btn').addEventListener('click', loadHandoverLog);
document.getElementById('hlog-today-btn').addEventListener('click', () => { hlogFrom.value = hlogTo.value = localDay(); loadHandoverLog(); });
document.getElementById('hlog-all-btn').addEventListener('click', () => { hlogFrom.value = hlogTo.value = ''; loadHandoverLog(); });

function formatAge(mins) {
  if (mins === null || mins === undefined) return '';
  if (mins < 60) return `<${Math.max(1, mins)} min`;
  const hrs = Math.floor(mins / 60);
  return hrs < 24 ? `${hrs} hr` : `${Math.floor(hrs / 24)} day${hrs >= 48 ? 's' : ''}`;
}
document.getElementById('handover-refresh-btn').addEventListener('click', loadHandover);

// ---------- station summary (per-station totals from the old multi-station report) ----------
async function loadStationSummary() {
  const r = await apiFetch('/api/sim-report');
  if (!r.ok) return;
  document.getElementById('simreport-summary').textContent = `${r.totalTotes} totes across ${r.stations.length} station(s)`;
  const clashMsg = document.getElementById('simreport-clash-summary');
  clashMsg.textContent = r.clashes.length ? `${r.clashes.length} blocked clash attempt(s)` : 'no clashes';
  clashMsg.className = 'msg ' + (r.clashes.length ? 'error' : 'ok');
  document.getElementById('simreport-table').innerHTML = r.stations.map(x => `<tr>
    <td>${x.station}</td><td>${x.operator || ''}</td><td>${x.totes}</td><td>${x.placed}</td><td>${x.aside}</td><td>${x.notFound}</td>
  </tr>`).join('') || '<tr><td colspan="6">No totes processed yet</td></tr>';
}

// ---------- users ----------
async function loadUsers() {
  const r = await apiFetch('/api/users');
  if (!r.ok) return;
  document.getElementById('users-table').innerHTML = r.users.map(u => `<tr>
    <td>${u.name}</td><td>${u.role}</td><td>${u.active ? 'yes' : 'no'}</td>
    <td>${u.active
    ? `<button class="danger" data-delete="${u.id}">Delete</button>`
    : `<button class="secondary" data-reactivate="${u.id}">Reactivate</button>`}</td>
  </tr>`).join('') || '<tr><td colspan="4">No users yet</td></tr>';
  document.querySelectorAll('[data-delete]').forEach(btn => btn.addEventListener('click', async () => {
    if (!window.confirm('Delete this user? They will no longer be able to log in (this can be undone with Reactivate).')) return;
    const r2 = await apiFetch(`/api/users/${btn.dataset.delete}`, { method: 'DELETE' });
    if (!r2.ok) window.alert(r2.error || 'Failed');
    loadUsers();
  }));
  document.querySelectorAll('[data-reactivate]').forEach(btn => btn.addEventListener('click', async () => {
    await apiFetch(`/api/users/${btn.dataset.reactivate}`, { method: 'PATCH', body: JSON.stringify({ active: true }) });
    loadUsers();
  }));
}
document.getElementById('user-add-btn').addEventListener('click', async () => {
  const name = document.getElementById('user-new-name').value.trim();
  const role = document.getElementById('user-new-role').value;
  const pin = document.getElementById('user-new-pin').value.trim();
  const msg = document.getElementById('users-msg');
  if (!name || !pin) { msg.textContent = 'Name and PIN are required'; msg.className = 'msg error'; return; }
  const r = await apiFetch('/api/users', { method: 'POST', body: JSON.stringify({ name, role, pin }) });
  msg.textContent = r.ok ? 'Added.' : (r.error || 'Failed');
  msg.className = 'msg ' + (r.ok ? 'ok' : 'error');
  if (r.ok) {
    document.getElementById('user-new-name').value = '';
    document.getElementById('user-new-pin').value = '';
    loadUsers();
  }
});

// ---------- lookup ----------
document.getElementById('lookup-btn').addEventListener('click', async () => {
  const q = document.getElementById('lookup-q').value.trim();
  const out = document.getElementById('lookup-result');
  if (!q) return;
  const r = await apiFetch('/api/lookup?q=' + encodeURIComponent(q));
  out.textContent = JSON.stringify(r, null, 2);
});

// ---------- alerts ----------
async function loadAlerts() {
  const unresolvedOnly = document.getElementById('alerts-unresolved-only').checked;
  const r = await apiFetch('/api/alerts' + (unresolvedOnly ? '?unresolved=1' : ''));
  if (!r.ok) return;
  document.getElementById('alerts-table').innerHTML = r.alerts.map(a => `<tr>
    <td>${a.ts}</td><td>${a.type}</td><td>${a.message}</td>
    <td>${a.resolved_at ? 'resolved' : `<button class="secondary" data-resolve="${a.id}">Resolve</button>`}</td>
  </tr>`).join('') || '<tr><td colspan="4">No alerts</td></tr>';
  document.querySelectorAll('[data-resolve]').forEach(btn => btn.addEventListener('click', async () => {
    await apiFetch(`/api/alerts/${btn.dataset.resolve}/resolve`, { method: 'POST' });
    loadAlerts();
  }));
}
document.getElementById('alerts-refresh-btn').addEventListener('click', loadAlerts);
document.getElementById('alerts-unresolved-only').addEventListener('change', loadAlerts);

// ---------- exports ----------
document.querySelectorAll('[data-export]').forEach(btn => btn.addEventListener('click', async () => {
  const name = btn.dataset.export;
  const res = await fetch(`/api/export/${name}.csv`, { headers: { Authorization: `Bearer ${getToken()}` } });
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `${name}.csv`; a.click();
  URL.revokeObjectURL(url);
}));

// ---------- layout settings (aisles/totes/partitions/capacity) ----------
const LAYOUT_FIELDS = ['aisles', 'totesPerAisle', 'lastAisleTotes', 'partitions', 'cap', 'headroomPct', 'softPidCap', 'autoCloseSharePct', 'batchSize'];
const LAYOUT_ARRAY_FIELDS = ['processableStatus', 'processableAvailability'];
async function loadLayout() {
  const r = await apiFetch('/api/settings/layout');
  if (!r.ok) return;
  for (const k of LAYOUT_FIELDS) {
    const el = document.getElementById('lay-' + k);
    el.value = r.settings[k];
    el.disabled = r.locked;
  }
  for (const k of LAYOUT_ARRAY_FIELDS) {
    const el = document.getElementById('lay-' + k);
    el.value = (r.settings[k] || []).join(', ');
    el.disabled = r.locked;
  }
  document.getElementById('layout-save-btn').disabled = r.locked;
  document.getElementById('layout-lock-note').textContent = r.locked ? '— locked: barcodes already placed' : '— editable (nothing placed yet)';
  document.getElementById('layout-plancap').textContent = `Plan capacity per partition: ${r.planCapacity}`;
}
document.getElementById('layout-save-btn').addEventListener('click', async () => {
  const msg = document.getElementById('layout-msg');
  const payload = {};
  for (const k of LAYOUT_FIELDS) payload[k] = Number(document.getElementById('lay-' + k).value);
  for (const k of LAYOUT_ARRAY_FIELDS) {
    payload[k] = document.getElementById('lay-' + k).value.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  }
  const r = await apiFetch('/api/settings/layout', { method: 'POST', body: JSON.stringify(payload) });
  if (!r.ok) { msg.textContent = (r.errors && r.errors.join('; ')) || r.error || 'Failed'; msg.className = 'msg error'; return; }
  msg.textContent = 'Saved.'; msg.className = 'msg ok';
  loadLayout();
});

setInterval(() => { if (!loginView.classList.contains('hidden')) return; refreshActiveTab(); }, 15000);

// start last: showApp() needs every const/handler above (tabButtons etc.) to be initialized
if (getToken() && getStation()) showApp(); else showLogin();
