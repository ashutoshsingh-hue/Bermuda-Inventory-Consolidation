/* ===== Bermuda Sort Station — station screen wiring ===== */
import { login, scanCode, undoLast, finishTote, nextTotes, getCurrentTote, markToteMissing, releasePid, getStatus, getRouteProgress, getToken, getStation, clearSession, onOffline } from '../shared/api.js';
import { beepOk, beepError } from '../shared/sounds.js';
import { initCamera } from './camera.js';

const loginView = document.getElementById('login-view');
const scanView = document.getElementById('scan-view');
const offlineOverlay = document.getElementById('offline-overlay');

const stationIdEl = document.getElementById('station-id');
const operatorNameEl = document.getElementById('operator-name');
const pinEl = document.getElementById('pin');
const loginBtn = document.getElementById('login-btn');
const loginError = document.getElementById('login-error');

const topbarStation = document.getElementById('topbar-station');
const topbarOperator = document.getElementById('topbar-operator');
const logoutBtn = document.getElementById('logout-btn');

const currentToteBanner = document.getElementById('current-tote-banner');
const ctbNum = document.getElementById('ctb-num');
const ctbProgress = document.getElementById('ctb-progress');
const ctbMid = document.getElementById('ctb-mid');
const ctbRoute = document.getElementById('ctb-route');
const ctbDone = document.getElementById('ctb-done');

const capacityWarningBanner = document.getElementById('capacity-warning-banner');
const capacityWarningText = document.getElementById('capacity-warning-text');


const resultPanel = document.getElementById('result-panel');
const resultCode = document.getElementById('result-code');
const resultMsg = document.getElementById('result-msg');
const resultSub = document.getElementById('result-sub');
const scanInput = document.getElementById('scan-input');
const undoBtn = document.getElementById('undo-btn');
const finishBtn = document.getElementById('finish-btn');
const suggestionEl = document.getElementById('suggestion');
const suggestionText = document.getElementById('suggestion-text');
const toteQueueWrap = document.getElementById('tote-queue-wrap');
const toteQueueEl = document.getElementById('tote-queue');
const notFoundBtn = document.getElementById('not-found-btn');
const notFoundConfirm = document.getElementById('not-found-confirm');
const notFoundReason = document.getElementById('not-found-reason');
const notFoundYes = document.getElementById('not-found-yes');
const notFoundNo = document.getElementById('not-found-no');
const historyEl = document.getElementById('history');

const releaseNudge = document.getElementById('release-nudge');
const releaseNudgeText = document.getElementById('release-nudge-text');
const releaseNudgeBtn = document.getElementById('release-nudge-btn');
const releaseNudgeDismiss = document.getElementById('release-nudge-dismiss');

// source of truth for "do I have a tote open" is whatever the server last told us — never a
// locally-guessed flag, so a page reload or a server-side force-finish can't leave it stale
let current = null; // { tote, n, exp, done } | null
let operatorName = '';
let suggestedTote = null;
let pendingRelease = null; // { location, pid, qty } | null — the PID currently offered for release

onOffline(isOffline => offlineOverlay.classList.toggle('hidden', !isOffline));

async function showScanView() {
  loginView.classList.add('hidden');
  scanView.classList.remove('hidden');
  const st = String(getStation() ?? '').trim();
  topbarStation.textContent = /^\d+$/.test(st) ? `Station ${st}` : st; // display only; the stored id is untouched
  topbarOperator.textContent = operatorName;
  scanInput.value = '';
  scanInput.focus();
  showResult('idle', 'SCAN A TOTE', '', '');
  // restore "which tote am I holding" after a fresh login or a page reload mid-tote
  const r = await getCurrentTote();
  setCurrentTote(r.ok ? r.current : null);
  refreshSuggestion();
  checkCapacityForecast();
  checkActiveRoute();
}

