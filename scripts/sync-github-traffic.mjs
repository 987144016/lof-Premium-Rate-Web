import fs from 'node:fs/promises';
import path from 'node:path';
import { execSync } from 'node:child_process';

const projectRoot = process.cwd();
const outputPath = path.join(projectRoot, 'public', 'generated', 'github-traffic.json');
const historyPath = path.join(projectRoot, '.cache', 'fund-sync', 'github-traffic-history.json');
const SNAPSHOT_TZ = 'Asia/Shanghai';
const SNAPSHOT_HOUR_CST = Math.max(0, Math.min(23, Number.parseInt(String(process.env.GH_TRAFFIC_SNAPSHOT_HOUR_CST || '12'), 10) || 12));
const SNAPSHOT_WINDOW_MINUTES = Math.max(1, Math.min(59, Number.parseInt(String(process.env.GH_TRAFFIC_SNAPSHOT_WINDOW_MINUTES || '20'), 10) || 20));
const SNAPSHOT_KEEP_DAYS = 180;

function inferRepoFromGitRemote() {
  try {
    const remote = execSync('git config --get remote.origin.url', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
    const match = remote.match(/github\.com[:/](.+?)(?:\.git)?$/i);
    return match?.[1] || '';
  } catch {
    return '';
  }
}

const repo = process.env.GH_TRAFFIC_REPO || process.env.GITHUB_REPOSITORY || inferRepoFromGitRemote();
const token = process.env.GH_TRAFFIC_TOKEN || '';

function toDateKey(timestamp) {
  return String(timestamp || '').slice(0, 10);
}

function getCstClock(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: SNAPSHOT_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const pick = (type) => parts.find((item) => item.type === type)?.value || '';
  return {
    date: `${pick('year')}-${pick('month')}-${pick('day')}`,
    hour: Number.parseInt(pick('hour'), 10) || 0,
    minute: Number.parseInt(pick('minute'), 10) || 0,
  };
}

function sumMetric(items, key) {
  return items.reduce((sum, item) => sum + (Number(item?.[key]) || 0), 0);
}

function buildRecentSeven(days) {
  const lastSeven = days.slice(-7);
  return {
    days: lastSeven,
    viewCount: sumMetric(lastSeven, 'viewCount'),
    viewUniques: sumMetric(lastSeven, 'viewUniques'),
    cloneCount: sumMetric(lastSeven, 'cloneCount'),
    cloneUniques: sumMetric(lastSeven, 'cloneUniques'),
  };
}

function sanitizeHistory(input) {
  const list = Array.isArray(input?.snapshots) ? input.snapshots : [];
  return {
    snapshots: list
      .map((item) => ({
        date: String(item?.date || ''),
        viewCount: Number(item?.viewCount) || 0,
        viewUniques: Number(item?.viewUniques) || 0,
        cloneCount: Number(item?.cloneCount) || 0,
        cloneUniques: Number(item?.cloneUniques) || 0,
      }))
      .filter((item) => /^\d{4}-\d{2}-\d{2}$/.test(item.date))
      .sort((a, b) => a.date.localeCompare(b.date)),
  };
}

async function readHistory() {
  try {
    const raw = await fs.readFile(historyPath, 'utf8');
    return sanitizeHistory(JSON.parse(raw));
  } catch {
    return { snapshots: [] };
  }
}

function pruneHistoryDays(snapshots) {
  if (!snapshots.length) {
    return [];
  }

  return snapshots.slice(-SNAPSHOT_KEEP_DAYS);
}

async function writeHistory(history) {
  await fs.mkdir(path.dirname(historyPath), { recursive: true });
  await fs.writeFile(historyPath, `${JSON.stringify(history, null, 2)}\n`, 'utf8');
}

function summarizeSnapshots(snapshots) {
  const totalDays = snapshots.length;
  return {
    totalDays,
    cumulativeViewUniques: sumMetric(snapshots, 'viewUniques'),
    cumulativeViewCount: sumMetric(snapshots, 'viewCount'),
    latestCapturedDate: totalDays ? snapshots[totalDays - 1].date : '',
  };
}

function shouldCaptureSnapshotToday(history, cstClock) {
  if (cstClock.hour !== SNAPSHOT_HOUR_CST) {
    return false;
  }
  if (cstClock.minute >= SNAPSHOT_WINDOW_MINUTES) {
    return false;
  }

  return !history.snapshots.some((item) => item.date === cstClock.date);
}

function mergeSnapshot(history, dayKey, latestDayData) {
  const byDate = new Map(history.snapshots.map((item) => [item.date, item]));
  byDate.set(dayKey, {
    date: dayKey,
    viewCount: Number(latestDayData?.viewCount) || 0,
    viewUniques: Number(latestDayData?.viewUniques) || 0,
    cloneCount: Number(latestDayData?.cloneCount) || 0,
    cloneUniques: Number(latestDayData?.cloneUniques) || 0,
  });

  const snapshots = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  return {
    snapshots: pruneHistoryDays(snapshots),
  };
}

async function fetchGithubTraffic(endpoint) {
  const response = await fetch(`https://api.github.com${endpoint}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'premium-estimator-site/github-traffic-sync',
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub traffic API ${endpoint} failed: ${response.status} ${body.slice(0, 180)}`);
  }

  return response.json();
}

