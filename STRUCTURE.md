# Bermuda Sort Station — Project Structure

> Companion to `PLAN.md`. **PLAN.md says *what* and *why*. This file says *where* and *how the code is organised*.** If they ever disagree, PLAN.md §5 (business rules) wins.

---

## 1. Big picture

```
 ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
 │  Station 1   │   │  Station 2   │   │  Station N   │   operator devices (browser + scanner)
 │  /station    │   │  /station    │   │  /station    │   each works ITS OWN tote
 └──────┬───────┘   └──────┬───────┘   └──────┬───────┘
        │  HTTP (LAN)      │                  │
 ┌──────┴──────────────────┴──────────────────┴───────┐
 │        Admin / Lead browser  (/admin)               │   dump upload, handover, station board
 └──────────────────────────┬──────────────────────────┘
                            │
                ┌───────────┴───────────┐
                │   Node.js server      │  ONE process = ONE source of truth
                │  api/  →  services/   │  every change handled one at a time
                │           →  core/    │  pure business rules (tested)
                │           →  db/      │  SQLite write-through + events log
                └───────────┬───────────┘
                            │
                    data/bermuda.db  (+ backups/)
```

**Shared by all stations:** one dump (tote pool), 240 planned locations (no overflow, 60-tote rack, rev. 03-Oct-2026), PID homes, the handover list.
**Per station:** open tote, undo, operator, scan history.

---

## 2. Repository layout

```
bermuda-sort-station/
├── PLAN.md                 # complete plan (rules, tests, milestones) — read first
├── STRUCTURE.md            # this file
├── CLAUDE.md               # instructions for Claude Code (see §9)
├── RUNBOOK.md              # floor ops: start/stop, IP, backup/restore (M5)
├── package.json
├── .env.example            # PORT=8080, DB_PATH=data/bermuda.db, TZ=Asia/Kolkata
│
├── src/
│   ├── server.js           # boot: open DB → load state → start HTTP on 0.0.0.0:PORT
│   ├── config.js           # env + defaults (shift times, port, paths)
│   │
│   ├── core/               # PURE logic — no HTTP, no DB, no Date.now() inside (time is passed in)
│   │   ├── state.js        # newState(), settings, buildLocations(), recount()
│   │   ├── csv.js          # parseCSV() — text-only parsing, BOM-safe
│   │   ├── dump.js         # loadDump() — merge rules (new / refresh / skip taken / conflicts)
│   │   ├── labels.js       # normalize() — LEFT(12) tote / RIGHT(12) barcode
│   │   ├── allocate.js     # assign(), outstanding(), trimReservations()
│   │   ├── scan.js         # scan(st, station, raw, now), undoLast(st, station), finishTote(st, station, now)
│   │   ├── handover.js     # handoverSuggestion(C,R,N), buildHandover(), handOver()
│   │   ├── recommend.js    # recommend(st, {limit, excludeTotes})
│   │   ├── shift.js        # shiftOf(date), shiftEnd(date), minutesToShiftEnd()
│   │   └── index.js        # re-exports (the only import point for services/)
│   │
│   ├── db/
│   │   ├── schema.sql      # tables in §5
│   │   ├── migrate.js      # create/upgrade schema (PRAGMA user_version)
│   │   ├── load.js         # DB → in-memory state at boot
│   │   └── persist.js      # write-through helpers: saveBarcode, saveLoc, saveTote, appendEvent …
│   │
│   ├── services/           # glue: call core, persist the diff, all inside ONE transaction
│   │   ├── mutate.js       # runMutation(fn) → db.transaction(() => { fn(); persist; event })()
│   │   ├── scanService.js
│   │   ├── toteService.js  # finish, force-release
│   │   ├── dumpService.js
│   │   ├── handoverService.js
│   │   ├── stationService.js
│   │   ├── authService.js  # login (station + name + PIN), sessions, roles
│   │   ├── importPilot.js  # one-time import of pilot backup JSON
│   │   └── exportService.js# CSVs with UTF-8 BOM
│   │
│   ├── api/
│   │   ├── routes.js       # all routes from PLAN §9
│   │   ├── auth.js         # middleware: token → {user, role, station}
│   │   └── errors.js       # uniform {ok:false, error} responses
│   │
│   └── jobs/
│       └── nightlyBackup.js# 22:15 copy of DB file → backups/, keep 14 days
│
├── public/                 # static pages served by the server (no build step)
│   ├── station/            # operator screen: login, scan, finish, next tote, OFFLINE
│   │   ├── index.html
│   │   ├── station.js
│   │   └── station.css
│   ├── admin/              # lead/admin: dump, handover, lookup, status, station board, alerts, settings
│   │   ├── index.html
│   │   ├── admin.js
│   │   └── admin.css
│   └── shared/
│       ├── api.js          # fetch wrapper, token, OFFLINE detection (3 s)
│       ├── sounds.js       # ok / error beeps
│       └── ui.css          # colours: place green, extra orange, aside grey, error red, tote purple
│
├── test/
│   ├── fixtures/
│   │   └── sample_dump.csv # 25-09-2026 export (or a trimmed copy) — never edited
│   ├── core/
│   │   ├── handover.test.js    # the 6-row table in PLAN §5.3
│   │   ├── labels.test.js      # LEFT/RIGHT 12 cases
│   │   ├── allocate.test.js    # cap 100 / plan 95 / 20 PIDs, NO SPACE when full, never move
│   │   ├── dump.test.js        # counts, skip taken, conflicts, mangled tote_simplified ignored
│   │   └── recommend.test.js   # excludes open totes, N stations get N different totes
│   ├── replay.test.js          # full backlog with 2 / 4 / 8 stations → 0 NO SPACE, recount OK
│   └── concurrency.test.js     # 8 stations × 300 parallel HTTP scans → no overfill, no double place
│
├── data/                   # runtime DB (git-ignored)
├── backups/                # nightly DB copies (git-ignored)
└── reference/
    └── pilot/Bermuda_Sort_Station.html   # the single-station pilot, for UI and logic reference
```

