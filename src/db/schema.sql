-- Bermuda Sort Station — SQLite schema (STRUCTURE.md §5 / PLAN.md §8)
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL -- JSON
);

CREATE TABLE IF NOT EXISTS locations (
  code TEXT PRIMARY KEY,
  aisle INT NOT NULL,
  tote INT NOT NULL,
  part INT NOT NULL,
  is_overflow INT NOT NULL DEFAULT 0,
  used INT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS loc_pid (
  location_code TEXT NOT NULL,
  pid TEXT NOT NULL,
  placed INT NOT NULL DEFAULT 0,
  reserved INT NOT NULL DEFAULT 0,
  PRIMARY KEY (location_code, pid)
);
CREATE INDEX IF NOT EXISTS ix_loc_pid_pid ON loc_pid(pid);

CREATE TABLE IF NOT EXISTS totes (
  tote_id TEXT PRIMARY KEY,
  tote_number TEXT,
  state TEXT NOT NULL CHECK (state IN ('H', 'O', 'C', 'M')), -- M = marked NOT FOUND (physically un-locatable)
  load_id INT,
  station_id TEXT,
  operator TEXT,
  shift TEXT,
  opened_at TEXT,
  closed_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_totes_state ON totes(state);

CREATE TABLE IF NOT EXISTS barcodes (
  barcode TEXT PRIMARY KEY,
  pid TEXT NOT NULL,
  tote_id TEXT,
  partition TEXT,
  processable INT NOT NULL DEFAULT 0,
  state TEXT NOT NULL CHECK (state IN ('H', 'P', 'O', 'N', 'X', 'M')), -- M = in a tote marked NOT FOUND
  location_code TEXT,
  placed_at TEXT,
  placed_station TEXT,
  placed_shift TEXT,
  nf_at TEXT,
  ho_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_barcodes_pid ON barcodes(pid, state);
CREATE INDEX IF NOT EXISTS ix_barcodes_tote ON barcodes(tote_id, state);

CREATE TABLE IF NOT EXISTS pids (
  pid TEXT PRIMARY KEY,
  r INT NOT NULL DEFAULT 0,
  c INT NOT NULL DEFAULT 0,
  h INT NOT NULL DEFAULT 0,
  n INT NOT NULL DEFAULT 0,
  m INT NOT NULL DEFAULT 0 -- in a tote marked NOT FOUND
);

CREATE TABLE IF NOT EXISTS loads (
  id INTEGER PRIMARY KEY,
  file_name TEXT,
  loaded_at TEXT,
  loaded_by TEXT,
  rows INT,
  new_totes INT,
  refreshed INT,
  skipped_taken INT,
  conflicts INT
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  shift TEXT,
  station_id TEXT,
  operator TEXT,
  type TEXT NOT NULL,
  open_tote TEXT,
  input_raw TEXT,
  barcode TEXT,
  result TEXT,
  location_code TEXT,
  pid TEXT,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS ix_events_ts ON events(ts);

CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  type TEXT NOT NULL,
  message TEXT,
  resolved_by TEXT,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'lead', 'operator')),
  pin_hash TEXT NOT NULL,
  active INT NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS stations (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  active INT NOT NULL DEFAULT 1,
  current_operator TEXT,
  open_tote TEXT,
  last_scan_barcode TEXT,
  last_seen TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER,
  station_id TEXT,
  created_at TEXT,
  expires_at TEXT
);

-- Route Planner history (one row per proposed/started route, PLAN.md §5.5's 400-location cap
-- is what every route's simulation is checked against)
CREATE TABLE IF NOT EXISTS route_history (
  id INTEGER PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('planned', 'active', 'completed')),
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  created_by TEXT,
  tote_ids TEXT NOT NULL, -- JSON array
  projected TEXT NOT NULL, -- JSON: the simulateRoute() report at propose/start time
  actual TEXT, -- JSON: filled in on completion
  note TEXT
);
CREATE INDEX IF NOT EXISTS ix_route_history_status ON route_history(status);
