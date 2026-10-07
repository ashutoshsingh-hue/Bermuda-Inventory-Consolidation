# Bermuda Sort Station

Multi-station sorting and handover server for a warehouse rack. Operators scan barcodes at any number of
stations (PC + scanner, or a phone camera); each station works its own tote, the server places every barcode
in a rack location, and leads hand stock over when enough of a PID has been collected.

One Node.js process is the single source of truth. State lives in memory and is written through to SQLite.

## Quick start

Requires Node 20+.

```
npm install
copy .env.example .env                       # PowerShell: Copy-Item .env.example .env
node tools/createUser.js "YourName" admin 1234   # first admin (no default account exists)
npm start
```

| Who | URL |
|---|---|
| Operators | `http://<host>:8080/station/` |
| Lead / admin | `http://<host>:8080/admin/` |
| Phones (camera scanning) | `https://<host>:8080/station/` (needs `certs/`, see below) |

Tests: `npm test` (233 tests, all must pass; the real-dump replay test skips itself if the CSV is absent).

## Read these first

| File | What it covers |
|---|---|
| `CLAUDE.md` | Working rules for this repo. **The business rules in PLAN.md §5 are fixed; change them only with the owner's approval.** |
| `PLAN.md` | What the system does and why: business rules, data model, API, milestones. |
| `STRUCTURE.md` | Where the code lives and how it is layered. |
| `RUNBOOK.md` | Running it: users, backups and restore, dump lifecycle, stations, known gaps. |
| `deploy/README.md` | Setting up an always-on wired host (firewall, HTTPS cert, auto-start). |
| `HANDOFF.md` | Current status and open items. |

## Layout

```
src/core/      pure business logic (no db/http/fs; time is passed in)
src/services/  use-cases, one mutation at a time
src/api/       Fastify routes and auth
src/db/        SQLite schema, migrations, write-through persistence
src/jobs/      nightly backup
src/portMux.js HTTP + HTTPS on one port
public/        station (operator) and admin screens: plain HTML/JS, no build step
test/          node:test suites
tools/         createUser.js, httpsProxy.js (prototype proxy)
deploy/        host setup script and guide
```

## Rules that bite

- `core/` stays pure. Never convert pid / barcode / tote to numbers. Never trust `tote_simplified`.
- Space is reserved per active batch (route), never for the whole dump. Nothing may assume a fixed station count.
- Scans are normalised: tote = first 12 characters, barcode = last 12 (PLAN.md §4.1).
- Build one milestone at a time and keep `npm test` green.

## HTTPS and phone camera

Port 8080 answers both HTTP and HTTPS (`src/portMux.js`). The app itself listens on `127.0.0.1:8081` behind it.
HTTPS needs `certs/key.pem` and `certs/cert.pem` (not in git; `deploy/setup-host.ps1` creates a self-signed pair).
Without `certs/` the server runs plain HTTP and the **Scan with camera** button is hidden. Browsers only allow
camera access on HTTPS or localhost.

## Data and secrets

`data/`, `backups/`, `certs/`, `*.db`, `*.csv`, `*.log` and `.env` are git-ignored on purpose: they hold live
operations data and a private key. Do not commit them.

## Docker

`Dockerfile` runs `node src/server.js` with `/data` and `/app/backups` as volumes. It has no `certs/`, so it serves
plain HTTP; terminate TLS at your reverse proxy (needed for the phone camera). Not yet exercised in production.
