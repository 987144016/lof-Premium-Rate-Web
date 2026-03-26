import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';

const projectRoot = process.cwd();
const nodeExecutable = process.execPath;
const generatedDir = path.join(projectRoot, 'public', 'generated');

const FAST_SYNC_INTERVAL = 60_000;
const SLOW_SYNC_INTERVAL = 15 * 60_000;
const DEFAULT_HOST = process.env.CLOUDFLARE_SERVER_HOST || '0.0.0.0';
const DEFAULT_PORT = Number.parseInt(process.env.CLOUDFLARE_SERVER_PORT ?? '', 10) || 8788;
const ENABLE_STARTUP_FULL_SYNC = process.env.SYNC_STARTUP_FULL_FIRST !== '0';
const REGULAR_SYNC_BATCH_SIZE = process.env.SYNC_BATCH_SIZE || '6';
const STARTUP_SYNC_BATCH_SIZE = process.env.SYNC_BOOTSTRAP_BATCH_SIZE || '9999';
const REGULAR_SKIP_REALTIME_HOLDINGS = process.env.SYNC_SKIP_REALTIME_HOLDINGS ?? '1';
const MANUAL_SYNC_TOKEN = String(process.env.CLOUDFLARE_SERVER_SYNC_TOKEN || '').trim();

const GENERATED_JSON_CONTENT_TYPE = 'application/json; charset=utf-8';
const ALLOWED_STATIC_FILES = new Set([
  'funds-runtime.json',
  'premium-compare.json',
  'github-traffic.json',
  'premium-compare-manual.json',
]);

let syncing = false;
let nextRunTimer = null;
const serverState = {
  startedAt: new Date().toISOString(),
  syncing: false,
  lastSyncStartedAt: '',
  lastSyncFinishedAt: '',
  lastSyncMode: '',
  lastSyncOk: null,
  lastError: '',
};

function json(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'content-type': GENERATED_JSON_CONTENT_TYPE,
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization',
  });
  res.end(JSON.stringify(payload));
}

function text(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
  res.end(payload);
}

