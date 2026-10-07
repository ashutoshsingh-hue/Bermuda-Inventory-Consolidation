# Bermuda Sort Station — Complete Build Plan (multi-station)

> **Owner:** Ashutosh Singh — Planning & Process Excellence, Lenskart Bhiwadi
> **Version:** Final, 28-Sep-2026. This replaces v1 and v2. It's the single source of truth: what the single-station pilot proved, and the target of **any number of stations working at the same time**. All stations share **one dump** and **one set of locations**, and each station works **its own tote**.
> **Companion file:** `STRUCTURE.md` covers the project layout, modules, schema and conventions.
> **How to use:**
> - Put this file in the repo root as `PLAN.md`.
> - Create a `CLAUDE.md` that says "Follow PLAN.md; business rules in §5 are fixed".
> - Build milestone by milestone (§11).
> - **Appendix A** holds the tested pilot logic (`core.js`). Port it; don't re-invent it.

---

## 1. Why this exists (one paragraph)

"Bermuda" inventory (NEXS `NOT_FOUND`/`NOT_FOUND_HOLD`) comes back through **PID Hunter** into totes, and barcodes of the same PID end up scattered. On the 25-09-2026 backlog:

- 2,171 processable PIDs with 46,355 barcodes sat in 35,670 tote-partitions, about 1.3 barcodes of a PID per location.
- Fixed-slot and wave methods failed: slots deadlocked, and waves rescanned the same totes.

**The fix:** scan every barcode **once**, drop it into a **system-assigned location** in dedicated aisles, and hand PIDs to processing under a rule that never leaves 1–4 behind.

## 2. What already exists — the single-station pilot

`Bermuda_Sort_Station.html` is an offline file on one laptop that stores its data in IndexedDB. It is live on the floor with 1 operator. It proves the logic in Appendix A:

- A full simulation of the 25-09 backlog, with handover at every shift end:
  - 45,718 barcodes handed over in 10 shifts.
  - **0 "no space" errors**.
  - No partition went over 120 barcodes or 20 PIDs.
  - Peak load in the aisles was about 15,000 barcodes.
- Recommended tote order compared with file order: **+24% barcodes handed over in shift 1**, and ahead by about 1,000–3,000 in every shift after that.
- Without shift-end handover the aisles fill up after about 130 totes, so **handover is mandatory**.

**What the pilot cannot do:** run more than one station. Each copy would hand out locations separately and they would clash. The pilot also keeps one global open tote and one global undo. **This build fixes that with one shared server that any number of stations connect to.**

**Migration requirement:** the server must **import the pilot's backup JSON** (Settings → Download backup) so no floor progress is lost when switching over.

## 3. Operating facts

| Item | Value |
|---|---|
| Shifts (Asia/Kolkata) | A 06:00–14:00 · B 14:00–22:00 · nothing 22:00–06:00 |
| Operators / stations | **Any number** per shift (2 today; the more the better). Each station is one operator with one device and scanner, working its own tote |
| Scan rate | ~350 barcodes/hour/operator (1 tote ≈ 1 hour) |
| Capacity | ~5,600 scans/shift, ~11,200/day (plan with 10,000). Backlog takes about 6 working days, then inflow of ~2,000/day |
| Processing | Not a constraint — every bunch handed over gets processed |
| Hardware | Mixed: laptop with USB scanner and Android handhelds (keyboard-wedge, Enter suffix). Stable WiFi/LAN |
| Operator UI | English, extremely simple, colour + big location code, no reading. Operators are 10th-pass |
| Build/run | On the owner's laptop, built with VS Code and Claude Code. Stations open it in a browser over the LAN. Lenskart IT will host it later |

## 4. Source data — PID Hunter dump (daily CSV)

**Columns:**
```
pid,barcode,status,condition,availability,scan_location,tote,tote_simplified,tote_number,partition,scanned_at,nexs_location
```

- **Taken totes disappear from PID Hunter.** When a tote is taken for sorting it is removed from PID Hunter and vanishes from later dumps. The system is the only record of its contents from then on.
- **Never trust `tote_simplified`.** Excel turns "4-2" into "04-Feb". Derive the partition as `tote_number-partition`.
- **Parse all fields as text.** Accept UTF-8 with or without BOM.
- **Skip rows with an empty tote**, and report how many were skipped.
- **Merging a dump:**
  - Add totes the system hasn't seen before.
  - **Ignore totes already taken**, and alert if they appear: "not removed from PID Hunter".
  - Refresh totes that are still waiting in PID Hunter.
  - If a barcode already placed or handed over appears in a dump, raise a conflict alert and skip it.
  - If a not-found barcode reappears, accept it again.
- **Load time:** ~22:00 after shift B, or before shift A. Who loads it is still open (§12).

### 4.1 Scanner label formats (confirmed on the floor)

| Label | Contains | Extract |
|---|---|---|
| Tote label | Tote ID **+ partition** | `LEFT(scan, 12)` → e.g. `TL0000018463` |
| Barcode label | Link/prefix **+ barcode** | `RIGHT(scan, 12)` → e.g. `CCC162221732` |

**Rules:**
1. An exact match to a tote or barcode wins.
2. Otherwise, if the first 12 characters match a known tote, it's a tote. If the last 12 match a known barcode, it's a barcode.
3. If neither matches, treat anything starting with `TL` as a tote and anything else as a barcode (last 12).

Implemented in `normalize()`. **Test with real labels before go-live.**

### 4.2 Camera scanning (phone / mobile mode)

- The station screen shows a **Scan with camera** button, only when the browser allows a camera (HTTPS or localhost, see §7). It opens the rear camera, decodes with the local ZXing library (`public/vendor/zxing.min.js`; Code 128, Code 39, EAN-13/8, UPC-A, ITF, QR) and hands the text to the same scan call as a hardware scanner (`public/station/camera.js`).
- The server treats it like any scan: `normalize()` applies the §4.1 rules (tote = first 12, barcode = last 12). The decoded value is always a **string** (never a number). The same code within 2 s is ignored.
- A phone is just another station: same login, tote offers and locks. No new business rules.
- Camera reading is slower than a laser scanner and can miss small or glossy labels — use it for overflow or spot work and test with real labels first.

## 5. Business rules — fixed (change only with owner sign-off)

