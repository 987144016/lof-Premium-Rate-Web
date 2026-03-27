-- D1 数据库迁移脚本
-- 创建基金运行时数据表

-- 运行时同步记录表
CREATE TABLE IF NOT EXISTS runtime_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  synced_at TEXT NOT NULL,
  fund_count INTEGER DEFAULT 0,
  source_url TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 基金运行时数据表（最新快照）
CREATE TABLE IF NOT EXISTS latest_fund_runtime (
  code TEXT PRIMARY KEY,
  synced_at TEXT NOT NULL,
  runtime_json TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 手动溢价率记录表
CREATE TABLE IF NOT EXISTS manual_premium_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  date TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'manual',
  premium_rate REAL NOT NULL,
  source_url TEXT,
  status TEXT DEFAULT 'manual-input',
  time TEXT DEFAULT '15:00:00',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(code, date, provider)
);

-- 第三方溢价率历史快照（用于云端 premium-compare 统计）
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
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(code, provider, date, time)
);

-- premium-compare 聚合缓存
CREATE TABLE IF NOT EXISTS premium_compare_cache (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  generated_at TEXT NOT NULL,
  synced_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 自主同步引擎游标（分批轮巡全基金）
CREATE TABLE IF NOT EXISTS sync_engine_cursor (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  next_index INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

-- 创建索引以优化查询
CREATE INDEX IF NOT EXISTS idx_runtime_runs_synced_at ON runtime_runs(synced_at DESC);
CREATE INDEX IF NOT EXISTS idx_latest_fund_runtime_code ON latest_fund_runtime(code);
CREATE INDEX IF NOT EXISTS idx_manual_premium_code_date ON manual_premium_entries(code, date DESC);
CREATE INDEX IF NOT EXISTS idx_premium_compare_history_lookup ON premium_compare_history(code, provider, date DESC, time DESC);

-- 插入初始测试数据（可选）
INSERT OR IGNORE INTO runtime_runs (synced_at, fund_count, source_url) 
VALUES (datetime('now'), 0, 'initial-setup');