---

## 3. Layer rules (keep these strict)

| Layer | May use | Must NOT |
|---|---|---|
| `core/` | Only its own files | Import db, http, fs; call `Date.now()` (take `now` as a parameter); throw for business outcomes (return `{type:'error', msg}`) |
| `services/` | core, db | Contain business rules (only call core) |
| `db/` | better-sqlite3 | Contain business rules |
| `api/` | services | Touch state or db directly |
| `public/` | HTTP API only | Hold any business logic apart from display |

**Why this matters:** `core/` is the tested pilot logic. Keeping it pure means the same tests keep proving it, and it moves unchanged to IT hosting or PostgreSQL later.

---

## 4. How one scan flows (the critical path)

```
Station browser                    Server (single process)
───────────────                    ───────────────────────────────────────────────
scan "TL0000018463-83-2" ──POST /api/scan──►  auth → station S, operator O, shift = shiftOf(now)
                                             runMutation(() => {
                                               raw → labels.normalize()      → "TL0000018463"
                                               core.scan(st, S, code, now)   → open tote, lock to S
                                               persist changed rows + event
                                             })            ← one SQLite transaction
◄── {type:'tote', tote_progress} ───────────
scan "…CCC162221732" ─────────────────────►  normalize → "CCC162221732"
                                             core.scan → assign() picks location (shared)
                                             persist barcode, loc_pid, location.used, pids, event
◄── {type:'place', loc:'A1-T01-P1', pid} ── station shows big green location + beep
```

- **Serialization:** Node handles one request at a time, and `runMutation` is synchronous inside a `better-sqlite3` transaction. Two stations' scans can therefore never interleave halfway through.
- **Failure:** if the transaction throws, the in-memory state must be restored. Clone the touched objects before mutating, or reload them from the DB, and return an error so the station shows red.

---

## 5. Database schema (SQLite, `src/db/schema.sql`)

