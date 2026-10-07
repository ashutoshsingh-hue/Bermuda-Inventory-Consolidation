# Handoff — last updated 2026-10-07 (after Handover redesign, Handover log tab, rack-map tooltip fix)
<!-- Overwritten by /handoff at the end of each session. Keep under 80 lines. -->

## State right now
- Server: hidden background `npm start > server.log 2>&1` on port 8080, schema v5, restarted 2026-10-07 (latest, to load the rack-map
  count change). Admin /admin/, operators /station/. Not a Windows service; no auto-start (see Open items).
- LAN: laptop is on Wi-Fi "Lenskart.in" (Domain profile), IP was 172.20.10.5 (hotspot range, changes; was 10.9.97.78).
  Server binds 0.0.0.0:8080. Other PC could NOT connect even after owner added a firewall rule + same hotspot (cause not found).
- Live data: dump "Export-data-2026-10-06 11_31_21.csv" (283 totes, 80,876 barcodes, 77,846 processable). Route 1 is ACTIVE
  (50 totes, 34 done at last check). Operators scanning.
- Users: Ashutosh (admin), Lead1, Operator1-4. TestOperator2 deactivated. Operator3/4/Lead1 still active (owner to decide).
- Backups: 2 newest bermuda-*.db (auto, nightly 22:15 + before every Clear/Remove/Restore) + manual, never pruned:
  backups/pre-reset-2026-10-03.db, pre-clear-2026-10-03.db (+wal files), pre-renumber-2026-10-06.db.
- npm test: 233/233.

## Done (all owner-requested; PLAN.md 5.5 updated for numbering)
- Route planner (core/routePlanner.js): waiting totes ranked by recommend() = same order as "UP NEXT", cut into rounds of
  settings.batchSize (50). Route tab shows tote NUMBER (T.n). Start only checks totes still waiting.
- Station offers (services/scanService.js nextTotes): each idle station gets its OWN tote (held from others 2 min, sticky).
  Scan response carries `barcode`.
- Rack numbering: continuous A1 T01-T20, A2 T21-T40, A3 T41-T60 (core/state.js buildLocations); migration v5 renamed old codes.
- Dump lifecycle (core/newDump.js, services/resetService.js): POST /api/dump `mode` (send BEFORE the file): merge | continue |
  fresh (admin only). Also POST /api/dump/remove, GET /api/dump/info, POST /api/backup/restore {name}. Only newest 2 backups kept.
- Admin tabs: Status, Route, Dump, Not found, Handover, Handover log, Users, Exports, Settings.
- Handover tab redesign (2026-10-07, owner rule: RELEASE = HANDED OVER AND PROCESSED, no separate confirm step):
  - Per-row Release buttons and "Confirm handover" are gone. Rows have checkboxes (select-all, "Tick recommended" = Give>0,
    "Clear ticks"); "Release selected (N)" shows a confirm popup (rows + units), then POST /api/consolidation/release-many
    (lead/admin, one transaction, core releaseFromLocation per row). Only Refresh remains besides those.
  - Column headers are click-sortable (arrows up/down/idle; default Give desc; blanks last; ticks survive sorting). Client-side only.
  - DELETED: POST /api/handover/confirm, handoverService.confirm(), GET /api/handover/preview, handoverService.preview(), their tests.
    Kept: GET /api/consolidation, POST /api/consolidation/release (operator nudge), release-at-risk, route/complete's handoverPreview.
- Handover log tab (own admin tab, NOT inside Handover): quantity processed. Date range (opens on Today; All time button), KPIs
  (units, entries, PIDs, last 3 days), table time/shift/by/type/location/PID/qty, "Export CSV" button.
  - GET /api/handover/log?from&to and GET /api/handover/log.csv?from&to (lead/admin; CSV follows the range, UTF-8 BOM) via
    services/handoverLogService.js (+ exportService.handoverLogCsv). Reads the events table: types release_location | release_all |
    release | handover (old Confirm rows), so earlier releases show too. No new table.
  - release-many writes ONE events row per location+PID (runMutation now accepts `events: []` as well as `event`).
  - Events are wiped by Clear / fresh dump (backup first) -> download the CSV before a reset if totals must be kept.
