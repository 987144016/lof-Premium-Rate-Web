import fs from 'node:fs/promises';
import path from 'node:path';
import catalog from '../src/data/fundCatalog.json' with { type: 'json' };

const projectRoot = process.cwd();
const outputPath = path.join(projectRoot, 'public', 'generated', 'funds-runtime.json');
const dailyCacheDir = path.join(projectRoot, '.cache', 'fund-sync', 'daily');
const intradayCacheDir = path.join(projectRoot, '.cache', 'fund-sync', 'intraday');
const watchlistStatePath = path.join(projectRoot, '.cache', 'fund-sync', 'watchlist-state.json');
const now = new Date();
const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
const WATCHLIST_STATE_VERSION = 3;
const MAX_LEAD_MOVE = 0.08;
const HOLDINGS_161128 = [
  { ticker: 'NVDA', name: '英伟达', currency: 'USD' },
  { ticker: 'AAPL', name: '苹果', currency: 'USD' },
  { ticker: 'MSFT', name: '微软', currency: 'USD' },
  { ticker: 'AVGO', name: '博通', currency: 'USD' },
  { ticker: 'PLTR', name: 'Palantir', currency: 'USD' },
  { ticker: 'AMD', name: '超威半导体', currency: 'USD' },
  { ticker: 'ORCL', name: '甲骨文', currency: 'USD' },
  { ticker: 'MU', name: '美光科技', currency: 'USD' },
  { ticker: 'CSCO', name: '思科', currency: 'USD' },
  { ticker: 'IBM', name: 'IBM', currency: 'USD' },
];
let intradayPromise = null;

function getDefaultWatchlistModel() {
  return {
    alpha: 0,
    betaLead: 0.38,
    learningRate: 0.24,
    sampleCount: 0,
    meanAbsError: 0,
  };
}

function getDefaultJournal() {
  return {
    snapshots: [],
    errors: [],
  };
}

function normalizePersistedState(entry, sourceVersion) {
  if (!entry) {
    return {
      modelVersion: WATCHLIST_STATE_VERSION,
      model: getDefaultWatchlistModel(),
      journal: getDefaultJournal(),
    };
  }

  return {
    modelVersion: WATCHLIST_STATE_VERSION,
    model: sourceVersion === WATCHLIST_STATE_VERSION ? { ...getDefaultWatchlistModel(), ...(entry.model ?? {}) } : getDefaultWatchlistModel(),
    journal: {
      snapshots: entry.journal?.snapshots ?? [],
      errors: entry.journal?.errors ?? [],
    },
  };
}

function estimateWatchlistFund(runtime, model) {
  const anchorNav = runtime.officialNavT1;
  const rawLeadReturn = runtime.previousClose > 0 ? runtime.marketPrice / runtime.previousClose - 1 : 0;
  const leadReturn = Math.max(-MAX_LEAD_MOVE, Math.min(MAX_LEAD_MOVE, rawLeadReturn));
  const learnedBiasReturn = model.alpha;
  const impliedReturn = learnedBiasReturn + model.betaLead * leadReturn;
  const estimatedNav = anchorNav * (1 + impliedReturn);
  const premiumRate = estimatedNav > 0 ? runtime.marketPrice / estimatedNav - 1 : 0;

  return {
    anchorNav,
    leadReturn,
    learnedBiasReturn,
    impliedReturn,
    estimatedNav,
    premiumRate,
  };
}

function reconcileJournal(runtime, currentModel, currentJournal) {
  const actualNavByDate = new Map(runtime.navHistory.map((item) => [item.date, item.nav]));
  const resolvedDates = new Set((currentJournal.errors ?? []).map((item) => item.date));
  let model = { ...getDefaultWatchlistModel(), ...currentModel };
  const nextErrors = [...(currentJournal.errors ?? [])];

  for (const snapshot of currentJournal.snapshots ?? []) {
    if (resolvedDates.has(snapshot.estimateDate)) {
      continue;
    }

    const actualNav = actualNavByDate.get(snapshot.estimateDate);
    if (!actualNav) {
      continue;
    }

    const targetReturn = snapshot.anchorNav > 0 ? actualNav / snapshot.anchorNav - 1 : 0;
    const predictedReturn = snapshot.impliedReturn;
    const error = targetReturn - predictedReturn;
    const nextSampleCount = model.sampleCount + 1;
    const adaptiveRate = model.learningRate / Math.sqrt(nextSampleCount);
    const nextMae =
      model.sampleCount === 0
        ? Math.abs(error)
        : (model.meanAbsError * model.sampleCount + Math.abs(error)) / nextSampleCount;

    model = {
      ...model,
      alpha: model.alpha + adaptiveRate * error,
      betaLead: model.betaLead + adaptiveRate * error * snapshot.leadReturn,
      sampleCount: nextSampleCount,
      meanAbsError: nextMae,
      lastUpdatedAt: new Date().toISOString(),
    };

    nextErrors.push({
      date: snapshot.estimateDate,
      estimatedNav: snapshot.estimatedNav,
      actualNav,
      premiumRate: snapshot.premiumRate,
      error,
      absError: Math.abs(error),
    });
    resolvedDates.add(snapshot.estimateDate);
  }

  nextErrors.sort((left, right) => left.date.localeCompare(right.date));

  return {
    model,
    journal: {
      snapshots: currentJournal.snapshots ?? [],
      errors: nextErrors,
    },
  };
}

