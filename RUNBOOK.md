# Bermuda Sort Station — Runbook

Floor operations: starting/stopping the server, connecting stations, backup/restore, and
what to do when something goes wrong. See `PLAN.md` for the business rules and `STRUCTURE.md`
for how the code is laid out.

---

## 1. First-time setup

```
npm install
copy .env.example .env      # PowerShell: Copy-Item .env.example .env
```

Edit `.env` if needed: `PORT` (default 8080), `DB_PATH` (default `data/bermuda.db`), `TZ`.
Needs Node 20+. For a dedicated always-on PC use `deploy/setup-host.ps1` (see `deploy/README.md`).

**There is no self-registration and no default account.** Create the first admin from the command
line (the server may be running or stopped):

```
node tools/createUser.js "Ashutosh" admin 1234
```

After that, log in at `/admin/` and add everyone else under **Users** (name, role, PIN). Roles:
`operator` (station screen), `lead` (also Route, Handover, Handover log), `admin` (also Dump replace/remove,
Users, Settings, Exports, backups). People are deactivated, never deleted (past events keep their name);
the last active admin cannot be deactivated. A station appears automatically the first time someone
logs in with its id.

## 2. Layout

The rack is 3 aisles x 20 totes x 4 partitions = 240 locations, cap 100 barcodes per partition
(plan capacity 95), soft cap 20 PIDs per partition, batches of 50 totes (PLAN.md §5.5, §6).
Location codes run continuously: A1 T01-T20, A2 T21-T40, A3 T41-T60 (for example `A1-T18-P2`).
Layout edits in `/admin` -> Settings only apply while the rack is empty (the migration that
renumbered codes on 2026-10-06 was the one exception). Before changing the layout: back up (§6),
release or clear everything on the rack, then save the layout; restart if Settings still shows old numbers.

## 3. Start / stop

**Start:**
```
npm start
```
This opens (and migrates, if needed) `data/bermuda.db`, loads state into memory, and listens
on `0.0.0.0:8080` (all interfaces) — stations on the LAN reach it at `http://<laptop-ip>:8080`.

**HTTPS and phone camera (same port 8080):** port 8080 answers both `http://` and `https://`.
Operator PCs keep using `http://<ip>:8080/station/`. A phone opens
`https://<ip>:8080/station/` — tap past the browser's certificate warning once (self-signed) — logs in
and taps **Scan with camera**. The camera button only appears on HTTPS (or localhost).
- The certificate lives in `certs/` (`key.pem`, `cert.pem`; not in git). It is tied to the host's
  IP/name, so **if the IP changes the HTTPS address stops matching** — regenerate (`deploy\setup-host.ps1`
  does this, or run `openssl req -x509 -newkey rsa:2048 -nodes -days 825 -keyout certs/key.pem -out certs/cert.pem -subj "/CN=bermuda-sort" -addext "subjectAltName=IP:<ip>,DNS:<name>,IP:127.0.0.1,DNS:localhost"`) and restart.
- No `certs/` folder = plain HTTP only, camera hidden. To roll back to the old behaviour, rename `certs/` and restart.
- Internally the app now listens on `127.0.0.1:8081` (port + 1) behind port 8080; do not open 8081 in the firewall.
- Camera reads are slower than a hardware scanner; test with real labels before relying on it.
- The decoded text is normalised exactly like a keyboard scan (tote = first 12, barcode = last 12).

**Stop:** `Ctrl+C` in the terminal running it. The server closes the DB connection cleanly on
shutdown (`SIGINT`/`SIGTERM`).

**Find the laptop's LAN IP** (PowerShell): `ipconfig` → look for the Wi-Fi/Ethernet adapter's
IPv4 address. Give stations `http://<that-ip>:8080/station/` and the lead
`http://<that-ip>:8080/admin/`.

**Windows Firewall:** the first time you run `npm start`, Windows may prompt to allow Node.js
through the firewall for private networks — allow it, or inbound connections from other
devices on the LAN will be blocked. To set this up ahead of time or fix it later:
```powershell
New-NetFirewallRule -DisplayName "Bermuda Sort Station" -Direction Inbound -Protocol TCP -LocalPort 8080 -Action Allow
```

**Keep the same IP across restarts:** either set a static IP on the laptop's network adapter,
or configure a DHCP reservation on the router so the laptop always gets the same address —
otherwise station bookmarks/QR codes break every time the laptop reboots.

## 4. Daily flow

- Whoever is loading the dump (see PLAN.md §12 O1) logs into `/admin`, goes to the **Dump**
  tab, and uploads the day's PID Hunter CSV whenever it's ready.
- **Batches**: the lead opens `/admin` → **Route**, proposes the next 50-tote batch, and clicks
  **Start route**. Stations then only see/scan that batch's totes (PLAN.md §6) until the lead
  clicks **Complete route** — which releases unused reservations and the lead then goes to
  the **Handover** tab, ticks the rows to hand over and presses **Release selected** (a
  confirmation pops up). Release = handed over and processed; there is no separate confirm step.
  Repeat for the next batch once that one's released.
- **22:15**: the server automatically backs up the database (see §6) — nothing to do.
- **No shift boundaries**: scanning, tote handling and totes staying open are not tied to a
  clock. A tote stays open until an operator finishes it or an admin force-releases it — there
  is no automatic close-out and no shift-end warning banner. `shiftOf()` still stamps an
  A/B/OFF label on events purely for audit/reporting; it doesn't gate or restrict anything.

## 5. Stations connecting

