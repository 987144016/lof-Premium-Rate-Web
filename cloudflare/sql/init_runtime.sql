PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS runtime_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  synced_at TEXT NOT NULL UNIQUE,
  fund_count INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runtime_archive (
  run_id INTEGER PRIMARY KEY,
  payload_json TEXT NOT NULL,
  FOREIGN KEY(run_id) REFERENCES runtime_runs(id)
);

CREATE TABLE IF NOT EXISTS latest_fund_runtime (
  code TEXT PRIMARY KEY,
  synced_at TEXT NOT NULL,
  page_category TEXT,
  estimate_mode TEXT,
  market_price REAL,
  previous_close REAL,
  market_date TEXT,
  market_time TEXT,
  official_nav_t1 REAL,
  nav_date TEXT,
  cache_mode TEXT,
  runtime_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