function recordEstimateSnapshot(journal, runtime, estimate) {
  const estimateDate = runtime.marketDate || new Date().toISOString().slice(0, 10);
  const snapshots = journal.snapshots ?? [];
  if (snapshots.find((item) => item.estimateDate === estimateDate)) {
    return journal;
  }

  return {
    ...journal,
    snapshots: [
      ...snapshots,
      {
        estimateDate,
        estimatedNav: estimate.estimatedNav,
        marketPrice: runtime.marketPrice,
        premiumRate: estimate.premiumRate,
        anchorNav: estimate.anchorNav,
        leadReturn: estimate.leadReturn,
        impliedReturn: estimate.impliedReturn,
        createdAt: new Date().toISOString(),
      },
    ].sort((left, right) => left.estimateDate.localeCompare(right.estimateDate)),
  };
}

function getQuoteSymbol(code) {
  return `${code.startsWith('5') ? 'sh' : 'sz'}${code}`;
}

async function fetchText(url, headers = {}, encoding = 'utf-8') {
  const response = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0',
      referer: 'https://fund.eastmoney.com/',
      ...headers,
    },
  });

  if (!response.ok) {
    throw new Error(`Request failed: ${url} (${response.status})`);
  }

  const buffer = await response.arrayBuffer();
  return new TextDecoder(encoding).decode(buffer);
}

async function readJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, payload) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
}

function stripHtml(value) {
  return value.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function extractField(html, label) {
  const pattern = new RegExp(`${label}<\/th><td[^>]*>([\s\S]{0,500}?)<\/td>`, 'i');
  const match = html.match(pattern);
  return match ? stripHtml(match[1]) : '';
}

function parsePurchaseStatus(html) {
  const compact = html.replace(/\s+/g, ' ');
  const match = compact.match(
    /交易状态：<\/span><span class="staticCell">([^<]+?)(?:\s*\(<span>([^<]+)<\/span>\))?<\/span><span class="staticCell">([^<]+)<\/span>/i,
  );

  if (!match) {
    return {
      purchaseStatus: '',
      purchaseLimit: '',
    };
  }

  const baseStatus = stripHtml(match[1]);
  const limitText = stripHtml(match[2] ?? '');
  const redeemStatus = stripHtml(match[3]);
  const purchaseStatus = [baseStatus, redeemStatus].filter(Boolean).join(' / ');

  return {
    purchaseStatus,
    purchaseLimit: limitText,
  };
}

function parseBasicInfo(html, fallbackName) {
  const titleMatch = html.match(/<title>(.*?)<\/title>/i);
  const titleName = titleMatch
    ? stripHtml(titleMatch[1]).replace(/基金基本概况.*$/u, '').replace(/ _ 基金档案.*$/u, '').trim()
    : '';

  return {
    name: titleName || fallbackName,
    fundType: extractField(html, '基金类型'),
    benchmark: extractField(html, '业绩比较基准'),
  };
}

function formatLocalDate(timestamp) {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parsePingzhongData(content) {
  const nameMatch = content.match(/var\s+fS_name\s*=\s*"([^"]+)"/);
  const netWorthMatch = content.match(/var\s+Data_netWorthTrend\s*=\s*(\[[\s\S]*?\]);/);
  const name = nameMatch ? nameMatch[1].trim() : '';

  if (!netWorthMatch) {
    return { name, navHistory: [] };
  }

  const series = JSON.parse(netWorthMatch[1]);
  const navHistory = series
    .map((item) => ({
      date: formatLocalDate(item.x),
      nav: Number(item.y) || 0,
    }))
    .filter((item) => item.date && item.nav > 0)
    .slice(-60)
    .reverse();

  return { name, navHistory };
}

function parseQuote(raw) {
  const match = raw.match(/="([^"]+)"/);
  if (!match) {
    return {
      marketPrice: 0,
      previousClose: 0,
      marketDate: '',
      marketTime: '',
      marketSource: '腾讯行情',
    };
  }

  const fields = match[1].split('~');
  const dateTimeRaw = fields.find((field) => /^\d{14}$/.test(field)) || '';

  return {
    marketPrice: Number(fields[3]) || 0,
    previousClose: Number(fields[4]) || 0,
    marketDate: dateTimeRaw.length >= 8 ? `${dateTimeRaw.slice(0, 4)}-${dateTimeRaw.slice(4, 6)}-${dateTimeRaw.slice(6, 8)}` : '',
    marketTime: dateTimeRaw.length >= 14 ? `${dateTimeRaw.slice(8, 10)}:${dateTimeRaw.slice(10, 12)}:${dateTimeRaw.slice(12, 14)}` : '',
    marketSource: '腾讯行情',
  };
}