// floor-wide capacity forecast (owner-requested): PID totals already reflect the whole known
// dump, so this isn't a guess about the future — it's a live check of whether the currently-
// known demand exceeds available locations. Soft warning only, never blocks scanning.
async function checkCapacityForecast() {
  const r = await getStatus();
  if (!r.ok || !r.forecast || !r.forecast.warning) { capacityWarningBanner.classList.add('hidden'); return; }
  capacityWarningText.textContent = `Floor capacity tight — ${r.forecast.shortfall} location(s) short for known remaining demand`;
  capacityWarningBanner.classList.remove('hidden');
}

// route progress lives in the merged top banner: ROUTE n (left) | CURRENT TOTE (centre) | done/total
// (right). Polls a cheap endpoint so every operator screen follows within ~2 s of any station.
let routeInfo = null; // { id, total, done } | null
async function checkActiveRoute() {
  const r = await getRouteProgress();
  if (!r.ok) return;
  const next = r.route || null;
  if (JSON.stringify(next) === JSON.stringify(routeInfo)) return;
  routeInfo = next;
  renderBanner();
}

function showLoginView() {
  scanView.classList.add('hidden');
  loginView.classList.remove('hidden');
  stationIdEl.focus();
}

if (getToken() && getStation()) showScanView(); else showLoginView();

loginBtn.addEventListener('click', doLogin);
[stationIdEl, operatorNameEl, pinEl].forEach(el => el.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); }));

async function doLogin() {
  loginError.textContent = '';
  const station = stationIdEl.value.trim(), name = operatorNameEl.value.trim(), pin = pinEl.value.trim();
  if (!station || !name || !pin) { loginError.textContent = 'Fill in all three fields.'; return; }
  const r = await login(station, name, pin);
  if (!r.ok) { loginError.textContent = r.error || 'Login failed'; return; }
  operatorName = name;
  showScanView();
}

logoutBtn.addEventListener('click', () => { clearSession(); operatorName = ''; showLoginView(); });

scanInput.addEventListener('keydown', async e => {
  if (e.key !== 'Enter') return;
  const raw = scanInput.value.trim();
  scanInput.value = '';
  if (!raw) return;
  const r = await scanCode(raw);
  render(r);
});

initCamera(document.getElementById('cam-btn'), document.getElementById('cam-overlay'),
  document.getElementById('cam-video'), document.getElementById('cam-close'),
  async code => { render(await scanCode(code)); });

undoBtn.addEventListener('click', async () => {
  const r = await undoLast();
  if (r.ok && r.barcode) showResult('idle', 'UNDONE', r.barcode, '');
  else if (r.ok) showResult('idle', 'NOTHING TO UNDO', '', '');
  else { beepError(); showResult('error', r.error || 'Undo failed', '', ''); }
  scanInput.focus();
});

finishBtn.addEventListener('click', async () => {
  const r = await finishTote();
  if (!r.ok) { beepError(); showResult('error', r.error || 'Could not finish tote', '', ''); return; }
  setCurrentTote(null);
  checkActiveRoute();
  showResult('tote', `TOTE FINISHED ${r.n ?? r.tote}`, '', `${r.notFound.length} not found`);
  refreshSuggestion();
  scanInput.focus();
});

function render(r) {
  if (!r.ok) {
    beepError();
    showResult('error', r.error || 'Error', '', '');
    scanInput.focus();
    return;
  }
  // an admin can force-release a tote out from under a station (a crashed device, etc.);
  // recover the UI the moment that shows up, rather than staying stuck on a stale "open" state
  if (r.type === 'error' && /Scan the TOTE first/.test(r.msg || '') && current) {
    setCurrentTote(null);
    refreshSuggestion();
  }
  const isGood = ['tote', 'place', 'extra', 'info'].includes(r.type);
  isGood ? beepOk() : beepError();

  let code = '', msg = r.msg || '', sub = '';
  if (r.type === 'place' || r.type === 'extra') { code = r.loc; msg = r.type === 'extra' ? 'EXTRA — ' + r.pid : r.pid; sub = r.barcode || ''; }
  else if (r.type === 'tote') { code = `TOTE ${r.tote_progress?.n ?? ''} OPEN`.replace('  ', ' '); msg = ''; sub = r.found ? 'Was marked missing' : ''; }
  else if (r.type === 'dup') { code = r.loc || ''; msg = 'ALREADY SCANNED'; sub = [r.pid, r.barcode].filter(Boolean).join(' · '); }
  else { code = r.msg || r.type.toUpperCase(); msg = ''; sub = r.pid ? `PID ${r.pid}` : ''; } // message shown once, not repeated below

  showResult(r.type, code, msg, sub);
  setCurrentTote(r.tote_progress || null);
  setReleaseNudge(r.readyToRelease || null);

  pushHistory(r);
  if (r.type === 'tote') { refreshSuggestion(); checkActiveRoute(); }
  scanInput.focus();
}

