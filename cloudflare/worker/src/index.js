const OIL_CODES = ['160723', '501018', '161129', '160416', '162719', '162411', '163208', '159518', '160216'];

const DEFAULT_RUNTIME_SYNC_SOURCE =
  'https://987144016.github.io/lof-Premium-Rate-Web/generated/funds-runtime.json';
const DEFAULT_PREMIUM_COMPARE_SOURCE =
  'https://987144016.github.io/lof-Premium-Rate-Web/generated/premium-compare.json';
const DEFAULT_SYNC_INTERVAL_MINUTES = 5;
const MAX_SYNC_INTERVAL_MINUTES = 60;

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
  return joinGeneratedSourceUrl(generatedBaseUrl, 'premium-compare.json') || DEFAULT_PREMIUM_COMPARE_SOURCE;
}

function resolveMinSyncIntervalMinutes(env) {
  const raw = Number.parseInt(String(env.RUNTIME_SYNC_MIN_INTERVAL_MINUTES || DEFAULT_SYNC_INTERVAL_MINUTES), 10);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_SYNC_INTERVAL_MINUTES;
  return Math.min(raw, MAX_SYNC_INTERVAL_MINUTES);
}

async function getLatestRun(db) {
  return (
    (await db
      .prepare('SELECT id, synced_at, fund_count, source_url FROM runtime_runs ORDER BY id DESC LIMIT 1')
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

async function handleSyncRequest(request, env, db) {
  if (request.method !== 'POST') return json({ ok: false, error: 'Method Not Allowed' }, 405);

  const syncToken = String(env.RUNTIME_SYNC_TOKEN || '').trim();
  const authorization = String(request.headers.get('authorization') || '').trim();
  const bearerToken = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';

  if (!syncToken || bearerToken !== syncToken) {
    return json({ ok: false, error: 'Unauthorized' }, 401);
  }

  try {
    const result = await syncRuntimeFromSource(db, env, { force: true });
    return json(result);
  } catch (error) {
    return json(
      {
        ok: false,
        error: error instanceof Error ? error.message : 'Unknown sync error',
        sourceUrl: resolveRuntimeSyncSource(env),
      },
      500,
    );
  }
}

async function handlePremiumCompareRequest(env) {
  const sourceUrl = resolvePremiumCompareSource(env);
  try {
    const payload = await loadJsonFromSource(sourceUrl);
    return json(payload);
  } catch (error) {
    return json(
      {
        ok: false,
        error: error instanceof Error ? error.message : 'Unknown premium compare error',
        sourceUrl,
      },
      500,
    );
  }
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return json({ ok: true }, 204);

    const url = new URL(request.url);
    const db = env.RUNTIME_DB;

    if (url.pathname === '/api/runtime/premium-compare') {
      if (request.method !== 'GET') return json({ ok: false, error: 'Method Not Allowed' }, 405);
      return handlePremiumCompareRequest(env);
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
          await syncRuntimeFromSource(env.RUNTIME_DB, env, { force: false });
        } catch (error) {
          console.error('scheduled runtime sync failed', error);
        }
      })(),
    );
  },
};
