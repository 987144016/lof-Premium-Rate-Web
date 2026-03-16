import fs from 'node:fs/promises';
import path from 'node:path';
import { execSync } from 'node:child_process';

const projectRoot = process.cwd();
const outputPath = path.join(projectRoot, 'public', 'generated', 'github-traffic.json');
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
const token = process.env.GH_TRAFFIC_TOKEN || process.env.GITHUB_TOKEN || '';

function toDateKey(timestamp) {
  return String(timestamp || '').slice(0, 10);
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
  const basePayload = {
    generatedAt: new Date().toISOString(),
    source: 'github-traffic-api',
    repo,
    available: false,
    reason: '',
    recent7: {
      days: [],
      viewCount: 0,
      viewUniques: 0,
      cloneCount: 0,
      cloneUniques: 0,
    },
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
    const payload = { ...basePayload, reason: 'missing-token' };
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
      recent7: buildRecentSeven(days),
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
