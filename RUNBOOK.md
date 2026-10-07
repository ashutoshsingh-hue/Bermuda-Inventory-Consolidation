# Bermuda Sort Station — Runbook

Floor operations: starting/stopping the server, connecting stations, backup/restore, and
what to do when something goes wrong. See `PLAN.md` for the business rules and `STRUCTURE.md`
for how the code is laid out.

---

## 1. First-time setup (on the owner's laptop)

```
npm install
copy .env.example .env      # PowerShell: Copy-Item .env.example .env
```

Edit `.env` if needed — `PORT` (default 8080), `DB_PATH` (default `data/bermuda.db`).

**There is no self-registration.** Before the first shift, create at least one admin/lead
user directly (no admin UI exists to do this yet — that's an open item, see §8):

```js
// run once with: node -e "...", or save as a scratch .js file and run it
import('./src/server.js').then(({ buildApp }) => {
  const ctx = buildApp();
  ctx.authService.createUser({ name: 'Ashutosh', role: 'admin', pin: '<pick a PIN>' });
  ctx.authService.createUser({ name: 'Shift B Lead', role: 'lead', pin: '<pick a PIN>' });
  ctx.db.close();
});
```

Do this while the server is **not** running, or in a second terminal — SQLite in WAL mode
allows a second short-lived connection safely, but simplest is to seed users before `npm start`.

## 2. Upgrading to the 60-tote batch model (one-time, 03-Oct-2026, owner-approved)

This version moves from the old 5-aisle/overflow layout to a hard-capped 60-tote rack (3
aisles × 20 totes × 4 partitions = 240 locations) processed in 50-tote batches (PLAN.md §5.5,
§6). Follow these steps in order on the laptop that currently runs the server:

1. **Back up the DB first** — see §6. Don't skip this even if the next step looks safe.
2. **Hand over or release everything currently on the rack.** The migration refuses to
   silently shrink/reshape a floor that still has real inventory on it (`src/db/migrate.js`'s
   v3→v4 step checks `locations.used` / `loc_pid` directly) — it'll leave the old layout alone
   rather than risk discarding data, which just means you won't get the new 240-location
   capacity until the rack is clear. Use the current `/admin` → Handover tab (or, for a full
   reset, the admin **Release everything** button) to clear it down to 0 placed.
3. **Deploy** this version (pull the new code, `npm install` if dependencies changed) and
   start the server as usual (§3). The DB migration runs automatically on boot.
4. **Confirm** `/admin` → Settings shows the new shape: 240 locations total (3 aisles × 20
   totes × 4 partitions), **cap 100**, **headroom 5%** (plan capacity 95), **soft PID cap 20**.
   If it still shows the old numbers, step 2 wasn't actually clear when the server booted —
   clear the rack and restart.
5. **Upload a fresh dump** (`/admin` → Dump) so the backlog reflects the new eligibility
   settings (`processableStatus`/`processableAvailability`, also under Settings) from the start.
6. **Start batch 1** — `/admin` → Route → Propose route → Start route — and follow the normal
   daily flow (§4) from there.

## 3. Start / stop

**Start:**
```
npm start
```
This opens (and migrates, if needed) `data/bermuda.db`, loads state into memory, and listens
on `0.0.0.0:8080` (all interfaces) — stations on the LAN reach it at `http://<laptop-ip>:8080`.

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

Each station device (laptop + USB scanner, or Android handheld) opens
`http://<laptop-ip>:8080/station/` in a browser, logs in with **station id + operator name +
PIN**, and starts scanning. The scan input auto-focuses; a keyboard-wedge scanner's Enter
suffix submits it automatically.

If the browser tab shows a full red **"OFFLINE — STOP SCANNING"** screen, the station can't
reach the server — check the laptop is running and the station's WiFi/LAN connection, then
reload the page once it's back.

## 6. Backups

- Automatic: every night at **22:15**, the server writes a consistent snapshot (via SQLite's
  online backup API — safe even while the live DB is being written to) to `backups/`, named
  `bermuda-<timestamp>.db`. Backups older than **14 days** are deleted automatically.
- Manual backup: stop the server, copy `data/bermuda.db`, `data/bermuda.db-wal` and
  `data/bermuda.db-shm` together (all three, if present), or run the same backup job by hand:
  ```
  node -e "import('./src/jobs/nightlyBackup.js').then(async ({backupOnce}) => { const Database = (await import('better-sqlite3')).default; const db = new Database('data/bermuda.db'); await backupOnce(db, 'backups'); db.close(); })"
  ```

## 7. Restore from backup

1. Stop the server.
2. Move the current `data/bermuda.db` (and `-wal`/`-shm` files, if present) aside — don't
   delete them until the restore is confirmed good.
3. Copy the chosen file from `backups/` to `data/bermuda.db`.
4. Start the server (`npm start`). It reloads state from that file on boot.
5. Check `/admin` → Status to confirm the numbers look right (or run a `recount` check — see
   `src/services/recount.js`; there's no admin-UI button for it yet, see §8).

## 7.5 Recovering when the server's data is lost but the floor isn't

If `data/bermuda.db` is lost or corrupted beyond the last nightly backup, but the physical
aisles still hold real, correctly-sorted inventory, don't just reload the day's dump on empty
state — it'll re-place everything from scratch and lose the physical layout. Instead:

1. Before the loss (routine hygiene): `/admin` → Recovery → **Download current aisle stock**
   regularly, so you always have a recent `location,pid,barcode,tote` snapshot of what's
   actually in the aisles.
2. After the loss: `/admin` → Recovery → **Upload existing aisle stock**, using that snapshot
   (or, in a pinch, a fresh manual count in the same CSV shape).
3. Then `/admin` → Dump → upload the normal daily PID Hunter dump on top, as usual.

The dump load reconciles automatically: barcodes it recognizes as already placed don't get
re-added or flagged as conflicts, and any tote that's now mostly (≥90% by default,
`settings.autoCloseSharePct`) or fully accounted for auto-closes itself. Totes only partly
matched are flagged "partly sorted" for a quick rescan rather than force-closed. This is
independent of, and a better first resort than, restoring an old DB backup — it recovers from
*today's* floor state, not last night's snapshot.

**Totes marked "not found"** (an operator couldn't locate one physically — `/admin` → Recovery
→ its own table, or the "Tote not found" button on the station scan screen) are a separate,
smaller case: that tote's barcodes go on hold until its label is scanned again (which
reinstates it automatically) or a lead clicks "Mark found".