function parseFxQuote(raw) {
  const currentMatch = raw.match(/var hq_str_fx_susdcny="([^"]+)"/);
  const backupMatch = raw.match(/var hq_str_USDCNY="([^"]+)"/);
  const fields = (currentMatch?.[1] || backupMatch?.[1] || '').split(',');

  if (fields.length < 9) {
    return {
      pair: 'USD/CNY',
      currentRate: 0,
      previousCloseRate: 0,
      quoteDate: '',
      quoteTime: '',
      source: '新浪外汇',
    };
  }

  return {
    pair: 'USD/CNY',
    currentRate: Number(fields[1]) || 0,
    previousCloseRate: Number(fields[2]) || 0,
    quoteDate: fields[fields.length - 1] || '',
    quoteTime: fields[0] || '',
    source: '新浪外汇',
  };
}

function parseUsQuoteRow(rawRow) {
  const fields = rawRow.split('~');
  const dateTime = fields[30] || '';

  return {
    name: fields[1] || '',
    ticker: fields[2]?.split('.')[0] || '',
    currentPrice: Number(fields[3]) || 0,
    previousClose: Number(fields[4]) || 0,
    quoteDate: dateTime.split(' ')[0] || '',
    quoteTime: dateTime.split(' ')[1] || '',
  };
}

function parseUsQuotes(raw) {
  return raw
    .split(';')
    .map((row) => row.trim())
    .filter(Boolean)
    .map((row) => {
      const match = row.match(/="([^"]+)"/);
      return match ? parseUsQuoteRow(match[1]) : null;
    })
    .filter(Boolean);
}

async function pruneIntradayCache() {
  await fs.mkdir(intradayCacheDir, { recursive: true });
  const entries = await fs.readdir(intradayCacheDir);
  const cutoff = Date.now() - 3 * 24 * 60 * 60 * 1000;

  for (const entry of entries) {
    const fullPath = path.join(intradayCacheDir, entry);
    const stat = await fs.stat(fullPath);
    if (stat.mtimeMs < cutoff) {
      await fs.rm(fullPath, { force: true });
    }
  }
}

async function getDailyFundData(entry) {
  const cachePath = path.join(dailyCacheDir, `${entry.code}.json`);
  const cached = await readJson(cachePath, null);
  if (cached?.fetchedDate === today) {
    return { ...cached, cacheMode: 'daily-cache' };
  }

  const [basicHtml, pingzhongData, fundHtml] = await Promise.all([
    fetchText(`https://fundf10.eastmoney.com/jbgk_${entry.code}.html`, {}, 'utf-8'),
    fetchText(`https://fund.eastmoney.com/pingzhongdata/${entry.code}.js?v=${Date.now()}`, {
      referer: `https://fund.eastmoney.com/${entry.code}.html`,
    }, 'gb18030'),
    fetchText(`https://fund.eastmoney.com/${entry.code}.html`, {}, 'utf-8'),
  ]);

  const pingzhong = parsePingzhongData(pingzhongData);
  const basic = parseBasicInfo(basicHtml, pingzhong.name);
  const purchase = parsePurchaseStatus(fundHtml);
  const latestNav = pingzhong.navHistory[0] ?? { date: '', nav: 0 };
  const payload = {
    fetchedDate: today,
    name: basic.name || entry.code,
    fundType: basic.fundType,
    benchmark: basic.benchmark,
    officialNavT1: latestNav.nav,
    navDate: latestNav.date,
    navHistory: pingzhong.navHistory,
    purchaseStatus: purchase.purchaseStatus,
    purchaseLimit: purchase.purchaseLimit,
  };

  await writeJson(cachePath, payload);
  return { ...payload, cacheMode: 'fresh' };
}