> **Change log:** 03-Oct-2026, owner-approved — moved to the 60-tote rack / 50-tote batch
> operating model (§5.5, §5.6, §6) and made eligibility settings-driven (§5.1). Everything
> else in this section is unchanged by that revision unless noted inline.

### 5.1 Processable
- A barcode is processable when its `status` is in `settings.processableStatus` **and** its `availability` is in `settings.processableAvailability` — both editable in Admin → Settings, read live by `loadDump()` rather than hard-coded. Defaults: `status ∈ {AVAILABLE}`, `availability ∈ {AVAILABLE, NOT_FOUND, NOT_FOUND_HOLD}`. Anything else scans as **SET ASIDE**.
- For each PID, the system tracks:

| Count | Meaning |
|---|---|
| **R** | Still in totes (waiting in PID Hunter, or in an open tote and not yet scanned) |
| **C** | Placed in the aisles |
| **H** | Handed over |
| **N** | Not found |

  Active total **T = C + R**.
- Category by active total: **Big** is T ≥ 10, **Small** is 5–9, **Under-5** is under 5. Under-5 PIDs are still placed, and they wait.
- No 72-hour ageing rule. Process everything.

### 5.2 Never leave 1–4 behind
After any handover, what's left of a PID (C + R) must be **0 or ≥ 5**.