Each station device (PC + USB scanner, or a phone) opens `http://<host>:8080/station/` (phones:
`https://<host>:8080/station/`, see §3), logs in with **station id + operator name + PIN**, and
starts scanning. The scan input auto-focuses; a keyboard-wedge scanner's Enter suffix submits it.
Scans are normalised: tote = first 12 characters, barcode = last 12 (PLAN.md §4.1).

Each idle station is offered its **own** next tote (held from other stations for 2 minutes), so two
operators never get the same tote. On a monitor at least 760 px wide the screen is fixed to the viewport:
70% scanner, 30% info, with a top banner showing the route number, the current tote and totes done.
After changing `public/` files, press Ctrl+F5 on the operator screens (no restart needed); changes in
`src/` need a server restart.

An **orange EXTRA** result means the barcode belongs to a different tote than the one that is open; it is
still placed normally and an EXTRA alert is logged.

If the browser tab shows a full red **"OFFLINE — STOP SCANNING"** screen, the station can't
reach the server. Check the host is running and the network, then reload the page.

## 6. Backups

- **Automatic:** nightly at **22:15**, and **before every Clear / Remove / Restore**, the server writes a
  consistent snapshot (SQLite online backup API, safe while writing) to `backups/bermuda-<timestamp>.db`.
  **Only the newest 2** automatic backups are kept (a safety backup may briefly make it 3).
  Copy `backups/` off the PC regularly if you need history.
- **Restore from the UI:** `/admin` -> Dump -> Backups -> Restore (admin). The data being replaced is
  saved as a backup first. Afterwards, upload the new dump with **continue** to combine both.
- **Manual copy (server stopped):** copy `data/bermuda.db`, `data/bermuda.db-wal` and `data/bermuda.db-shm`
  together. Files copied by hand into `backups/` under another name (for example `pre-reset-<date>.db`) are never pruned.
- **Restore by hand:** stop the server, move the current `data/bermuda.db` (and `-wal`/`-shm`) aside, copy the
  chosen backup to `data/bermuda.db`, start the server, check `/admin` -> Status.

Events are wiped by Clear / "start fresh" / "Remove everything". Download the **Handover log CSV**
(`/admin` -> Handover log) first if totals must be kept.

## 7. Dump lifecycle (admin -> Dump tab)

Choose the mode **before** picking the file:
- **Add to the current data (merge)**: the normal daily upload. New totes are added, waiting totes refreshed, nothing removed.
- **New dump - continue** (admin): removes the old dump and all activity but keeps what is physically in the aisles;
  only those barcodes are deducted from the new dump.
- **New dump - start fresh** (admin): removes everything, including aisle stock.
- **Remove the current dump** (admin): "keep aisle stock" or "everything".

The file is validated before anything is removed, and a backup is saved first. Users, stations and layout
settings always survive. Totes an operator couldn't find are listed under the **Not found** tab; scanning the
tote's label again reinstates it, or a lead clicks "Mark found".

**Moving progress to a new site (or recovering after data loss) — Dump tab -> "Aisle stock":**
1. On the old site (admin): **Download aisle stock**. One file with everything: barcodes on the racks (P), handed over (O),
   set aside (X), not found in done totes (N) and the done totes themselves (C). Columns:
   `location,pid,barcode,tote,state,at,processable,tote_number`.
2. On the new, empty site: **Upload aisle stock** (lead/admin) *before* the dump. Uploading again replaces an
   earlier upload that is still on the racks.
3. Upload the PID Hunter dump with **Add to the current data**. Done totes are skipped (they show as "taken"),
   barcodes on the racks or already handed over are not placed again, and totes that are at least
   `autoCloseSharePct` (90%) sorted close themselves as usual.

Tested on a real backup into an empty database: all 11,890 rack barcodes, 392 handed over, 523 set aside, 212 not found
and 41 done totes carried over exactly, with 0 clashes; the dump then skipped the 41 done totes. Clashes (for example a
barcode both placed and handed over in the file, or an unknown state) are listed and skipped, and uploading the same
file twice changes nothing. **Not carried:** a tote marked NOT FOUND on the floor (state M) comes back as waiting
(mark it again if still missing), and open totes return to waiting. Download the Handover log CSV from the old site
as the record of what was processed.

## 8. Known gaps (ask the owner before assuming behavior)

- **Handover interval setting** is not wired up; handover happens when a lead ticks rows and presses Release selected.
- **Not-found acknowledgement** is not a distinct state; the list is in Exports -> notfound.csv.
- **Recount** (`src/services/recount.js`) self-heals drifted counts but has no admin button.
- **Pilot backup import** (`POST /api/import/pilot`, no UI) is untested against a real pilot export.
- `core/handover.js` `pullOrder` throws if a placed barcode lacks its `loc_pid` row (not hardened; owner decision pending).
- No login rate limiting or lockout, and the app trusts its network: keep it on the company LAN or behind IT's reverse proxy.
- An empty-looking partition can occasionally refuse a new PID (NO SPACE) because reservations count toward the
  20-PIDs-per-partition cap although the map shows current stock only.

## 9. Logs and auto-start

The server logs JSON to stdout: `npm start > server.log 2>&1` (PowerShell writes UTF-16; read it with `iconv -f UTF-16`).
The `events` table is the append-only audit trail of every scan/undo/finish/handover; export it via
`/admin` -> Exports -> `events.csv`.

Restart on a laptop: stop the node process listening on 8080 (and 8081), then
`Start-Process cmd '/c','npm start > server.log 2>&1' -WindowStyle Hidden`.
On the dedicated host, `deploy/setup-host.ps1` registers a startup task with automatic restart:
`Stop-ScheduledTask BermudaSortStation; Start-ScheduledTask BermudaSortStation`.