function getZonedClock(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const weekday = parts.find((item) => item.type === 'weekday')?.value ?? 'Sun';
  const hour = Number(parts.find((item) => item.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((item) => item.type === 'minute')?.value ?? '0');

  return {
    weekday,
    hour,
    minute,
    minutes: hour * 60 + minute,
  };
}

function isWeekday(weekday) {
  return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(weekday);
}

function isCnTradingSession(date) {
  const clock = getZonedClock(date, 'Asia/Shanghai');
  if (!isWeekday(clock.weekday)) {
    return false;
  }

  return (
    (clock.minutes >= 9 * 60 + 30 && clock.minutes < 11 * 60 + 30)
    || (clock.minutes >= 13 * 60 && clock.minutes < 15 * 60)
  );
}

function isUsTradingSession(date) {
  const clock = getZonedClock(date, 'America/New_York');
  if (!isWeekday(clock.weekday)) {
    return false;
  }

  return clock.minutes >= 9 * 60 + 30 && clock.minutes < 16 * 60;
}

function getSyncInterval(now = new Date()) {
  return isCnTradingSession(now) || isUsTradingSession(now) ? FAST_SYNC_INTERVAL : SLOW_SYNC_INTERVAL;
}

function shouldRunPremiumCompare(now = new Date()) {
  return getZonedClock(now, 'Asia/Shanghai').minute % 30 === 0;
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      stdio: 'inherit',
      shell: false,
      ...options,
    });

    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(' ')} exited with code ${code ?? -1}`));
    });
    child.on('error', reject);
  });
}

function isAllowedGeneratedFile(fileName) {
  return ALLOWED_STATIC_FILES.has(fileName) || /^\d+-offline-research\.json$/i.test(fileName);
}

async function syncOnce(options = {}) {
  if (syncing) {
    return false;
  }

  const now = new Date();
  const isFull = Boolean(options.fullSync);
  const runPremiumCompare = options.runPremiumCompare ?? true;
  const env = { ...process.env };

  if (isFull) {
    env.SYNC_BATCH_SIZE = STARTUP_SYNC_BATCH_SIZE;
    delete env.SYNC_SKIP_REALTIME_HOLDINGS;
  } else {
    env.SYNC_BATCH_SIZE = REGULAR_SYNC_BATCH_SIZE;
    env.SYNC_SKIP_REALTIME_HOLDINGS = REGULAR_SKIP_REALTIME_HOLDINGS;
  }

  syncing = true;
  serverState.syncing = true;
  serverState.lastSyncStartedAt = now.toISOString();
  serverState.lastSyncMode = isFull ? 'full' : 'regular';
  serverState.lastError = '';

  try {
    await runCommand(nodeExecutable, ['scripts/sync-funds.mjs'], { env });
    if (runPremiumCompare) {
      await runCommand(nodeExecutable, ['scripts/sync-premium-compare.mjs'], { env: { ...process.env } });
    }
    serverState.lastSyncOk = true;
    serverState.lastSyncFinishedAt = new Date().toISOString();
    return true;
  } catch (error) {
    serverState.lastSyncOk = false;
    serverState.lastSyncFinishedAt = new Date().toISOString();
    serverState.lastError = error instanceof Error ? error.message : String(error);
    console.error('[cloudflare-server] sync failed:', serverState.lastError);
    return false;
  } finally {
    syncing = false;
    serverState.syncing = false;
  }
}

function scheduleNextSync() {
  const interval = getSyncInterval();
  nextRunTimer = setTimeout(async () => {
    const now = new Date();
    const runPremiumCompare = shouldRunPremiumCompare(now);
    await syncOnce({
      fullSync: false,
      runPremiumCompare,
    });
    scheduleNextSync();
  }, interval);
}

async function serveGeneratedJson(res, fileName) {
  if (!isAllowedGeneratedFile(fileName)) {
    json(res, 404, { ok: false, error: 'File not allowed', fileName });
    return;
  }

  const fullPath = path.join(generatedDir, fileName);
  try {
    const raw = await fs.readFile(fullPath, 'utf8');
    res.writeHead(200, {
      'content-type': GENERATED_JSON_CONTENT_TYPE,
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    });
    res.end(raw);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      json(res, 404, { ok: false, error: 'Generated file not found', fileName });
      return;
    }
    json(res, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      fileName,
    });
  }
}

function isAuthorized(request) {
  if (!MANUAL_SYNC_TOKEN) {
    return true;
  }

  const authorization = String(request.headers.authorization || '').trim();
  const bearerToken = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  return bearerToken === MANUAL_SYNC_TOKEN;
}

function createRequestHandler() {
  return async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'content-type, authorization',
      });
      res.end();
      return;
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      json(res, 200, {
        ok: true,
        ...serverState,
        generatedBaseUrl: `http://${req.headers.host || `127.0.0.1:${DEFAULT_PORT}`}/generated`,
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/internal/sync') {
      if (!isAuthorized(req)) {
        json(res, 401, { ok: false, error: 'Unauthorized' });
        return;
      }

      const ok = await syncOnce({
        fullSync: url.searchParams.get('mode') === 'full',
        runPremiumCompare: true,
      });
      json(res, ok ? 200 : 500, {
        ok,
        ...serverState,
      });
      return;
    }

    if (req.method === 'GET' && url.pathname.startsWith('/generated/')) {
      const fileName = decodeURIComponent(url.pathname.slice('/generated/'.length));
      await serveGeneratedJson(res, fileName);
      return;
    }

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/ready')) {
      text(res, 200, 'cloudflare sync server is running');
      return;
    }

    json(res, 404, { ok: false, error: 'Not Found' });
  };
}

async function start() {
  const syncOnceOnly = process.argv.includes('--sync-once');
  const startupRunPremiumCompare = true;

  if (ENABLE_STARTUP_FULL_SYNC) {
    console.log(`[cloudflare-server] startup full sync enabled, SYNC_BATCH_SIZE=${STARTUP_SYNC_BATCH_SIZE}`);
    await syncOnce({ fullSync: true, runPremiumCompare: startupRunPremiumCompare });
  } else {
    console.log(
      `[cloudflare-server] startup regular sync enabled, SYNC_BATCH_SIZE=${REGULAR_SYNC_BATCH_SIZE}, ` +
      `SYNC_SKIP_REALTIME_HOLDINGS=${REGULAR_SKIP_REALTIME_HOLDINGS}`,
    );
    await syncOnce({ fullSync: false, runPremiumCompare: startupRunPremiumCompare });
  }

  if (syncOnceOnly) {
    return;
  }

  const server = http.createServer(createRequestHandler());

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(DEFAULT_PORT, DEFAULT_HOST, () => {
      server.off('error', reject);
      resolve();
    });
  });

  console.log(`[cloudflare-server] generated JSON available at http://${DEFAULT_HOST}:${DEFAULT_PORT}/generated/`);
  console.log(`[cloudflare-server] health endpoint: http://${DEFAULT_HOST}:${DEFAULT_PORT}/health`);

  scheduleNextSync();

  const shutdown = () => {
    if (nextRunTimer) {
      clearTimeout(nextRunTimer);
      nextRunTimer = null;
    }
    server.close(() => {
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

start().catch((error) => {
  console.error('[cloudflare-server] fatal:', error instanceof Error ? error.message : error);
  process.exit(1);
});