async function writePayload(payload) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

async function main() {
  const history = await readHistory();
  const cstClock = getCstClock(new Date());
  const basePayload = {
    generatedAt: new Date().toISOString(),
    source: 'github-traffic-api',
    repo,
    available: false,
    reason: '',
    snapshotConfig: {
      timeZone: SNAPSHOT_TZ,
      snapshotHourCst: SNAPSHOT_HOUR_CST,
      windowMinutes: SNAPSHOT_WINDOW_MINUTES,
    },
    snapshotSummary: summarizeSnapshots(history.snapshots),
    recent7: {
      days: [],
      viewCount: 0,
      viewUniques: 0,
      cloneCount: 0,
      cloneUniques: 0,
    },
    snapshots: history.snapshots,
    totals: {
      viewCount: 0,
      viewUniques: 0,
      cloneCount: 0,
      cloneUniques: 0,
    },
  };

  if (!repo) {
    const payload = { ...basePayload, reason: 'missing-repo' };
    await writePayload(payload);
    console.log('[github-traffic] skip: missing repo');
    return;
  }

  if (!token) {
    const payload = { ...basePayload, reason: 'missing-token: set GH_TRAFFIC_TOKEN secret with traffic API access' };
    await writePayload(payload);
    console.log('[github-traffic] skip: missing token');
    return;
  }

  try {
    const [viewsResult, clonesResult] = await Promise.all([
      fetchGithubTraffic(`/repos/${repo}/traffic/views`)
        .then((data) => ({ ok: true, data, error: '' }))
        .catch((error) => ({ ok: false, data: null, error: error instanceof Error ? error.message : String(error) })),
      fetchGithubTraffic(`/repos/${repo}/traffic/clones`)
        .then((data) => ({ ok: true, data, error: '' }))
        .catch((error) => ({ ok: false, data: null, error: error instanceof Error ? error.message : String(error) })),
    ]);

    if (!viewsResult.ok && !clonesResult.ok) {
      throw new Error(`views+clones unavailable; views=${viewsResult.error}; clones=${clonesResult.error}`);
    }

    const views = viewsResult.data || { views: [], count: 0, uniques: 0 };
    const clones = clonesResult.data || { clones: [], count: 0, uniques: 0 };

    const byDay = new Map();

    for (const item of views?.views ?? []) {
      const day = toDateKey(item?.timestamp);
      if (!day) {
        continue;
      }
      byDay.set(day, {
        date: day,
        viewCount: Number(item?.count) || 0,
        viewUniques: Number(item?.uniques) || 0,
        cloneCount: byDay.get(day)?.cloneCount || 0,
        cloneUniques: byDay.get(day)?.cloneUniques || 0,
      });
    }

    for (const item of clones?.clones ?? []) {
      const day = toDateKey(item?.timestamp);
      if (!day) {
        continue;
      }
      byDay.set(day, {
        date: day,
        viewCount: byDay.get(day)?.viewCount || 0,
        viewUniques: byDay.get(day)?.viewUniques || 0,
        cloneCount: Number(item?.count) || 0,
        cloneUniques: Number(item?.uniques) || 0,
      });
    }

    const days = [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
    const latestDay = days.length ? days[days.length - 1] : null;
    let nextHistory = history;

    if (latestDay && shouldCaptureSnapshotToday(history, cstClock)) {
      nextHistory = mergeSnapshot(history, cstClock.date, latestDay);
      await writeHistory(nextHistory);
    }

    const partialWarnings = [
      viewsResult.ok ? '' : `views-failed: ${viewsResult.error}`,
      clonesResult.ok ? '' : `clones-failed: ${clonesResult.error}`,
    ].filter(Boolean);
    const payload = {
      generatedAt: new Date().toISOString(),
      source: 'github-traffic-api',
      repo,
      available: true,
      reason: partialWarnings.join(' | '),
      snapshotConfig: {
        timeZone: SNAPSHOT_TZ,
        snapshotHourCst: SNAPSHOT_HOUR_CST,
        windowMinutes: SNAPSHOT_WINDOW_MINUTES,
      },
      snapshotSummary: summarizeSnapshots(nextHistory.snapshots),
      recent7: buildRecentSeven(days),
      snapshots: nextHistory.snapshots,
      totals: {
        viewCount: Number(views?.count) || 0,
        viewUniques: Number(views?.uniques) || 0,
        cloneCount: Number(clones?.count) || 0,
        cloneUniques: Number(clones?.uniques) || 0,
      },
      last14Days: days,
    };

    await writePayload(payload);
    console.log(`[github-traffic] updated ${repo} recent7 uv=${payload.recent7.viewUniques}, pv=${payload.recent7.viewCount}`);
  } catch (error) {
    const payload = {
      ...basePayload,
      reason: error instanceof Error ? error.message : String(error),
    };
    await writePayload(payload);
    console.warn(`[github-traffic] fallback: ${payload.reason}`);
  }
}

await main();
