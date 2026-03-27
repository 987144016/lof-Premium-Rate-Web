const OIL_CODES = ['160723', '501018', '161129', '160416', '162719', '162411', '163208', '159518', '160216'];

const DEFAULT_RUNTIME_SYNC_SOURCE =
  'https://987144016.github.io/lof-Premium-Rate-Web/generated/funds-runtime.json';
const DEFAULT_SYNC_INTERVAL_MINUTES = 5;
const MAX_SYNC_INTERVAL_MINUTES = 60;

// 导入自主同步引擎
import { syncAllFunds, getAllFunds, getFundByCode } from './sync-engine.js';
import { buildPremiumComparePayload } from './premium-compare-engine.js';

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, OPTIONS, POST',
      'access-control-allow-headers': 'content-type, authorization',
    },
  });
}

function parseRuntimeRow(row) {
  if (!row?.runtime_json) return null;
  try {
    return JSON.parse(String(row.runtime_json));
  } catch {
    return null;
  }
}

function toIsoString(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString();
}

function normalizeSourceBaseUrl(value) {
  const base = String(value || '').trim().replace(/\/+$/, '');
  return base;
}

function resolveGeneratedSourceBaseUrl(env) {
  return normalizeSourceBaseUrl(env.GENERATED_SOURCE_BASE_URL);
}

function joinGeneratedSourceUrl(baseUrl, fileName) {
  if (!baseUrl) return '';
  return `${baseUrl}/generated/${fileName}`;
}

function resolveRuntimeSyncSource(env) {
  const explicit = String(env.RUNTIME_SYNC_SOURCE || '').trim();
  if (explicit) return explicit;

  const generatedBaseUrl = resolveGeneratedSourceBaseUrl(env);
  return joinGeneratedSourceUrl(generatedBaseUrl, 'funds-runtime.json') || DEFAULT_RUNTIME_SYNC_SOURCE;
}

function resolvePremiumCompareSource(env) {
  const explicit = String(env.PREMIUM_COMPARE_SOURCE || '').trim();
  if (explicit) return explicit;

  const generatedBaseUrl = resolveGeneratedSourceBaseUrl(env);
  return joinGeneratedSourceUrl(generatedBaseUrl, 'premium-compare.json');
}

function resolveMinSyncIntervalMinutes(env) {
  const raw = Number.parseInt(String(env.RUNTIME_SYNC_MIN_INTERVAL_MINUTES || DEFAULT_SYNC_INTERVAL_MINUTES), 10);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_SYNC_INTERVAL_MINUTES;
  return Math.min(raw, MAX_SYNC_INTERVAL_MINUTES);
}

async function getLatestRun(db) {
  return (
    (await db      .prepare('SELECT id, synced_at, fund_count, source_url FROM runtime_runs ORDER BY id DESC LIMIT 1')
      .first()) || null
  );
}

async function getLatestSyncedAt(db) {
  const latest = await getLatestRun(db);
  return {
    syncedAt: latest?.synced_at ? String(latest.synced_at) : '',
    fundCount: Number(latest?.fund_count || 0),
    sourceUrl: latest?.source_url ? String(latest.source_url) : '',
  };
}

