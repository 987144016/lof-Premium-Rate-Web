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

CREATE TABLE IF NOT EXISTS manual_premium_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  date TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'manual',
  premium_rate REAL NOT NULL,
  source_url TEXT,
  status TEXT DEFAULT 'manual-input',
  time TEXT DEFAULT '15:00:00',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(code, date, provider)
);

CREATE TABLE IF NOT EXISTS premium_compare_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  provider TEXT NOT NULL,
  date TEXT NOT NULL,
  time TEXT NOT NULL DEFAULT '15:00:00',
  market_price REAL,
  our_premium_rate REAL,
  provider_premium_rate REAL NOT NULL,
  source_url TEXT,
  status TEXT DEFAULT '',
  updated_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(code, provider, date, time)
);

CREATE TABLE IF NOT EXISTS premium_compare_cache (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  generated_at TEXT NOT NULL,
  synced_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_engine_cursor (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  next_index INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