// offer to release a PID once it crosses the collected-quantity threshold — purely an offer,
// never automatic; the operator can act on it or keep scanning and it just goes away on the
// next result (opening a tote, scanning something else, etc.) until it reappears
function setReleaseNudge(next) {
  pendingRelease = next;
  if (!next) { releaseNudge.classList.add('hidden'); return; }
  releaseNudgeText.textContent = `PID ${next.pid} has ${next.qty} collected here — release it for processing?`;
  releaseNudge.classList.remove('hidden');
}

releaseNudgeDismiss.addEventListener('click', () => setReleaseNudge(null));

releaseNudgeBtn.addEventListener('click', async () => {
  if (!pendingRelease) return;
  const { location, pid } = pendingRelease;
  releaseNudgeBtn.disabled = true;
  const r = await releasePid(location, pid);
  releaseNudgeBtn.disabled = false;
  setReleaseNudge(null);
  if (!r.ok) { beepError(); showResult('error', r.error || 'Release failed', '', ''); return; }
  beepOk();
  showResult('place', `RELEASED ${r.given}`, pid, 'Sent for processing');
  scanInput.focus();
});

function showResult(type, code, msg, sub) {
  resultPanel.className = 'result-panel type-' + type;
  resultCode.textContent = code;
  resultMsg.textContent = msg;
  resultSub.textContent = sub;
  // brief pulse so a repeated result (e.g. scanning the same type twice) still reads as "new" —
  // className was just fully reset above (no 'pulse' in it), so a reflow before re-adding it
  // is enough to make the browser treat this as a fresh transition rather than a no-op
  void resultPanel.offsetWidth;
  resultPanel.classList.add('pulse');
  fitResult();
}

// Fit each line (location / PID / barcode) to the scanner panel at the largest size that still
// fits: start from the CSS maximum, shrink to the panel width, then shrink all lines together if
// the stack is taller than the panel. Only shrinks, so quality stays crisp at the CSS maximum.
function fitResult() {
  const lines = [resultCode, resultMsg, resultSub];
  const cs = getComputedStyle(resultPanel);
  const availW = resultPanel.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const availH = resultPanel.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  if (availW <= 0 || availH <= 0) return;
  for (const el of lines) {
    el.style.fontSize = '';
    el.style.whiteSpace = 'nowrap';
    const w = el.scrollWidth;
    if (w > availW) el.style.fontSize = (parseFloat(getComputedStyle(el).fontSize) * availW / w * 0.98) + 'px';
  }
  const stack = lines.reduce((h, el) => h + el.offsetHeight + (parseFloat(getComputedStyle(el).marginTop) || 0), 0);
  if (stack > availH) {
    const k = availH / stack * 0.97;
    for (const el of lines) el.style.fontSize = (parseFloat(getComputedStyle(el).fontSize) * k) + 'px';
  }
}
window.addEventListener('resize', fitResult);
// the panel also changes size when banners appear/disappear — refit without a window resize
let fitRaf = 0;
new ResizeObserver(() => { cancelAnimationFrame(fitRaf); fitRaf = requestAnimationFrame(fitResult); }).observe(resultPanel);