```sql
PRAGMA journal_mode = WAL;

CREATE TABLE settings   (key TEXT PRIMARY KEY, value TEXT NOT NULL);           -- JSON values

CREATE TABLE locations  (code TEXT PRIMARY KEY, aisle INT, tote INT, part INT,
                         used INT DEFAULT 0);  -- is_overflow still exists physically (vestigial,
                                                -- write-only) but is no longer part of the logical model

CREATE TABLE loc_pid    (location_code TEXT, pid TEXT, placed INT DEFAULT 0, reserved INT DEFAULT 0,
                         PRIMARY KEY (location_code, pid));

CREATE TABLE totes      (tote_id TEXT PRIMARY KEY, tote_number TEXT, state TEXT CHECK(state IN ('H','O','C')),
                         load_id INT, station_id INT, operator TEXT, shift TEXT,
                         opened_at TEXT, closed_at TEXT);

CREATE TABLE barcodes   (barcode TEXT PRIMARY KEY, pid TEXT NOT NULL, tote_id TEXT, partition TEXT,
                         processable INT, state TEXT CHECK(state IN ('H','P','O','N','X')),
                         location_code TEXT, placed_at TEXT, placed_station INT, placed_shift TEXT,
                         nf_at TEXT, ho_at TEXT);
CREATE INDEX ix_barcodes_pid   ON barcodes(pid, state);
CREATE INDEX ix_barcodes_tote  ON barcodes(tote_id, state);

CREATE TABLE pids       (pid TEXT PRIMARY KEY, r INT, c INT, h INT, n INT);    -- cached; must equal recount

CREATE TABLE loads      (id INTEGER PRIMARY KEY, file_name TEXT, loaded_at TEXT, loaded_by TEXT,
                         rows INT, new_totes INT, refreshed INT, skipped_taken INT, conflicts INT);

CREATE TABLE events     (id INTEGER PRIMARY KEY, ts TEXT, shift TEXT, station_id INT, operator TEXT,
                         type TEXT, open_tote TEXT, input_raw TEXT, barcode TEXT, result TEXT,
                         location_code TEXT, pid TEXT, detail TEXT);             -- append-only
CREATE INDEX ix_events_ts ON events(ts);

CREATE TABLE alerts     (id INTEGER PRIMARY KEY, ts TEXT, type TEXT, message TEXT,
                         resolved_by TEXT, resolved_at TEXT);

CREATE TABLE users      (id INTEGER PRIMARY KEY, name TEXT UNIQUE, role TEXT CHECK(role IN ('admin','lead','operator')),
                         pin_hash TEXT, active INT DEFAULT 1);

-- rev. 03-Oct-2026: one row per batch (PLAN.md §6.1) — id, status (planned/active/completed),
-- created_at, started_at, completed_at, created_by, tote_ids (JSON), projected (JSON),
-- actual (JSON), note
CREATE TABLE route_history (id INTEGER PRIMARY KEY, status TEXT, created_at TEXT, started_at TEXT,
                         completed_at TEXT, created_by TEXT, tote_ids TEXT, projected TEXT,
                         actual TEXT, note TEXT);

CREATE TABLE stations   (id INTEGER PRIMARY KEY, name TEXT UNIQUE, active INT DEFAULT 1,
                         current_operator TEXT, open_tote TEXT, last_scan_barcode TEXT, last_seen TEXT);

CREATE TABLE sessions   (token TEXT PRIMARY KEY, user_id INT, station_id INT, created_at TEXT, expires_at TEXT);
```

**State codes:**
- Barcodes: `H` waiting in a tote, `P` placed, `O` handed over, `N` not found, `X` set aside.
- Totes: `H` waiting, `O` open, `C` closed.

---

## 6. Core function contracts (what services call)

| Function | Input | Returns | Side effects (in-memory) |
|---|---|---|---|
| `loadDump(st, text, fileName, now)` | CSV text | `{ok, rows, newTotes, refreshed, noTote, skippedTaken[], conflicts[], warn[]}` | Adds/refreshes totes & barcodes, recount |
| `normalize(st, raw)` | Scanner string | Tote ID or barcode | none |
| `scan(st, stationId, raw, now)` | Station + scan | `{type, loc?, pid?, ov?, msg?}` | Opens tote for station / places barcode / sets aside |
| `undoLast(st, stationId)` | Station | Barcode or null | Reverts that station's last scan only |
| `finishTote(st, stationId, now)` | Station | `{tote, n, notFound[]}` | Not-found marking, trim reservations, unlock tote |
| `handoverSuggestion(C, R, N)` | Counts | `{give, keep, why, risk?, under5?}` | none |
| `buildHandover(st)` | — | `{lines[{loc,pid,qty}], plan[{pid,give,keep,why}]}` | none |
| `handOver(st, pid, qty, now, idx?)` | PID, qty | Handed count | Frees space, trims reservations |
| `recommend(st, {limit, excludeTotes})` | — | `{list[{tote,n,size,proc,value,completes,score,fits}], total, free}` | none |
| `summary(st)` | — | KPIs | none |

