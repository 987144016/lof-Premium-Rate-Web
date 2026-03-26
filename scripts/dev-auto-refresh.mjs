import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const projectRoot = process.cwd();
const nodeExecutable = process.execPath;
const viteBin = path.join(projectRoot, 'node_modules', 'vite', 'bin', 'vite.js');

const FAST_SYNC_INTERVAL = 60_000;
const SLOW_SYNC_INTERVAL = 15 * 60_000;
const DEFAULT_GIT_PUSH_INTERVAL = 5 * 60_000;
const DEFAULT_BOOTSTRAP_PUSH_RETRY_INTERVAL_MS = 3 * 60 * 1000;

const DEV_HOST = '127.0.0.1';
const DEV_PORT = '4173';
const GIT_REMOTE = process.env.AUTO_PUSH_REMOTE || 'origin';
const GIT_BRANCH = process.env.AUTO_PUSH_BRANCH || 'main';
const ENABLE_GITHUB_PUSH = process.env.AUTO_PUSH_GITHUB !== '0';
const ENABLE_CLOUDFLARE_SYNC = process.env.AUTO_SYNC_CLOUDFLARE === '1';
const GIT_PUSH_INTERVAL =
  Number.parseInt(process.env.AUTO_PUSH_INTERVAL_MS ?? '', 10) || DEFAULT_GIT_PUSH_INTERVAL;
const BOOTSTRAP_PUSH_RETRY_INTERVAL_MS =
  Number.parseInt(process.env.AUTO_PUSH_BOOTSTRAP_RETRY_MS ?? '', 10) || DEFAULT_BOOTSTRAP_PUSH_RETRY_INTERVAL_MS;
const GIT_SYNC_PATHS = ['public/generated/funds-runtime.json', 'public/generated/premium-compare.json'];
const ENABLE_STARTUP_FULL_SYNC = process.env.SYNC_STARTUP_FULL_FIRST !== '0';
const REGULAR_SYNC_BATCH_SIZE = process.env.SYNC_BATCH_SIZE;
const STARTUP_SYNC_BATCH_SIZE = process.env.SYNC_BOOTSTRAP_BATCH_SIZE || '9999';
const CF_SYNC_COUNTER_FILE = path.join(projectRoot, '.cache', 'cloudflare', 'cf_sync_counter.txt');
const CF_SYNC_TRIGGER_COUNT = Math.max(
  1,
  Number.parseInt(process.env.AUTO_SYNC_CLOUDFLARE_EVERY_N ?? '1', 10) || 1,
);

let syncing = false;
let pushing = false;
let gitPushReady = false;

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