// the persistent "which tote am I holding" banner — this is the answer to "which tote do I
// scan into right now", kept visible for as long as the tote stays open, not just flashed once
function setCurrentTote(next) {
  current = next;
  renderBanner();
}

function renderBanner() {
  currentToteBanner.classList.toggle('hidden', !current && !routeInfo);
  ctbMid.style.visibility = current ? 'visible' : 'hidden';
  if (current) {
    ctbNum.textContent = current.n ?? current.tote;
    ctbProgress.textContent = `${current.done} / ${current.exp} scanned`;
  }
  ctbRoute.textContent = routeInfo ? `#${routeInfo.id}` : '';
  ctbDone.textContent = routeInfo ? `${routeInfo.done}/${routeInfo.total}` : '';
  currentToteBanner.querySelector('.ctb-left').style.visibility = routeInfo ? 'visible' : 'hidden';
  currentToteBanner.querySelector('.ctb-right').style.visibility = routeInfo ? 'visible' : 'hidden';
}

function pushHistory(r) {
  const line = document.createElement('div');
  if ((r.type === 'place' || r.type === 'extra' || r.type === 'dup') && r.loc) {
    // Location | PID | Barcode, one column each, so the whole row is readable at a glance
    line.className = 'h-row';
    for (const [cls, text] of [['h-loc', r.loc], ['h-pid', r.pid || ''], ['h-bc', r.barcode || '']]) {
      const span = document.createElement('span'); span.className = cls; span.textContent = text; line.appendChild(span);
    }
  } else line.textContent = r.msg || r.type;
  historyEl.prepend(line);
  while (historyEl.children.length > 20) historyEl.removeChild(historyEl.lastChild);
}

async function refreshSuggestion() {
  notFoundConfirm.classList.add('hidden'); notFoundBtn.classList.remove('hidden');
  if (current) {
    suggestionEl.classList.add('hidden'); suggestedTote = null;
    toteQueueWrap.classList.add('hidden');
    return;
  }
  const r = await nextTotes(8); // #1 shown big above; the rest fill the queue list
  if (!r.ok || !r.list || !r.list.length) {
    suggestionEl.classList.add('hidden'); suggestedTote = null;
    toteQueueWrap.classList.add('hidden');
    return;
  }
  const [top, ...rest] = r.list;
  suggestedTote = top.tote;
  suggestionText.innerHTML = `Scan this tote now: <strong>${top.n}</strong> (${top.size} barcodes)`;
  suggestionEl.classList.remove('hidden');

  if (rest.length) {
    toteQueueEl.innerHTML = rest.map(t =>
      `<div class="tote-queue-row"><span class="tq-num">${t.n}</span><span class="tq-size">${t.size} bc</span></div>`,
    ).join('');
    toteQueueWrap.classList.remove('hidden');
  } else {
    toteQueueWrap.classList.add('hidden');
  }
}

notFoundBtn.addEventListener('click', () => {
  notFoundBtn.classList.add('hidden');
  notFoundConfirm.classList.remove('hidden');
});
notFoundNo.addEventListener('click', () => {
  notFoundConfirm.classList.add('hidden');
  notFoundBtn.classList.remove('hidden');
});
notFoundYes.addEventListener('click', async () => {
  if (!suggestedTote) return;
  const r = await markToteMissing(suggestedTote, notFoundReason.value);
  if (!r.ok) { beepError(); showResult('error', r.error || 'Could not mark not found', '', ''); }
  else { showResult('aside', 'TOTE NOT FOUND', `Skipped · ${r.processable} processable barcode(s) on hold`, 'Scan its label if it turns up — it reopens automatically'); }
  await refreshSuggestion();
  scanInput.focus();
});

setInterval(() => { if (loginView.classList.contains('hidden')) checkActiveRoute(); }, 2000);
setInterval(() => { if (loginView.classList.contains('hidden')) { refreshSuggestion(); checkCapacityForecast(); } }, 15000);