### 5.3 Handover — `handoverSuggestion(C, R, N)`
**Made explicit (03-Oct-2026, owner-approved):** `give` is only ever **0**, **≥ 5**, or **exactly
`C` with `R = 0`** (a PID's final remainder, however small, once nothing more of it is coming).
There is no other case — a give of 1–4 never happens, and after any handover `C + R` left is
always **0 or ≥ 5** (§5.2). The branches below are exactly how that holds in every case:
- **C = 0:** nothing to hand over.
- **Small (5 ≤ T ≤ 9) with R > 0:** wait until everything is collected.
- **R = 0 and C < 5:**
  - If N > 0, it is **AT RISK**. Admin releases it manually and it goes back through PID Hunter.
  - Otherwise it is under-5 and waits for new stock.
- **T < 5:** under-5, wait.
- **R = 0 or R ≥ 5:** hand over **all C**, once `C ≥ giveMin` (owner-approved `GIVE_MIN = 5`
  override — see below). This applies even when `R` isn't 0, and is how big PIDs clear once a
  batch (or shift) ends.
- **1 ≤ R ≤ 4:** keep `h = 5 − R` and hand over `C − h` (always ≥ `giveMin` by construction,
  since this branch only runs once `T ≥ 10`). Otherwise wait.
- **Owner override:** PLAN.md's original text (just above) said "R = 0 or R ≥ 5: hand over all
  C, even when C is under 5" — the owner explicitly rejected that: a give under 5 is never
  worth an operator trip. So `R ≥ 5` with `C < 5` now waits instead of giving the small batch;
  `R = 0` is unaffected (that's the PID's genuine final remainder, always handed over in full).

These cases must pass as unit tests:

| C | R | Hand over | Keep |
|---|---|---|---|
| 6 | 6 | 6 | 0 |
| 8 | 4 | 7 | 1 |
| 20 | 3 | 18 | 2 |
| 3 | 12 | 3 | 0 |
| 5 | 2 | 0 | 5 |
| 7 | 0 | 7 | 0 |

- **When:** at shift end (A 14:00, B 22:00). Small PIDs appear on the list as soon as they are complete.
- **Pulling barcodes:** take from the locations holding the fewest of that PID first.

### 5.4 Totes
- **Open a tote:** the operator scans the tote label. That tote is **locked to that station**. Another station scanning it gets "Tote open at Station X".
- **One open tote per station.** ~~Totes never carry over between shifts~~ — **removed by owner request (2026-09-29).** There is no shift-end warning and no automatic force-finish; a tote stays open until an operator finishes it or an admin force-releases it, regardless of the clock.
- **Finish tote** (whole tote):
  - Processable barcodes that weren't scanned become `NOT FOUND`, with R reduced and N increased.
  - Unused space reserved for the affected PIDs is released (`trimReservations`).
  - The not-found list can be downloaded for NEXS.
- **Admin acknowledgement of not-found** is in milestone M4. Until then, the finish is provisional-final.
- **Extra barcodes** (belonging to another tote) are placed normally and flagged as EXTRA.
- **Found later:** a not-found barcode that gets scanned is reinstated and flagged FOUND_LATER.

### 5.5 Location layout (editable settings)
**Rev. 03-Oct-2026, owner-approved — the 60-tote rack:** physical layout is 3 aisles × 20 totes
× 4 partitions = **240 locations, all planned — 240 is the absolute hard cap. There is no
overflow** (the earlier 5-aisle/overflow model, and the 400-location model that briefly
replaced it, are both superseded; see Appendix A's note and git history for that lineage).
Codes look like `A{a}-T{tt}-P{p}`, e.g. `A2-T27-P3`. **Tote numbers run continuously across the rack** (owner, 06-Oct-2026): A1 = T01-T20, A2 = T21-T40, A3 = T41-T60, matching the physical tote labels 1-60. `lastAisleTotes` lets the final aisle be a
different length than the rest if ever needed; by default it equals `totesPerAisle` (a uniform
grid).
- **Capacity:** **100** barcodes per partition physically, with **5% spare room**, so the
  system plans for **95**. At most **20 PIDs** per partition.
- **Batch reservations (§6):** while a batch (Route) is active, a PID's reservation is sized
  from how much of it is still waiting *inside that batch's own totes* (`st.routeR`), not the
  whole remaining dump — see §5.6 and §6.

### 5.6 Location assignment — `assign()` (tested, port as is)
**Rev. 03-Oct-2026, owner-approved:** the earlier dedicated/sharedLarge/sharedSmall size-class
separation is removed. Any PIDs may now share a partition together, limited only by the plan
cap and the PID-per-partition cap below — simpler, and the earlier separation was measured to
waste space (many "Big" PIDs are actually modest and were getting a whole partition to
themselves at ~20% utilization).

Every barcode goes to a location the system chooses:
1. If the PID already has a location with reserved space left and room under 100, use it.
2. Otherwise, if the PID has a location still under the plan limit, grow its reservation by 1.
3. Otherwise open a new location **best-fit**: the free space closest to what the PID still
   needs, where need = `min(remaining + 1, 95)`. **`remaining` is `R` normally, or — while a
   batch is active — that PID's count in `routeR` instead (§6): only what's still waiting in
   *this batch's* totes, not the whole dump.** Free space counts both placed and reserved
   barcodes, and the location must have fewer than 20 PIDs.
4. If no single location fits, reserve part of the need in the location with the most free
   space, as long as at least `min(need, 5)` fits.
5. Otherwise show **NO SPACE** and ask the operator to call admin — 240/240 is a hard stop,
   never an overflow fallback.

Placed barcodes are **never moved**.

### 5.7 Tote recommendation — `recommend()` (tested)
- **What counts as progress:** barcodes in a tote that move a PID toward handover:
  - Big PID: every barcode counts.
  - Small PID: counts in proportion to how much of what's left this tote covers. Full credit, plus the barcodes already placed, when this tote **completes** the PID.
  - Under-5: counts 0.
- **Score** = progress ÷ (barcodes in the tote + **15**). The 15 stands for about 2.5 minutes to fetch and open a tote; it's an assumption to tune.
- **Space check:** a tote is flagged "No space" if the new PIDs it brings wouldn't fit the free planned space.
- **Ordering:** totes that fit come first, then by score.
- **Multi-station:** totes open at any station are skipped, so each station's "next tote" is the best one nobody else has open. Two stations are never sent to the same tote.
- **Batch-scoped (03-Oct-2026):** while a batch (Route) is active, only that batch's own waiting
  totes are ever offered — never a tote from outside the current batch, even if it would
  otherwise score well (§6).

## 6. Multi-station operation (the core of this build)

**Shared by all stations:** one dump (one pool of totes), one set of 240 locations with the same space counts and PID homes, and one handover list.

**Per station:** the open tote, the undo, and who scanned what.

**Simulated capacity on the 25-09 backlog** (350 scans/hour per station, full shifts, recommended order) — **historical, from the earlier 400-location/5-aisle model, superseded by §6.1's batch model below:**

| Stations | Shifts to clear | Most barcodes in aisles at once | NO SPACE errors |
|---|---|---|---|
| 2 | 10 | 14,789 | 0 |
| 4 | 5 | 17,473 | 0 |
| 6 | 4 | 21,791 | 0 |
| 8 | 3 | 24,802 | 0 |

**Current reference (03-Oct-2026, 60-tote rack / 240 locations, real dump, 50-tote batches,
handover after every batch):** 0 NO SPACE, 55,781 barcodes handed over, peak 17,237 pieces
placed at once across 209 of 240 locations — see `test/replayRealDump.test.js`, which runs the
repo's actual PID Hunter export through this exact lifecycle on every `npm test`.

### 6.1 Batch operation (50 totes)

Replaces processing the whole backlog as one undifferentiated pool. The lead works through the
remaining source totes **100 at a time at first, 50 at a time from 03-Oct-2026** (`settings.batchSize`):

1. **Lead starts a batch** (`/admin` → Route → Propose → Start): the next `batchSize` waiting
   totes become the **active route**. `st.routeR[pid]` is computed — processable barcodes of
   that PID still `H` *inside this batch's totes only* — and reservations (§5.6) are sized from
   that, not the whole dump's `R`.
2. **Stations scan** as normal (§5.4), but only this batch's totes are offered (§5.7) or
   accepted (a tote outside the active batch is rejected: "Tote not in current batch — ask
   lead" — a lead/admin can override).
3. **Lead completes the batch** (`/admin` → Route → Complete): every outstanding (unused)
   reservation collapses to exactly what's physically placed — nothing holds room reserved for
   stock that was only ever a batch-scoped estimate. The active batch ends; `routeR` is cleared.
4. **Handover**, using the real whole-dump `R` now that the batch's narrower view is gone — the
   normal `giveMin = 5` rule (§5.3) applies exactly as it would at shift end. The lead confirms
   it through the existing Handover tab, same as always.
5. Pieces not handed over (kept back under the 1–4 rule, or still under 5) **carry into the
   next batch** — nothing is lost or re-reserved, they're just ordinary placed/waiting stock
   again until the next batch's own `routeR` picks them up.
6. **Next batch**, computed from the *current* state (after this batch's actual scanning and
   handover), never from the original dump — so later batches reflect real consolidation, not a
   stale forecast.

The planned capacity is about 22,800 (240 × 95), so the software isn't the limit. The limits
are physical: walking and congestion in the aisles, devices, and the handover pulling load (see
the Station scaling row below).

| Concern | Rule |
|---|---|
| **One source of truth** | A single server process holds the live state. Stations are thin browser clients. No logic runs in the browser apart from display. |
| **No clashes** | All changes (scan, finish, handover, dump load, undo) go through the server **one at a time** (see below), so no two stations can ever overfill a location or get the same barcode placed twice, however many stations are connected. |
| **Per-station state** | `openTote` and `lastScan` (undo) become **per station**, not global. Undo only undoes that station's own last scan, and only if nothing else has touched that barcode. |
| **Tote lock** | A tote belongs to one station while open. Admin can force-release a tote if a station crashes. |
| **Next tote per station** | The recommendation excludes totes open at other stations (§5.7). |
| **Server connection lost** | If a station can't reach the server, it shows a red full screen: **"OFFLINE — STOP SCANNING"**. There is no offline queue, because the LAN is stable and an offline queue risks double placement. |
| **Identity** | A station logs in once per shift with station number + operator name + a PIN. Every event records station, operator and shift (shift worked out from the clock). |
| **Handover while scanning** | Allowed. Handover is one change like any other, and only the admin or shift lead can confirm it. |
| **Live views** | The admin dashboard refreshes every 5 seconds (polling, or SSE if simple). Stations get their updates in the scan response. |
| **Stations are data, not code** | Admin adds or renames stations (Station 1…N). There's no hard-coded count anywhere. |
| **Live station board** | Admin sees each station's operator, open tote, scans in the last hour, and last activity. Stations idle for more than 10 minutes are highlighted. |
| **Handover interval** | A setting: shift end by default (14:00 / 22:00). It can be set to every X hours for many stations, so the aisles and the pulling list stay small. |
| **Station scaling (optional)** | At 6+ stations, add a **placer** role: operators scan and drop into a staging tray, and a placer screen lists tray → location moves. It's off by default. |

**How changes are serialized:** a single Node.js process with an in-memory model. Every change runs synchronously inside one **SQLite transaction** (`better-sqlite3`). Because the event loop handles one request at a time, changes are serialized without locks.

## 7. Recommended stack (why it changed from v1)

v1 suggested Python FastAPI + PostgreSQL + React. **This build uses Node.js**, because the tested logic in Appendix A is JavaScript and can be reused as-is on the server. That removes the risk of re-implementing the rules.

| Part | Choice |
|---|---|
| Runtime | Node.js 20 LTS |
| HTTP | Fastify, or Express if simpler |
| Storage | SQLite via `better-sqlite3` (file `data/bermuda.db`, WAL mode). The data model is portable to PostgreSQL when IT hosts it. |
| Frontend | Plain HTML + JS pages served by the server, starting from the pilot's screens. No build step needed. React only if it clearly helps later. |
| Tests | `node:test` (built in). Unit tests for §5 and a replay test on the sample dump (§10). |
| Packaging | `npm start` on the laptop. Add a Dockerfile for IT later. |
| LAN | Server listens on `0.0.0.0:8080`. Stations open `http://<laptop-ip>:8080`. The Windows firewall must allow inbound 8080. Set a fixed IP for the laptop, or a DHCP reservation. |
| HTTPS (same port) | Port 8080 serves **both** plain HTTP and HTTPS (`src/portMux.js`): the first byte of a connection (0x16 = TLS) decides. Operator PCs keep `http://`; phones use `https://<host>:8080`. The app itself listens on loopback `127.0.0.1:8081` (port + 1) behind it. Needs `certs/key.pem` + `certs/cert.pem` (self-signed, SAN = host name + IPs); if missing, the server falls back to plain HTTP on 8080 and the camera is unavailable. Browsers only allow camera access on HTTPS or localhost. |

If IT mandates a different stack later, `core/` (pure logic) and the API contract (§9) carry over unchanged.

## 8. Data model (SQLite)

| Table | Columns (key ones) |
|---|---|
| `settings` | key, value (JSON) |
| `locations` | code PK, aisle, tote, partition, used (`is_overflow` column still exists physically but is vestigial/write-only since the overflow concept was removed — see §5.5) |
| `loc_pid` | location_code, pid, placed (c), reserved (r) — PK (location_code, pid) |
| `totes` | tote_id PK, tote_number, state (H waiting / O open / C closed), load_id, station, operator, opened_at, closed_at, shift |
| `barcodes` | barcode PK, pid, tote_id (source), partition, processable, state (H/P/O/N/X), location_code, placed_at, placed_station, placed_shift, nf_at, ho_at |
| `pids` | pid PK, R, C, H, N (cached counts; must match a full recount) |
| `loads` | id, file_name, loaded_at, loaded_by, rows, new_totes, refreshed, skipped_taken, conflicts |
| `events` | id, ts, shift, station, operator, type (scan/tote/finish/undo/handover/load/release/ack), open_tote, input_raw, barcode, result, location, pid, detail JSON — **append-only** |
| `alerts` | id, ts, type (TAKEN_TOTE_IN_DUMP / CONFLICT / UNKNOWN / EXTRA / FOUND_LATER / AT_RISK), message, resolved_by, resolved_at |
| `users` | id, name, role (admin/lead/operator), pin_hash |
| `stations` | id, name, active, current_operator, open_tote, last_scan_barcode, last_seen |
| `route_history` | id, status (planned/active/completed), created_at, started_at, completed_at, created_by, tote_ids (JSON), projected (JSON), actual (JSON), note — one row per batch (§6.1) |

On start, load everything into memory. Every change writes the affected rows plus one `events` row in the same transaction. Add a `recount` admin check that rebuilds R/C/H/N from `barcodes` and compares them with the cached counts.

## 9. API (JSON over HTTP)

| Method & path | Who | Does |
|---|---|---|
| `POST /api/login` | all | {station, name, pin} → session token |
| `POST /api/scan` | operator | {raw} → {type: tote/place/extra/aside/dup/unknown/error/info, loc, pid, msg, tote_progress} |
| `POST /api/undo` | operator | Undo this station's last scan |
| `POST /api/tote/finish` | operator | → {notFound:[…]} |
| `GET /api/next-totes?n=5` | operator | Recommendation, skipping totes open elsewhere |
| `POST /api/dump` | admin/lead | Upload CSV (multipart) → load report |
| `GET /api/handover/log?from=&to=` | lead | **Handover log** — quantity processed: every release (per location+PID, who, when, shift, qty) read from `events`, with totals, PID count and per-day sums. Date filter YYYY-MM-DD; `GET /api/handover/log.csv?from=&to=` (lead/admin) downloads the same range as CSV (UTF-8 BOM). It is its own admin tab, **Handover log**, not part of the Handover tab |
| `POST /api/consolidation/release-many` | lead | {items:[{location,pid}]} → releases exactly the ticked rows in one transaction. **Release = handed over and processed** (owner, 07-Oct-2026). The old `POST /api/handover/confirm` was removed |
| `GET /api/lookup?q=` | all | PID / location / barcode (same `normalize`) |
| `GET /api/status` | all | KPIs, aisle fill, per-station live state (station board) |
| `GET/POST /api/stations` | admin | List / add / rename / deactivate stations |
| `GET /api/alerts` · `POST /api/alerts/:id/resolve` | admin | Alerts |
| `POST /api/tote/:id/release` | admin | Force-release a tote stuck open at a crashed station |
| `GET /api/export/{locations,notfound,events}.csv` | admin | CSV exports (UTF-8 BOM) |
| `POST /api/import/pilot` | admin | Import the pilot backup JSON (one time) |
| `GET /api/route/propose` | lead | Next round of `settings.batchSize` waiting totes in dump order (Route N), plus a preview of the rounds after it (§6.1) |
| `GET /api/route/active` | all | The currently active batch, if any |
| `POST /api/route/start` | lead | {toteIds} → activates that batch, or 409 with the rejection reason if it wouldn't fit |
| `POST /api/route/complete` | lead | Releases unused reservations, the lead then ticks and releases rows on the Handover tab |
| `GET /api/route/history` | lead | Past batches: projected vs. actual |

## 10. Acceptance tests (must pass before floor use)

**Sample data:** 25-09-2026 export, or the owner's fresh dump.

| Test | Expected |
|---|---|
| Load sample | 54,045 rows; 54,035 with a tote; 184 totes; 10 without a tote ignored |
| Processable at load | ≈50.5k processable barcodes (after de-duplication), ≈2,150 PIDs with T ≥ 5 |
| Handover table in §5.3 | All 6 rows pass |
| **Replay test** | Simulate every tote in recommended order with **2, 4 and 8 stations** (stations take the next free recommended tote), handing over periodically. **0 NO SPACE errors**, no location over the plan cap or over `softPidCap` PIDs, all counts equal a full recount (`test/replay.test.js`, synthetic backlog). The **real-dump** version of this (§6.1's current reference) runs the actual PID Hunter export through the real 50-tote-batch lifecycle instead (`test/replayRealDump.test.js`) |
| **Concurrency test** | Fire scans from **8 stations** in parallel (e.g. 8 × 300 requests at the same time into PIDs that share locations). No location over capacity, no barcode placed twice, events count = requests |
| Tote lock | Any station scanning a tote open at another station → error "Tote open at Station X" |
| Undo | A station's undo never affects another station's scans |
| Next tote | With N stations open, the N stations are all offered different totes |
| Label parsing | `TL0000018463` + partition suffix opens the tote; link-prefixed barcode resolves to the last 12 characters |
| Offline | Stop the server → both stations show "OFFLINE — STOP SCANNING" within 3 s |
| Pilot import | Import the pilot backup → same placed counts per location as the pilot showed |
| Performance | Scan response under 150 ms on LAN; dump load plus recount under 10 s |

## 11. Build milestones (for Claude Code — one at a time, tests green before moving on)

1. **M1 — Core port:**
   - Move Appendix A into `core/` as ES modules, changing `openTote`/`lastScan` to per station.
   - Unit tests for §5.3, `normalize`, `assign` and `recommend`.
   - Replay test (single process, no HTTP).
2. **M2 — Server + storage:**
   - SQLite schema (§8), load on start, write-through transactions, events log.
   - Recount check and pilot import.
3. **M3 — Station screens (N stations):**
   - Login, scan and finish screens (reuse the pilot UI), next-tote per station.
   - Offline screen and sounds.
   - Concurrency test with 8 stations, tote lock, and each station offered a different next tote.
4. **M4 — Lead/admin:**
   - Dump upload and Handover tab: tick rows → Release selected (release = handover; no separate confirm step).
   - Lookup, status with aisle map and the live station board, station admin, handover interval setting.
   - Alerts, not-found acknowledgement, at-risk release, force-release tote, CSV exports.
5. **M5 — Hardening:**
   - Nightly SQLite backup: copy the DB file to `backups/` at 22:15, keeping 14 days.
   - Shift-end guards and a runbook (`RUNBOOK.md`: start/stop, IP changes, restore).

## 12. Open items

| # | Item | Current thinking |
|---|---|---|
| O1 | Who loads the dump at ~22:00 | Shift B lead with a "lead" login, owner as backup. Automatic pull later |
| O2 | Hosting | Laptop now; Lenskart IT later (Dockerfile + Postgres) |
| O3 | Inflow entry | Scan at PID Hunter intake vs a separate sort step. Undecided; design supports both |
| O4 | Operator identity | Named users with a PIN (assumed). Confirm |
| O8 | Station count per shift | Start with 2 and add stations freely. Use the placer role at 6+ if the aisles get crowded |
| O5 | Non-processable barcodes | Set aside only, not tracked further |
| O6 | Tote overhead in the score (15) | Tune after a week of real tote times from `events` |
| O7 | Label formats | Verify LEFT/RIGHT 12 with real floor labels |

---

## Appendix A — tested pilot logic (`core.js`, verbatim)

This is the exact logic running in the single-station pilot, tested on the 25-09 dump. When porting:

- `st.openTote` and `st.lastScan` become per-station fields.
- `scan()`, `undoLast()` and `finishTote()` take a `station` argument.
- `recommend()` takes `excludeTotes`.

Keep everything else identical unless a test proves a bug.

```js
/* ===== Bermuda Consolidation — core logic (no DOM) ===== */
const Core = (() => {
  const PROC_AV = new Set(['AVAILABLE', 'NOT_FOUND', 'NOT_FOUND_HOLD']);

  function defaultSettings() {
    return { aisles: 5, totesPerAisle: 22, partitions: 4, overflowAisle: 5, overflowFromTote: 13,
             cap: 120, headroomPct: 10, softPidCap: 20 };
  }
  const planCap = s => Math.floor(s.cap * (1 - s.headroomPct / 100));

  function buildLocations(s) {
    const locs = [];
    for (let a = 1; a <= s.aisles; a++)
      for (let t = 1; t <= s.totesPerAisle; t++)
        for (let p = 1; p <= s.partitions; p++)
          locs.push({ code: `A${a}-T${String(t).padStart(2, '0')}-P${p}`,
                      ov: a === s.overflowAisle && t >= s.overflowFromTote, used: 0, pids: {} });
    return locs;
  }

  function newState(settings) {
    const s = settings || defaultSettings();
    return { v: 1, settings: s, locations: buildLocations(s), barcodes: {}, totes: {}, pids: {},
             loads: [], log: [], alerts: [], openTote: null, lastScan: null };
  }

  // ---------- CSV ----------
  function parseCSV(text) {
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const rows = []; let row = [], f = '', q = false, i = 0; const n = text.length;
    while (i < n) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { f += '"'; i += 2; continue; } q = false; i++; continue; }
        f += c; i++; continue;
      }
      if (c === '"') { q = true; i++; continue; }
      if (c === ',') { row.push(f); f = ''; i++; continue; }
      if (c === '\r') { i++; continue; }
      if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; i++; continue; }
      f += c; i++;
    }
    if (f !== '' || row.length) { row.push(f); rows.push(row); }
    return rows;
  }

  function shiftOf(d) { const h = d.getHours(); return h >= 6 && h < 14 ? 'A' : h >= 14 && h < 22 ? 'B' : 'OFF'; }
  const nowISO = d => { const z = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}`; };

  function pid(st, p) { return st.pids[p] || (st.pids[p] = { R: 0, C: 0, H: 0, N: 0, locs: {} }); }
  const locByCode = (st, code) => st._idx ? st.locations[st._idx[code]] : (st._idx = Object.fromEntries(st.locations.map((l, i) => [l.code, i])), st.locations[st._idx[code]]);

  // recompute R/C/H/N counts from barcodes (processable only)
  function recount(st) {
    for (const p in st.pids) { const P = st.pids[p]; P.R = P.C = P.H = P.N = 0; }
    for (const b in st.barcodes) {
      const B = st.barcodes[b]; if (!B.pr) continue; const P = pid(st, B.p);
      if (B.s === 'H') P.R++; else if (B.s === 'P') P.C++; else if (B.s === 'O') P.H++; else if (B.s === 'N') P.N++;
    }
  }

  // ---------- Dump load ----------
  const REQ = ['pid', 'barcode', 'status', 'availability', 'tote', 'tote_number', 'partition'];
  function loadDump(st, text, fileName, now = new Date()) {
    const rows = parseCSV(text);
    if (!rows.length) return { ok: false, error: 'File is empty' };
    const hdr = rows[0].map(h => h.trim().toLowerCase()); const ix = {};
    hdr.forEach((h, i) => ix[h] = i);
    const missing = REQ.filter(c => !(c in ix));
    if (missing.length) return { ok: false, error: 'Missing columns: ' + missing.join(', ') };
    const warn = [];
    const m = /(\d{4})-(\d{2})-(\d{2})/.exec(fileName || '');
    if (m) { const fd = `${m[1]}-${m[2]}-${m[3]}`; const td = nowISO(now).slice(0, 10);
      if (fd !== td) warn.push(`File date ${fd} is not today (${td}).`); }
    const byTote = {}; let noTote = 0, total = 0;
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r]; if (row.length < hdr.length - 1) continue; total++;
      const t = (row[ix.tote] || '').trim().toUpperCase();
      if (!t) { noTote++; continue; }
      (byTote[t] || (byTote[t] = [])).push(row);
    }
    const res = { ok: true, file: fileName, rows: total, noTote, newTotes: 0, refreshed: 0, skippedTaken: [],
                  conflicts: [], foundAgain: 0, warn };
    const loadId = st.loads.length + 1;
    for (const t in byTote) {
      const T = st.totes[t];
      if (T && T.s !== 'H') { res.skippedTaken.push(t); continue; }
      if (T) { // refresh: drop its still-pending barcodes
        for (const b of T.bs) { const B = st.barcodes[b]; if (B && B.s === 'H' && B.t === t) delete st.barcodes[b]; }
        res.refreshed++;
      } else res.newTotes++;
      const first = byTote[t][0];
      const NT = { n: (first[ix.tote_number] || '').trim(), s: 'H', bs: [], load: loadId };
      for (const row of byTote[t]) {
        const b = (row[ix.barcode] || '').trim().toUpperCase(); if (!b) continue;
        const ex = st.barcodes[b];
        if (ex && (ex.s === 'P' || ex.s === 'O')) { res.conflicts.push({ barcode: b, tote: t, state: ex.s === 'P' ? 'already placed at ' + ex.l : 'already handed over' }); continue; }
        if (ex && ex.s === 'N') res.foundAgain++;
        const pr = (row[ix.status] || '').trim().toUpperCase() === 'AVAILABLE' && PROC_AV.has((row[ix.availability] || '').trim().toUpperCase());
        st.barcodes[b] = { p: (row[ix.pid] || '').trim(), t, pt: (row[ix.partition] || '').trim(), pr: pr ? 1 : 0, s: 'H' };
        NT.bs.push(b);
      }
      st.totes[t] = NT;
    }
    if (res.skippedTaken.length) st.alerts.push({ ts: nowISO(now), type: 'TAKEN_TOTE_IN_DUMP', msg: `${res.skippedTaken.length} tote(s) already taken are still in the dump (not removed from PID Hunter?): ${res.skippedTaken.slice(0, 20).join(', ')}` });
    for (const c of res.conflicts.slice(0, 200)) st.alerts.push({ ts: nowISO(now), type: 'CONFLICT', msg: `${c.barcode} in dump tote ${c.tote} but ${c.state}` });
    st.loads.push({ id: loadId, file: fileName, at: nowISO(now), rows: total, newTotes: res.newTotes, refreshed: res.refreshed });
    recount(st);
    return res;
  }

  // ---------- Location assignment ----------
  function outstanding(L) { let o = 0; for (const p in L.pids) { const e = L.pids[p]; o += Math.max(0, e.r - e.c); } return o; }
  const activePids = L => Object.keys(L.pids).length;

  function assign(st, p) {
    const s = st.settings, plan = planCap(s), P = pid(st, p);
    // 1) existing home with outstanding reservation and physical room
    for (const code in P.locs) { const L = locByCode(st, code), e = L.pids[p];
      if (e && e.c < e.r && L.used < s.cap) return code; }
    // 2) existing home with physical room (PID got more than planned)
    for (const code in P.locs) { const L = locByCode(st, code), e = L.pids[p];
      if (e && !L.ov && L.used + outstanding(L) < plan) { e.r = e.c + 1; return code; } }
    // 3) new location — best fit for the whole remaining need
    const need = Math.min(P.R + 1, plan);
    let best = null, bestFree = 1e9, big = null, bigFree = 0;
    for (const L of st.locations) {
      if (L.ov || activePids(L) >= s.softPidCap) continue;
      const free = plan - L.used - outstanding(L);
      if (free >= need && free < bestFree) { best = L; bestFree = free; }
      if (free > bigFree) { big = L; bigFree = free; }
    }
    let L = best, r = need;
    if (!L && big && bigFree >= Math.min(need, 5)) { L = big; r = bigFree; }   // partial reservation, rest goes elsewhere later
    if (!L) { // overflow
      for (const O of st.locations) if (O.ov && O.used < s.cap) { L = O; r = Math.min(need, s.cap - O.used); break; }
    }
    if (!L) return null;
    L.pids[p] = { c: 0, r }; P.locs[L.code] = 1;
    return L.code;
  }

  // shrink reservations so a PID never holds more outstanding space than it can still receive
  function trimReservations(st, p) {
    const P = st.pids[p]; if (!P) return; let allow = P.R;
    const codes = Object.keys(P.locs);
    for (const code of codes) { const L = locByCode(st, code), e = L.pids[p]; if (!e) { delete P.locs[code]; continue; }
      const o = Math.max(0, e.r - e.c), keep = Math.min(o, allow); allow -= keep; e.r = e.c + keep;
      if (e.c === 0 && e.r === 0) { delete L.pids[p]; delete P.locs[code]; } }
  }

  // ---------- Scanning ----------
  // Tote labels carry the partition (tote ID = first 12 chars, like LEFT(A2,12));
  // barcode labels carry a link prefix (barcode = last 12 chars, like RIGHT(A2,12)).
  function normalize(st, raw) {
    const v = String(raw || '').trim().toUpperCase(); if (!v) return '';
    if (st.totes[v] || st.barcodes[v]) return v;
    if (v.length > 12) {
      const left = v.slice(0, 12), right = v.slice(-12);
      if (st.totes[left]) return left;
      if (st.barcodes[right]) return right;
      if (/^TL/.test(left)) return left;
      return right;
    }
    return v;
  }
  function scan(st, raw, now = new Date()) {
    const code = normalize(st, raw); if (!code) return null;
    const sh = shiftOf(now), ts = nowISO(now);
    const out = r => { st.log.push([ts, sh, st.openTote || '', code, r.type, r.loc || '', r.pid || '']); return r; };
    if (st.totes[code]) {
      const T = st.totes[code];
      if (st.openTote === code) return out({ type: 'info', msg: `Tote ${T.n} is already open` });
      if (st.openTote) return out({ type: 'error', msg: `Finish tote ${st.totes[st.openTote].n} first` });
      if (T.s === 'C') return out({ type: 'error', msg: `Tote ${T.n} is already finished` });
      T.s = 'O'; T.openedAt = ts; T.shift = sh; st.openTote = code; st.lastScan = null;
      return out({ type: 'tote', msg: `Tote ${T.n} open`, tote: code });
    }
    if (!st.openTote) return out({ type: 'error', msg: 'Scan the TOTE first' });
    const B = st.barcodes[code];
    if (!B) { st.alerts.push({ ts, type: 'UNKNOWN', msg: `Unknown barcode ${code} scanned in tote ${st.totes[st.openTote].n}` });
      return out({ type: 'unknown', msg: 'NOT IN DATA — keep aside' }); }
    if (B.s === 'P' || B.s === 'O' || B.s === 'X') return out({ type: 'dup', msg: 'ALREADY SCANNED', loc: B.l, pid: B.p });
    const extra = B.t !== st.openTote, prev = { s: B.s, t: B.t };
    if (!B.pr) { B.s = 'X'; B.ts = ts; st.lastScan = { b: code, prev };
      return out({ type: 'aside', msg: 'SET ASIDE', pid: B.p }); }
    const P = pid(st, B.p);
    if (B.s === 'H') P.R--; else if (B.s === 'N') { P.N--; st.alerts.push({ ts, type: 'FOUND_LATER', msg: `${code} (PID ${B.p}) was not-found, now scanned in tote ${st.totes[st.openTote].n}` }); }
    const loc = assign(st, B.p);
    if (!loc) { if (prev.s === 'H') P.R++; else if (prev.s === 'N') P.N++;
      return out({ type: 'error', msg: 'NO SPACE LEFT — call admin', pid: B.p }); }
    const L = locByCode(st, loc); L.used++; L.pids[B.p].c++; P.C++;
    B.s = 'P'; B.l = loc; B.ts = ts; B.sh = sh; B.st = st.openTote;
    if (extra) { st.alerts.push({ ts, type: 'EXTRA', msg: `${code} (PID ${B.p}) belongs to tote ${B.t}, scanned in ${st.totes[st.openTote].n}` }); }
    st.lastScan = { b: code, prev };
    return out({ type: extra ? 'extra' : 'place', loc, pid: B.p, ov: L.ov });
  }

  function undoLast(st) {
    const u = st.lastScan; if (!u) return null; const B = st.barcodes[u.b]; if (!B) return null;
    if (B.s === 'P') { const L = locByCode(st, B.l), P = pid(st, B.p); L.used--; L.pids[B.p].c--; P.C--;
      if (u.prev.s === 'H') P.R++; else if (u.prev.s === 'N') P.N++; delete B.l; }
    B.s = u.prev.s; st.lastScan = null; st.log.push([nowISO(new Date()), '', st.openTote || '', u.b, 'undo', '', B.p]);
    return u.b;
  }

  function toteProgress(st, t) {
    const T = st.totes[t]; if (!T) return null; let exp = 0, done = 0;
    for (const b of T.bs) { const B = st.barcodes[b]; if (!B) continue; exp++; if (B.s !== 'H' && B.s !== 'N') done++; }
    return { exp, done };
  }

  function finishTote(st, now = new Date()) {
    const t = st.openTote; if (!t) return null; const T = st.totes[t], ts = nowISO(now), nf = [], touched = new Set();
    for (const b of T.bs) { const B = st.barcodes[b]; if (!B || B.s !== 'H' || B.t !== t) continue;
      B.s = 'N'; B.nfAt = ts; if (B.pr) { const P = pid(st, B.p); P.R--; P.N++; touched.add(B.p); nf.push([b, B.p, T.n, B.pt]); } }
    touched.forEach(p => trimReservations(st, p));
    T.s = 'C'; T.closedAt = ts; st.openTote = null; st.lastScan = null;
    st.log.push([ts, shiftOf(now), t, '', 'finish', '', String(nf.length)]);
    return { tote: t, n: T.n, notFound: nf };
  }

  // ---------- Handover (hold-back rule: never leave 1-4 behind) ----------
  function handoverSuggestion(C, R, N = 0) {
    if (C === 0) return { give: 0, keep: 0, why: 'Nothing placed' };
    const T = C + R;
    if (T >= 5 && T <= 9 && R > 0) return { give: 0, keep: C, why: `Small PID: wait until all ${T} collected` };
    if (R === 0 && C < 5) return N > 0 ? { give: 0, keep: C, why: 'AT RISK: not-found made it under 5 — admin release', risk: 1 }
                                       : { give: 0, keep: C, why: 'Under 5 — waiting for new stock', under5: 1 };
    if (T < 5) return { give: 0, keep: C, why: `Under 5 so far (${C} placed + ${R} to come)`, under5: 1 };
    if (R === 0 || R >= 5) return { give: C, keep: 0, why: R === 0 ? 'All collected' : `${R} still to come (5+)` };
    const h = 5 - R;
    if (C - h >= 1) return { give: C - h, keep: h, why: `Keep ${h} so ${h}+${R} to come = 5` };
    return { give: 0, keep: C, why: `Wait: ${C}+${R} to come` };
  }

  function pidInfo(st, p) {
    const P = st.pids[p]; if (!P) return null;
    const locs = Object.keys(P.locs).map(code => { const e = locByCode(st, code).pids[p]; return { code, placed: e ? e.c : 0, reserved: e ? e.r : 0 }; });
    return { pid: p, R: P.R, C: P.C, H: P.H, N: P.N, locs, sug: handoverSuggestion(P.C, P.R, P.N) };
  }

  function placedByPid(st) { const m = {}; for (const b in st.barcodes) { const B = st.barcodes[b]; if (B.s === 'P') (m[B.p] || (m[B.p] = [])).push([b, B]); } return m; }
  function handOver(st, p, qty, now = new Date(), idx) {
    const P = st.pids[p]; if (!P || qty <= 0) return 0; const ts = nowISO(now);
    const bs = idx ? (idx[p] || []) : Object.entries(st.barcodes).filter(([, B]) => B.p === p && B.s === 'P');
    // take from overflow first, then from locations with fewest of this PID
    bs.sort((a, b) => { const La = locByCode(st, a[1].l), Lb = locByCode(st, b[1].l);
      return (Lb.ov - La.ov) || (La.pids[p].c - Lb.pids[p].c); });
    let n = 0;
    for (const [b, B] of bs) { if (n >= qty) break; const L = locByCode(st, B.l), e = L.pids[p];
      L.used--; e.c--; e.r--; B.s = 'O'; B.hoAt = ts; P.C--; P.H++; n++;
      if (e.c <= 0 && e.r <= 0) { delete L.pids[p]; delete P.locs[L.code]; } }
    trimReservations(st, p);
    st.log.push([ts, shiftOf(now), '', '', 'handover', '', `${p}:${n}`]);
    return n;
  }

  // ---------- Tote recommendation (best clearance per scan) ----------
  // value of a tote = barcodes that move a PID toward handover:
  //   big PID (known total 10+): every barcode counts (goes at shift end)
  //   small PID (5-9): counts by how much of the PID's remaining this tote completes (full credit + already-placed when it finishes the PID)
  //   under-5: 0
  // score = value / barcodes in tote (scan time)
  const TOTE_OVERHEAD = 15; // fetching + opening a tote ≈ scanning 15 barcodes (~2.5 min)
  function recommend(st, limit = 10) {
    const s = st.settings, plan = planCap(s); let free = 0;
    for (const L of st.locations) if (!L.ov) free += Math.max(0, plan - L.used - outstanding(L));
    const out = [];
    for (const t in st.totes) {
      const T = st.totes[t]; if (T.s !== 'H') continue;
      const per = {}; let size = 0, proc = 0;
      for (const b of T.bs) { const B = st.barcodes[b]; if (!B || B.s !== 'H' || B.t !== t) continue; size++; if (B.pr) { proc++; per[B.p] = (per[B.p] || 0) + 1; } }
      if (!size) continue;
      let value = 0, completes = 0, bigBc = 0, newSpace = 0;
      for (const p in per) { const P = st.pids[p], k = per[p], tot = P.C + P.R;
        if (tot >= 10) { value += k; bigBc += k; }
        else if (tot >= 5) { if (k >= P.R) { value += k + P.C; completes++; } else value += k * (k / P.R); }
        if (!Object.keys(P.locs).length) newSpace += Math.min(P.R, plan); }
      out.push({ tote: t, n: T.n, size, proc, value: Math.round(value), completes, bigBc, score: value / (size + TOTE_OVERHEAD), fits: newSpace <= free });
    }
    out.sort((a, b) => (b.fits - a.fits) || (b.score - a.score) || (b.value - a.value));
    return { list: limit ? out.slice(0, limit) : out, total: out.length, free };
  }

  function summary(st) {
    const s = st.settings, plan = planCap(s); let used = 0, locUsed = 0, ovUsed = 0, reservedOut = 0, planned = 0;
    for (const L of st.locations) { if (L.ov) { ovUsed += L.used; continue; } planned++; used += L.used; reservedOut += outstanding(L); if (L.used || activePids(L)) locUsed++; }
    let pend = 0, open = 0, done = 0; for (const t in st.totes) { const x = st.totes[t].s; if (x === 'H') pend++; else if (x === 'O') open++; else done++; }
    let R = 0, C = 0, H = 0, N = 0, p5 = 0; for (const p in st.pids) { const P = st.pids[p]; R += P.R; C += P.C; H += P.H; N += P.N; if (P.R + P.C >= 5) p5++; }
    return { plannedLocs: planned, planCapTotal: planned * plan, used, reservedOut, locUsed, ovUsed, pend, open, done, R, C, H, N, p5 };
  }

  return { defaultSettings, planCap, newState, parseCSV, loadDump, scan, undoLast, finishTote, toteProgress,
           handoverSuggestion, pidInfo, handOver, placedByPid, recommend, normalize, summary, recount, shiftOf, nowISO, locByCode, outstanding };
})();
if (typeof module !== 'undefined') module.exports = Core;
```

> **Note (overflow removal, 2026-xx-xx, owner-approved):** the `overflowAisle`/`overflowFromTote`/`ov:` logic shown verbatim above (the original pilot's `assign()`/`handOver()`/`summary()`) is historical — it was removed from the live implementation. §5.5/§5.6 describe the current rule: exactly 400 locations, all planned, no overflow fallback, NO SPACE is the only thing beyond 400.