function runCommandCapture(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', reject);
    child.on('exit', (code) => {
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

function readCfSyncCounter() {
  try {
    return Number(fs.readFileSync(CF_SYNC_COUNTER_FILE, 'utf8')) || 0;
  } catch {
    return 0;
  }
}

function writeCfSyncCounter(value) {
  try {
    fs.mkdirSync(path.dirname(CF_SYNC_COUNTER_FILE), { recursive: true });
    fs.writeFileSync(CF_SYNC_COUNTER_FILE, String(value), 'utf8');
  } catch {
    // Best-effort local counter persistence only.
  }
}

async function syncCloudflareD1AndWorker() {
  await runCommand('npm', ['run', 'cloudflare:runtime:sql']);
  await runCommand('wrangler', [
    'd1',
    'execute',
    'premium-runtime-db',
    '--file',
    '.cache/cloudflare/runtime-upsert.sql',
    '--remote',
    '--config',
    'cloudflare/worker/wrangler.toml',
  ]);
  await runCommand('wrangler', ['deploy', '--config', 'cloudflare/worker/wrangler.toml']);
  console.log('[auto-refresh] Cloudflare D1 and Worker synced.');
}

async function prepareGitPush() {
  if (!ENABLE_GITHUB_PUSH) {
    return false;
  }

  const insideRepo = await runCommandCapture('git', ['rev-parse', '--is-inside-work-tree']);
  if (insideRepo.code !== 0 || !insideRepo.stdout.toLowerCase().includes('true')) {
    console.warn('[auto-refresh] Git auto push disabled: not inside a git repository.');
    return false;
  }

  const remote = await runCommandCapture('git', ['remote', 'get-url', GIT_REMOTE]);
  if (remote.code !== 0) {
    console.warn(`[auto-refresh] Git auto push disabled: remote "${GIT_REMOTE}" not found.`);
    return false;
  }

  return true;
}

async function pushRuntimeUpdate() {
  if (!gitPushReady || pushing) {
    return false;
  }

  pushing = true;
  try {
    const status = await runCommandCapture('git', ['status', '--porcelain', '--', ...GIT_SYNC_PATHS]);
    if (status.code !== 0 || status.stdout.trim() === '') {
      return true;
    }

    await runCommand('git', ['add', '--', ...GIT_SYNC_PATHS]);

    const staged = await runCommandCapture('git', ['diff', '--cached', '--name-only', '--', ...GIT_SYNC_PATHS]);
    if (staged.code !== 0 || staged.stdout.trim() === '') {
      return true;
    }

    const stamp = new Date().toISOString();
    await runCommand('git', ['commit', '-m', `chore(auto): refresh runtime data ${stamp}`]);
    await runCommand('git', ['push', GIT_REMOTE, `HEAD:${GIT_BRANCH}`]);
    console.log('[auto-refresh] pushed runtime data to GitHub.');
    return true;
  } catch (error) {
    console.error('[auto-refresh] git push failed:', error instanceof Error ? error.message : error);
    return false;
  } finally {
    pushing = false;
  }
}

async function syncOnce(options = {}) {
  if (syncing) {
    return false;
  }

  const batchSizeOverride = options.batchSizeOverride;
  const env = { ...process.env };
  if (batchSizeOverride) {
    env.SYNC_BATCH_SIZE = String(batchSizeOverride);
  } else if (REGULAR_SYNC_BATCH_SIZE) {
    env.SYNC_BATCH_SIZE = String(REGULAR_SYNC_BATCH_SIZE);
  }

  syncing = true;
  try {
    await runCommand(nodeExecutable, ['scripts/sync-funds.mjs'], { env });
    await runCommand(nodeExecutable, ['scripts/sync-premium-compare.mjs'], { env });

    if (ENABLE_CLOUDFLARE_SYNC) {
      let cfSyncCounter = readCfSyncCounter() + 1;
      if (cfSyncCounter >= CF_SYNC_TRIGGER_COUNT) {
        await syncCloudflareD1AndWorker();
        cfSyncCounter = 0;
      }
      writeCfSyncCounter(cfSyncCounter);
    }

    return true;
  } catch (error) {
    console.error('[auto-refresh] sync failed:', error instanceof Error ? error.message : error);
    return false;
  } finally {
    syncing = false;
  }
}

async function main() {
  if (REGULAR_SYNC_BATCH_SIZE) {
    process.stdout.write(`[auto-refresh] sync:data uses batched mode, SYNC_BATCH_SIZE=${REGULAR_SYNC_BATCH_SIZE}\n`);
  }
  if (ENABLE_CLOUDFLARE_SYNC) {
    process.stdout.write(
      `[auto-refresh] Cloudflare auto sync enabled, deploy every ${CF_SYNC_TRIGGER_COUNT} local sync cycle(s).\n`,
    );
  } else {
    process.stdout.write('[auto-refresh] Cloudflare auto sync disabled; GitHub/local mode stays independent.\n');
  }

  gitPushReady = await prepareGitPush();

  let synced = false;
  if (ENABLE_STARTUP_FULL_SYNC) {
    process.stdout.write(`[auto-refresh] startup full sync enabled, SYNC_BATCH_SIZE=${STARTUP_SYNC_BATCH_SIZE}\n`);
    synced = await syncOnce({ batchSizeOverride: STARTUP_SYNC_BATCH_SIZE });
  }
  if (!synced) {
    await syncOnce();
  }

  let initialPushCompleted = !gitPushReady;

  const tryBootstrapPush = async () => {
    if (initialPushCompleted || !gitPushReady) {
      return true;
    }

    const ok = await pushRuntimeUpdate();
    if (ok) {
      initialPushCompleted = true;
      process.stdout.write('[auto-refresh] bootstrap push completed; switching to regular push schedule.\n');
    } else {
      process.stdout.write(
        `[auto-refresh] bootstrap push failed; retry in ${Math.round(BOOTSTRAP_PUSH_RETRY_INTERVAL_MS / 1000)}s.\n`,
      );
    }

    return ok;
  };

  await tryBootstrapPush();

  if (!fs.existsSync(viteBin)) {
    throw new Error(`Vite not installed, missing file: ${viteBin}`);
  }

  const vite = spawn(nodeExecutable, [viteBin, '--host', DEV_HOST, '--port', DEV_PORT, '--open'], {
    cwd: projectRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });

  process.stdout.write(`[auto-refresh] local url: http://${DEV_HOST}:${DEV_PORT}/#/qdii-lof\n`);

  const handleOutput = (chunk, writer) => {
    writer.write(chunk.toString());
  };

  vite.stdout?.on('data', (chunk) => handleOutput(chunk, process.stdout));
  vite.stderr?.on('data', (chunk) => handleOutput(chunk, process.stderr));

  let timer = setTimeout(function scheduleNext() {
    void syncOnce().finally(() => {
      timer = setTimeout(scheduleNext, getSyncInterval());
    });
  }, getSyncInterval());

  let gitTimer = 0;
  let bootstrapPushTimer = 0;

  const scheduleRegularPush = () => {
    if (!gitPushReady) {
      return;
    }

    gitTimer = setTimeout(function runRegularPush() {
      void pushRuntimeUpdate().finally(() => {
        scheduleRegularPush();
      });
    }, GIT_PUSH_INTERVAL);
  };

  const scheduleBootstrapPush = () => {
    if (!gitPushReady || initialPushCompleted) {
      scheduleRegularPush();
      return;
    }

    bootstrapPushTimer = setTimeout(function runBootstrapPush() {
      void tryBootstrapPush().finally(() => {
        if (initialPushCompleted) {
          scheduleRegularPush();
        } else {
          scheduleBootstrapPush();
        }
      });
    }, BOOTSTRAP_PUSH_RETRY_INTERVAL_MS);
  };

  if (initialPushCompleted) {
    scheduleRegularPush();
  } else {
    scheduleBootstrapPush();
  }

  const shutdown = () => {
    clearTimeout(timer);
    clearTimeout(gitTimer);
    clearTimeout(bootstrapPushTimer);
    vite.kill();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  vite.on('exit', (code) => {
    clearTimeout(timer);
    clearTimeout(gitTimer);
    clearTimeout(bootstrapPushTimer);
    process.exit(code ?? 0);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