- Status rack map (statusService.aisleMap + buildRackHtml): tooltip shows CURRENT stock only, e.g. "A1-T01-P2: 3 of 100 barcodes · 2 PIDs".
  pidCount = PIDs with barcodes actually placed (c>0), NOT reservations - owner wants a simple frontend, backend detail stays hidden.
  Reservations still count internally for the 20-PIDs-per-partition cap, so an empty-looking cell can rarely refuse a new PID (NO SPACE).
  Owner rule of thumb: the UI shows current status only.
- Docs updated for all of this: PLAN §9/§11, STRUCTURE §7, RUNBOOK §4. Verified in the browser on live data (ticks, select-all, sort,
  cancel path, log + CSV download); a real release was deliberately NOT run on live data (log shows the 4 releases from 02:40-02:41).
- Operator screen (public/station/*), redesigned this session:
  - Wide layout (>=760px): fixed to viewport (no page scroll), grid columns minmax(0,7fr) minmax(0,3fr) = 70% scanner / 30% info.
  - Top banner merged: ROUTE #n (left) | CURRENT TOTE + done/expected scanned (centre) | TOTES DONE x/y (right). Old route bar removed.
    Source: GET /api/route-progress (statusService.routeProgress, cheap; done = route totes with s==='C'). station.js polls it
    every 2 s (checkActiveRoute) + right after opening/finishing a tote; banner renders in renderBanner().
  - Scanner tile: Location 9rem / PID 5.5rem / barcode 3.5rem (owner-tuned maxima, CSS .result-panel .code/.msg/.sub);
    station.js fitResult() shrinks each line to the panel (nowrap, ResizeObserver) - never wraps/clips. Data centered.
  - Top bar shows "Station N" when the station id is numeric (display only). "TOTE FINISHED 87" and "TOTE 87 OPEN" are one line;
    error/info/aside messages no longer printed twice (render() in station.js).
- Fixed earlier: admin reload froze - startup line must stay LAST in public/admin/admin.js.

## Open items (next step: item 1)
1. LAN access for other PCs: on the other PC run `Test-NetConnection <laptop-ip> -Port 8080` and `ipconfig` here. Suspects:
   rule not saved / not on the active profile (use Domain+Private+Public, Remote IP Any), corporate Wi-Fi client isolation or
   domain GP overriding local rules. Best fix: host on an always-on WIRED PC (needs admin to add rule; Claude is not elevated).
2. Visually verify the operator screen on the real floor monitor (fit/sizes were tuned from screenshots only; owner may want
   different rem sizes). Then watch a real scan -> place -> finish run.
3. Auto-start at boot + restart on crash (scheduled task) - owner OK pending; reserve host IP or use PC name.
4. Decide on Operator3/4 and Lead1 accounts; first real tick -> Release selected on floor data not yet exercised (watch it once).
5. RUNBOOK.md still describes the old Recovery/preload flow and old tabs (only §4 handover wording was refreshed); refresh the rest.

## Decisions / gotchas
- src/ changes need a server restart; public/ does not (Ctrl+F5 on operator screens). Restart: Stop-Process the node pid
  listening on 8080, then `Start-Process cmd '/c','npm start > server.log 2>&1' -WindowStyle Hidden`. Log is UTF-16 when
  written by PowerShell (iconv -f UTF-16 to read).
- Grid columns must stay minmax(0,..) and .result-panel min-width:0, else big nowrap text stretches the scanner column and leaks.
- Owner wants: fonts large but never leaking, centered data, 70/30 split, no duplicated text; font sizes in rem as stated.
- Chrome extension tabs can be lost between sessions; operators/admin need a manual login (PINs not known to Claude).
- core/pullOrder (handover.js:58) still throws if a placed barcode lacks its loc_pid row; not hardened (owner decision pending).
- Auto-mode classifier blocks bulk DB deletes; run in Manual mode.
- Layout changes in Settings apply only when the rack is empty (RUNBOOK 2); renumbering migration is the exception.
