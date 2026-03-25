const OIL_CODES = ['160723', '501018', '161129', '160416', '162719', '162411', '163208', '159518', '160216'];

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, OPTIONS',
      'access-control-allow-headers': 'content-type, authorization',
    },
  });
}

function parseRuntimeRow(row) {
  if (!row?.runtime_json) {
    return null;
  }
  try {
    return JSON.parse(String(row.runtime_json));
  } catch {
    return null;
  }
}

async function getLatestSyncedAt(db) {
  const latest = await db
    .prepare('SELECT synced_at, fund_count FROM runtime_runs ORDER BY id DESC LIMIT 1')
    .first();
  return {
    syncedAt: latest?.synced_at ? String(latest.synced_at) : '',
    fundCount: Number(latest?.fund_count || 0),
  };
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return json({ ok: true }, 204);
    }

    if (request.method !== 'GET') {
      return json({ ok: false, error: 'Method Not Allowed' }, 405);
    }

    if (!env.RUNTIME_DB) {
      return json({ ok: false, error: 'RUNTIME_DB binding missing' }, 500);
    }

    const url = new URL(request.url);
    const db = env.RUNTIME_DB;

    if (url.pathname === '/health') {
      const latest = await getLatestSyncedAt(db);
      return json({ ok: true, ...latest });
    }

    if (url.pathname === '/api/runtime/all') {
      const latest = await getLatestSyncedAt(db);
      const result = await db
        .prepare('SELECT code, runtime_json FROM latest_fund_runtime ORDER BY code')
        .all();

      const funds = (result?.results || [])
        .map((row) => parseRuntimeRow(row))
        .filter((item) => item && item.code);

      return json({
        ok: true,
        syncedAt: latest.syncedAt,
        fundCount: funds.length,
        funds,
        stateByCode: {},
      });
    }

    if (url.pathname === '/api/runtime/latest') {
      const code = String(url.searchParams.get('code') || '').trim();
      if (!code) {
        return json({ ok: false, error: 'Missing query parameter: code' }, 400);
      }

      const row = await db
        .prepare('SELECT synced_at, runtime_json FROM latest_fund_runtime WHERE code = ?')
        .bind(code)
        .first();

      if (!row) {
        return json({ ok: false, error: 'Fund code not found', code }, 404);
      }

      const fund = parseRuntimeRow(row);
      if (!fund) {
        return json({ ok: false, error: 'Invalid runtime_json payload', code }, 500);
      }

      fund.syncedAt = String(row.synced_at || '');
      return json({ ok: true, fund });
    }

    if (url.pathname === '/api/runtime/oil') {
      const placeholders = OIL_CODES.map(() => '?').join(',');
      const query = `
        SELECT code, synced_at, runtime_json
        FROM latest_fund_runtime
        WHERE code IN (${placeholders})
        ORDER BY code
      `;

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
};