**The persistence diff:** each core mutation should report which barcodes, locations, loc_pid rows, totes and pids it touched. For example, core functions can push keys into a `st._dirty` set. `persist.js` then writes only those rows.

---

## 7. Screens (public/)

| Page | Users | Contents |
|---|---|---|
| `/station` | Operator | Login (station, name, PIN) → **Next tote** card (skips totes open elsewhere) → scan input (always focused) → big coloured result → tote progress, Undo, Finish tote → last scans. Full red **OFFLINE — STOP SCANNING** when the server can't be reached. Shift-end banner at T-45. |
| `/admin` → Dump | Lead/Admin | Upload CSV, load report, ranked waiting totes |
| `/admin` → Handover | Lead | Tick location/PID rows → **Release selected** (confirm popup). Release = handed over & processed; no separate Confirm button. At-risk list. Separate **/admin → Handover log** tab (not embedded in Handover): date range, **Export CSV**,, units processed, entries, PIDs, per-day totals, who/when/where/qty per release; reads `events`, no extra table) |
| `/admin` → Stations | Admin | **Live station board** (operator, open tote, scans/hour, last seen); add/rename/deactivate stations; force-release tote |
| `/admin` → Lookup | All | PID / location / barcode search |
| `/admin` → Status | All | KPIs, aisle fill map (440 cells), alerts, CSV exports |
| `/admin` → Settings | Admin | Layout, capacity, headroom, PID cap, handover interval, users & PINs, pilot import |

---

## 8. Configuration & conventions

- **Time:** all timestamps are local `Asia/Kolkata` strings `YYYY-MM-DD HH:MM:SS`. Shift comes from `shift.js` (A 06–14, B 14–22, else OFF).
- **IDs:** tote IDs and barcodes are uppercase strings, PIDs are strings. Never convert any of them to numbers.
- **CSV out:** UTF-8 with BOM, CRLF, quoted when needed, so Excel opens it cleanly.
- **Settings defaults (rev. 03-Oct-2026):** aisles 3, totes/aisle 20, last aisle 20 totes (240 locations total, no overflow), cap 100, headroom 5%, max PIDs 20, batch size 50, handover interval = shift end, tote overhead in the score = 15.
- **Logging:** every mutation writes one `events` row, and nothing is ever deleted. Reports read from `events`.
- **No silent failures:** any unexpected error turns the station screen red with "Call admin" and logs the error on the server.

---

## 9. Suggested `CLAUDE.md`

```md
# Bermuda Sort Station
- Read PLAN.md and STRUCTURE.md before any change.
- Business rules in PLAN.md §5 are fixed. Do not change them without the owner's approval.
- core/ must stay pure (no db/http/fs, time passed in). Port logic from PLAN.md Appendix A; don't redesign it.
- Build one milestone at a time (PLAN.md §11). Run `npm test` and keep it green before moving on.
- Never convert pid/barcode/tote to numbers. Never trust tote_simplified.
- Any number of stations: nothing may assume a fixed station count.
```

---

## 10. Milestones → folders

| Milestone | Touches |
|---|---|
| M1 Core port + tests | `src/core/*`, `test/core/*`, `test/replay.test.js` |
| M2 Server + storage | `src/server.js`, `src/db/*`, `src/services/mutate.js`, `importPilot.js` |
| M3 Station screens (N stations) | `src/api/*`, `scanService`, `toteService`, `stationService`, `authService`, `public/station/*`, `test/concurrency.test.js` |
| M4 Lead/admin | `dumpService`, `handoverService`, `exportService`, `public/admin/*` |
| M5 Hardening | `src/jobs/nightlyBackup.js`, `RUNBOOK.md`, Dockerfile (for IT) |