async function loadJsonFromSource(sourceUrl) {
  const response = await fetch(sourceUrl, {
    headers: {
      accept: 'application/json',
      'user-agent': 'lof-premium-rate-web-worker/1.0',
    },
  });

  if (!response.ok) {
    throw new Error(`Upstream fetch failed: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

async function loadRuntimePayload(sourceUrl) {
  const payload = await loadJsonFromSource(sourceUrl);
  const funds = Array.isArray(payload?.funds) ? payload.funds.filter((item) => item && item.code) : [];
  const syncedAt =
    toIsoString(payload?.syncedAt)
    || toIsoString(payload?.updatedAt)
    || toIsoString(payload?.generatedAt)
    || new Date().toISOString();

  if (!funds.length) {
    throw new Error('Upstream payload did not contain any funds');
  }

  return { syncedAt, funds };
}

async function upsertRuntimeSnapshot(db, sourceUrl, payload) {
  const { syncedAt, funds } = payload;
  const statements = [
    db.prepare('INSERT INTO runtime_runs (synced_at, fund_count, source_url) VALUES (?, ?, ?)').bind(
      syncedAt,
      funds.length,
      sourceUrl,
    ),
  ];

  for (const fund of funds) {
    const runtimeJson = JSON.stringify(fund);
    statements.push(
      db.prepare(
        `INSERT INTO latest_fund_runtime (code, synced_at, runtime_json)
         VALUES (?, ?, ?)
         ON CONFLICT(code) DO UPDATE SET
           synced_at = excluded.synced_at,
           runtime_json = excluded.runtime_json`,
      ).bind(String(fund.code), syncedAt, runtimeJson),
    );
  }

  await db.batch(statements);
  return {
    syncedAt,
    fundCount: funds.length,
    sourceUrl,
  };
}

async function syncRuntimeFromSource(db, env, options = {}) {
  const sourceUrl = resolveRuntimeSyncSource(env);
  const latestRun = await getLatestRun(db);
  const now = Date.now();
  const minIntervalMinutes = resolveMinSyncIntervalMinutes(env);
  const latestSyncedMs = latestRun?.synced_at ? Date.parse(String(latestRun.synced_at)) : Number.NaN;
  const dueToInterval =
    Number.isNaN(latestSyncedMs) || now - latestSyncedMs >= minIntervalMinutes * 60 * 1000;

  if (!options.force && latestRun && !dueToInterval) {
    return {
      ok: true,
      skipped: true,
      reason: `Minimum sync interval (${minIntervalMinutes} min) not reached`,
      syncedAt: String(latestRun.synced_at || ''),
      fundCount: Number(latestRun.fund_count || 0),
      sourceUrl,
    };
  }

  const payload = await loadRuntimePayload(sourceUrl);
  const latestFundCount = Number(latestRun?.fund_count || 0);
  if (!options.force && latestFundCount > 0 && payload.funds.length < latestFundCount) {
    return {
      ok: true,
      skipped: true,
      reason: `Upstream fund count (${payload.funds.length}) smaller than current (${latestFundCount})`,
      syncedAt: String(latestRun?.synced_at || ''),
      fundCount: latestFundCount,
      sourceUrl,
    };
  }

  if (!options.force && latestRun && String(latestRun.synced_at || '') === payload.syncedAt) {
    return {
      ok: true,
      skipped: true,
      reason: 'Upstream syncedAt unchanged',
      syncedAt: payload.syncedAt,
      fundCount: Number(latestRun.fund_count || payload.funds.length || 0),
      sourceUrl,
    };
  }

  return {
    ok: true,
    skipped: false,
    ...(await upsertRuntimeSnapshot(db, sourceUrl, payload)),
  };
}

// 手动溢价率数据保存端点
async function handleManualPremiumEntry(request, env, db) {
  if (request.method !== 'POST') return json({ ok: false, error: 'Method Not Allowed' }, 405);

  const syncToken = String(env.RUNTIME_SYNC_TOKEN || '').trim();
  const authorization = String(request.headers.get('authorization') || '').trim();
  const bearerToken = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';

  if (!syncToken || bearerToken !== syncToken) {
    return json({ ok: false, error: 'Unauthorized' }, 401);
  }

  try {
    const data = await request.json();
    
    // 验证必要字段
    if (!data || !data.code || !data.date || data.premiumRate === undefined) {
      return json({ ok: false, error: 'Missing required fields: code, date, premiumRate' }, 400);
    }

    const code = String(data.code).trim();
    const date = String(data.date).trim();
    const premiumRate = Number(data.premiumRate);
    const provider = String(data.provider || 'manual-cloudflare').trim();
    const sourceUrl = String(data.sourceUrl || '').trim();
    const status = String(data.status || 'manual-input').trim();
    const time = String(data.time || '15:00:00').trim();

    // 验证日期格式
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return json({ ok: false, error: 'Invalid date format. Expected YYYY-MM-DD' }, 400);
    }

    // 验证溢价率是否为数字
    if (isNaN(premiumRate)) {
      return json({ ok: false, error: 'premiumRate must be a number' }, 400);
    }

    // 保存手动记录到数据库
    const statements = [
      db.prepare(
        `INSERT OR REPLACE INTO manual_premium_entries 
         (code, date, provider, premium_rate, source_url, status, time, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`
      ).bind(code, date, provider, premiumRate, sourceUrl, status, time),
    ];

    await db.batch(statements);

    return json({
      ok: true,
      message: 'Manual premium entry saved successfully',
      data: {
        code,
        date,
        provider,
        premiumRate,
        sourceUrl,
        status,
        time
      }
    });
  } catch (error) {
    return json(
      {
        ok: false,
        error: error instanceof Error ? error.message : 'Unknown error saving manual premium entry',
      },
      500,
    );
  }
}

// 获取手动记录数据
async function getManualPremiumEntries(db, date, provider) {
  let query = 'SELECT code, date, provider, premium_rate, source_url, status, time, created_at, updated_at FROM manual_premium_entries WHERE 1=1';
  const params = [];

  if (date) {
    query += ' AND date = ?';
    params.push(date);
  }

  if (provider) {
    query += ' AND provider = ?';
    params.push(provider);
  }

  query += ' ORDER BY code';

  const result = await db.prepare(query).bind(...params).all();
  return result.results || [];
}

async function handleGetManualPremiumEntries(request, env, db) {
  if (request.method !== 'GET') return json({ ok: false, error: 'Method Not Allowed' }, 405);

  const syncToken = String(env.RUNTIME_SYNC_TOKEN || '').trim();
  const authorization = String(request.headers.get('authorization') || '').trim();
  const bearerToken = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';

  if (!syncToken || bearerToken !== syncToken) {
    return json({ ok: false, error: 'Unauthorized' }, 401);
  }

  try {
    const url = new URL(request.url);
    const date = url.searchParams.get('date');
    const provider = url.searchParams.get('provider');

    const entries = await getManualPremiumEntries(db, date, provider);
    
    return json({
      ok: true,
      count: entries.length,
      entries: entries.map(entry => ({
        code: entry.code,
        date: entry.date,
        provider: entry.provider,
        premiumRate: entry.premium_rate,
        sourceUrl: entry.source_url,
        status: entry.status,
        time: entry.time,
        createdAt: entry.created_at,
        updatedAt: entry.updated_at
      }))
    });
  } catch (error) {
    return json(
      {
        ok: false,
        error: error instanceof Error ? error.message : 'Unknown error fetching manual premium entries',
      },
      500,
    );
  }
}

// 处理溢价率对比请求
async function handlePremiumCompareRequest(request, env, db) {
  try {
    const params = new URL(request.url).searchParams;
    const force = params.get('force') === 'true';
    const liveFetchLimit = Number.parseInt(String(params.get('liveFetchLimit') || ''), 10);
    const payload = await buildPremiumComparePayload(db, {
      force,
      liveFetchLimit: Number.isFinite(liveFetchLimit) ? liveFetchLimit : undefined,
    });
    return json({ ok: true, ...payload });
  } catch (error) {
    const fallbackSource = resolvePremiumCompareSource(env);
    if (fallbackSource) {
      try {
        const payload = await loadJsonFromSource(fallbackSource);
        return json({ ok: true, ...payload, fallbackSource, degraded: true });
      } catch {
        // ignore fallback error and return primary error below
      }
    }
    return json({ ok: false, error: error.message }, 500);
  }
}

// 处理手动同步请求
async function handleSyncRequest(request, env, db) {
  if (request.method !== 'POST') {
    return json({ ok: false, error: 'Method Not Allowed' }, 405);
  }

  const syncToken = String(env.RUNTIME_SYNC_TOKEN || '').trim();
  const authorization = String(request.headers.get('authorization') || '').trim();
  const bearerToken = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';

  if (!syncToken || bearerToken !== syncToken) {
    return json({ ok: false, error: 'Unauthorized' }, 401);
  }

  try {
    const url = new URL(request.url);
    const force = url.searchParams.get('force') === 'true';
    const mode = String(url.searchParams.get('mode') || '').trim();
    const useSourceSync = mode === 'source';
    const batchSize = Number.parseInt(String(url.searchParams.get('batchSize') || ''), 10);

    let result;
    if (useSourceSync) {
      // 默认使用全量 runtime 源同步（覆盖所有基金与详情字段）
      result = await syncRuntimeFromSource(db, env, { force });
    } else {
      // 默认使用 Worker 自主抓取引擎（完全独立自主）
      result = await syncAllFunds(db, { force, batchSize: Number.isFinite(batchSize) ? batchSize : undefined });
    }

    return json(result);
  } catch (error) {
    return json(
      { ok: false, error: error.message },
      500
    );
  }
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return json({ ok: true }, 204);

    const url = new URL(request.url);
    const db = env.RUNTIME_DB;

    // 手动溢价率数据API端点
    if (url.pathname === '/api/manual/premium-entry') {
      return handleManualPremiumEntry(request, env, db);
    }

    if (url.pathname === '/api/manual/premium-entries') {
      return handleGetManualPremiumEntries(request, env, db);
    }

    if (url.pathname === '/api/runtime/premium-compare') {
      if (request.method !== 'GET') return json({ ok: false, error: 'Method Not Allowed' }, 405);
      return handlePremiumCompareRequest(request, env, db);
    }

    if (url.pathname === '/health') {
      const latest = db ? await getLatestSyncedAt(db) : { syncedAt: '', fundCount: 0, sourceUrl: '' };
      return json({
        ok: true,
        runtimeDbAvailable: Boolean(db),
        ...latest,
        runtimeSyncSource: resolveRuntimeSyncSource(env),
        premiumCompareSource: resolvePremiumCompareSource(env),
        generatedSourceBaseUrl: resolveGeneratedSourceBaseUrl(env),
        minSyncIntervalMinutes: resolveMinSyncIntervalMinutes(env),
      });
    }

    if (!db) {
      return json({ ok: false, error: 'RUNTIME_DB binding missing' }, 500);
    }

    if (url.pathname === '/internal/sync/runtime') {
      return handleSyncRequest(request, env, db);
    }

    if (request.method !== 'GET') return json({ ok: false, error: 'Method Not Allowed' }, 405);

    if (url.pathname === '/api/runtime/all') {
      const latest = await getLatestSyncedAt(db);
      const result = await db.prepare('SELECT code, runtime_json FROM latest_fund_runtime ORDER BY code').all();
      const funds = (result?.results || []).map(parseRuntimeRow).filter((item) => item && item.code);
      return json({ ok: true, syncedAt: latest.syncedAt, fundCount: funds.length, funds, stateByCode: {} });
    }

    if (url.pathname === '/api/runtime/latest') {
      const code = String(url.searchParams.get('code') || '').trim();
      if (!code) return json({ ok: false, error: 'Missing query parameter: code' }, 400);
      const row = await db
        .prepare('SELECT synced_at, runtime_json FROM latest_fund_runtime WHERE code = ?')
        .bind(code)
        .first();
      if (!row) return json({ ok: false, error: 'Fund code not found', code }, 404);
      const fund = parseRuntimeRow(row);
      if (!fund) return json({ ok: false, error: 'Invalid runtime_json payload', code }, 500);
      fund.syncedAt = String(row.synced_at || '');
      return json({ ok: true, fund });
    }

    if (url.pathname === '/api/runtime/oil') {
      const placeholders = OIL_CODES.map(() => '?').join(',');
      const query = `SELECT code, synced_at, runtime_json FROM latest_fund_runtime WHERE code IN (${placeholders}) ORDER BY code`;
      const result = await db.prepare(query).bind(...OIL_CODES).all();
      const funds = (result?.results || [])
        .map((row) => {
          const runtime = parseRuntimeRow(row);
          if (!runtime) return null;
          runtime.syncedAt = String(row.synced_at || '');
          return runtime;
        })
        .filter((item) => item && item.code);
      return json({ ok: true, total: funds.length, funds });
    }

    return json({ ok: false, error: 'Not Found' }, 404);
  },

  async scheduled(_event, env, ctx) {
    if (!env.RUNTIME_DB) return;

    ctx.waitUntil(
      (async () => {
        try {
          // Cron 触发分批轮巡同步，保持完全独立自主更新
          const result = await syncAllFunds(env.RUNTIME_DB, { force: false, batchSize: 12 });
          if (result.ok) {
            console.log('[Scheduled] Sync engine batch completed:', result);
          } else {
            console.error('[Scheduled] Sync engine batch failed:', result.error);
          }
        } catch (error) {
          console.error('[Scheduled] Sync error:', error);
        }
      })(),
    );
  },
};