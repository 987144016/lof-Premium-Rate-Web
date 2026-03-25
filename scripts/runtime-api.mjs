import http from 'node:http';
import path from 'node:path';
import { URL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const host = process.env.RUNTIME_API_HOST || '127.0.0.1';
const port = Number(process.env.RUNTIME_API_PORT || 8787);
const projectRoot = process.cwd();
const runtimeDbPath = path.join(projectRoot, '.cache', 'fund-sync', 'runtime.db');
const OIL_CODES = ['160723', '501018', '161129', '160416', '162719', '162411', '163208', '159518', '160216'];

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

function withDb(handler, res) {
  let db;
  try {
    db = new DatabaseSync(runtimeDbPath);
    return handler(db);
  } catch (error) {
    return sendJson(res, 500, {
      ok: false,
      error: String(error?.message || error),
      dbPath: runtimeDbPath,
    });
  } finally {
    if (db) {
      db.close();
    }
  }
}

function pickRuntimeFields(runtime) {
  if (!runtime || typeof runtime !== 'object') {
    return null;
  }
  return {
    code: String(runtime.code || ''),
    name: String(runtime.name || ''),
    marketPrice: Number(runtime.marketPrice) || 0,
    marketDate: String(runtime.marketDate || ''),
    marketTime: String(runtime.marketTime || ''),
    estimatedNav: Number(runtime.estimatedNav) || 0,
    premiumRate: Number(runtime.premiumRate) || 0,
    pageCategory: String(runtime.pageCategory || ''),
    estimateMode: String(runtime.estimateMode || ''),
    oilContinuousReturn: Number.isFinite(runtime.oilContinuousReturn) ? runtime.oilContinuousReturn : null,
    oilContinuousSymbol: String(runtime.oilContinuousSymbol || ''),
    oilContinuousSource: String(runtime.oilContinuousSource || ''),
    syncedAt: String(runtime.syncedAt || ''),
  };
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    return sendJson(res, 204, { ok: true });
  }

  if (req.method !== 'GET') {
    return sendJson(res, 405, { ok: false, error: 'Method Not Allowed' });
  }

  const url = new URL(req.url || '/', `http://${host}:${port}`);

  if (url.pathname === '/health') {
    return withDb((db) => {
      const latest = db.prepare('SELECT synced_at, fund_count FROM runtime_runs ORDER BY id DESC LIMIT 1').get();
      return sendJson(res, 200, {
        ok: true,
        dbPath: runtimeDbPath,
        latestSyncedAt: latest?.synced_at || null,
        latestFundCount: Number(latest?.fund_count || 0),
      });
    }, res);
  }

  if (url.pathname === '/api/runtime/latest') {
    const code = String(url.searchParams.get('code') || '').trim();
    if (!code) {
      return sendJson(res, 400, { ok: false, error: 'Missing query parameter: code' });
    }
    return withDb((db) => {
      const row = db.prepare('SELECT synced_at, runtime_json FROM latest_fund_runtime WHERE code = ?').get(code);
      if (!row) {
        return sendJson(res, 404, { ok: false, error: 'Fund code not found', code });
      }
      const runtime = JSON.parse(String(row.runtime_json || '{}'));
      runtime.syncedAt = row.synced_at || '';
      return sendJson(res, 200, { ok: true, fund: pickRuntimeFields(runtime) });
    }, res);
  }

  if (url.pathname === '/api/runtime/all') {
    return withDb((db) => {
      const latest = db.prepare('SELECT synced_at FROM runtime_runs ORDER BY id DESC LIMIT 1').get();
      const rows = db
        .prepare(
          `SELECT code, runtime_json
           FROM latest_fund_runtime
           ORDER BY code`,
        )
        .all();

      const funds = rows.map((row) => JSON.parse(String(row.runtime_json || '{}')));

      return sendJson(res, 200, {
        ok: true,
        syncedAt: String(latest?.synced_at || ''),
        fundCount: funds.length,
        funds,
        stateByCode: {},
      });
    }, res);
  }

  if (url.pathname === '/api/runtime/oil') {
    return withDb((db) => {
      const rows = db
        .prepare(
          `SELECT code, synced_at, runtime_json
           FROM latest_fund_runtime
           WHERE code IN (${OIL_CODES.map(() => '?').join(',')})
           ORDER BY code`,
        )
        .all(...OIL_CODES);

      const funds = rows.map((row) => {
        const runtime = JSON.parse(String(row.runtime_json || '{}'));
        runtime.syncedAt = row.synced_at || '';
        return pickRuntimeFields(runtime);
      });

      return sendJson(res, 200, {
        ok: true,
        total: funds.length,
        funds,
      });
    }, res);
  }

  return sendJson(res, 404, { ok: false, error: 'Not Found' });
});

server.listen(port, host, () => {
  console.log(`runtime api is running at http://${host}:${port}`);
  console.log(`health check: http://${host}:${port}/health`);
});