## 8. Known gaps (ask the owner before assuming behavior)

- **No admin UI for creating users** — see §1's workaround. A "Settings → users & PINs" screen
  is still open (PLAN.md M4).
- **No handover-interval setting** — handover currently happens whenever the lead clicks
  Confirm in `/admin`; the "every X hours" config from PLAN.md §6 isn't wired up.
- **Not-found acknowledgement** isn't a distinct action yet — the not-found list from a
  finished tote is available via `/admin` → Exports → `notfound.csv`, but PLAN.md's "the
  finish is provisional-final until acked" doesn't yet have a defined state change.
- **Recount check** (`src/services/recount.js`) exists and self-heals drifted counts, but has
  no admin-UI trigger yet — currently only callable from code.
- **Pilot backup import** (`/admin` has no button for it; call `POST /api/import/pilot`
  directly) is implemented against the *expected* shape of the pilot's backup JSON but has not
  been verified against a real exported file from `Bermuda_Sort_Station.html`. Test this before
  relying on it for the floor migration — though for day-to-day recovery, the preload flow in
  §7.5 (upload aisle stock, then the normal dump) is the tested path and doesn't depend on this.

## 9. Logs

The server logs to stdout (structured JSON, via Fastify's built-in logger) — redirect it to a
file if you want a persistent log: `npm start > server.log 2>&1`. The `events` table in the
database is the authoritative, append-only audit trail of every scan/undo/finish/handover —
export it any time via `/admin` → Exports → `events.csv`.