async function loadIntradayData() {
  const cachePath = path.join(intradayCacheDir, `${today}.json`);
  const cached = await readJson(cachePath, { funds: {}, fx: null, holdings161128: [] });

  try {
    const fundSymbols = catalog.map((item) => getQuoteSymbol(item.code)).join(',');
    const holdingSymbols = HOLDINGS_161128.map((item) => `us${item.ticker}`).join(',');
    const [fundQuotesRaw, fxRaw, holdingsRaw] = await Promise.all([
      fetchText(`https://qt.gtimg.cn/q=${fundSymbols}`, { referer: 'https://gu.qq.com/' }, 'gb18030'),
      fetchText('https://hq.sinajs.cn/list=USDCNY,fx_susdcny', { referer: 'https://finance.sina.com.cn/' }, 'gb18030'),
      fetchText(`https://qt.gtimg.cn/q=${holdingSymbols}`, { referer: 'https://gu.qq.com/' }, 'gb18030'),
    ]);

    const funds = {};
    for (const row of fundQuotesRaw.split(';')) {
      const trimmed = row.trim();
      if (!trimmed) {
        continue;
      }

      const codeMatch = trimmed.match(/^v_(?:sz|sh)(\d+)="/);
      if (!codeMatch) {
        continue;
      }

      funds[codeMatch[1]] = parseQuote(trimmed);
    }

    const payload = {
      fetchedAt: new Date().toISOString(),
      funds,
      fx: parseFxQuote(fxRaw),
      holdings161128: parseUsQuotes(holdingsRaw).map((item) => ({
        ...item,
        currency: 'USD',
      })),
    };

    await writeJson(cachePath, payload);
    await pruneIntradayCache();
    return { ...payload, cacheMode: 'fresh' };
  } catch {
    return { ...cached, cacheMode: 'intraday-cache' };
  }
}

async function getIntradayData() {
  if (!intradayPromise) {
    intradayPromise = loadIntradayData().finally(() => {
      intradayPromise = null;
    });
  }

  return intradayPromise;
}

async function syncFund(entry) {
  const [dailyData, intradayData] = await Promise.all([getDailyFundData(entry), getIntradayData()]);
  const quote = intradayData.funds?.[entry.code] ?? {
    marketPrice: 0,
    previousClose: 0,
    marketDate: '',
    marketTime: '',
    marketSource: '腾讯行情',
  };
  const holdingQuotes = entry.code === '161128' ? intradayData.holdings161128 ?? [] : [];
  const holdingsMeta = holdingQuotes[0] ?? null;

  return {
    code: entry.code,
    priority: entry.priority,
    detailMode: entry.detailMode,
    name: dailyData.name || entry.code,
    fundType: dailyData.fundType,
    benchmark: dailyData.benchmark,
    officialNavT1: dailyData.officialNavT1,
    navDate: dailyData.navDate,
    navHistory: dailyData.navHistory,
    marketPrice: quote.marketPrice,
    previousClose: quote.previousClose,
    marketDate: quote.marketDate,
    marketTime: quote.marketTime,
    marketSource: quote.marketSource,
    purchaseStatus: dailyData.purchaseStatus,
    purchaseLimit: dailyData.purchaseLimit,
    fx: intradayData.fx,
    holdingQuotes,
    holdingsQuoteDate: holdingsMeta?.quoteDate || '',
    holdingsQuoteTime: holdingsMeta?.quoteTime || '',
    cacheMode: intradayData.cacheMode === 'intraday-cache' ? 'intraday-cache' : dailyData.cacheMode,
  };
}

async function main() {
  await fs.mkdir(dailyCacheDir, { recursive: true });
  await fs.mkdir(intradayCacheDir, { recursive: true });

  const funds = [];
  const rawStateCache = await readJson(watchlistStatePath, {});
  const sourceVersion = rawStateCache.__meta?.version ?? 1;
  const stateByCode = {};

  for (const entry of catalog) {
    try {
      const runtime = await syncFund(entry);
      const currentState = normalizePersistedState(rawStateCache[entry.code], sourceVersion);
      const reconciled = reconcileJournal(runtime, currentState.model, currentState.journal);
      const estimate = estimateWatchlistFund(runtime, reconciled.model);
      const journal = recordEstimateSnapshot(reconciled.journal, runtime, estimate);

      funds.push(runtime);
      stateByCode[entry.code] = {
        modelVersion: WATCHLIST_STATE_VERSION,
        model: reconciled.model,
        journal,
      };
    } catch (error) {
      console.error(`Sync failed for ${entry.code}:`, error instanceof Error ? error.message : error);
    }
  }

  funds.sort((left, right) => left.priority - right.priority);
  await writeJson(watchlistStatePath, {
    __meta: {
      version: WATCHLIST_STATE_VERSION,
      updatedAt: new Date().toISOString(),
    },
    ...stateByCode,
  });

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(
    outputPath,
    JSON.stringify(
      {
        syncedAt: new Date().toISOString(),
        funds,
        stateByCode,
      },
      null,
      2,
    ),
    'utf8',
  );

  console.log(`Synced ${funds.length} funds to ${path.relative(projectRoot, outputPath)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
