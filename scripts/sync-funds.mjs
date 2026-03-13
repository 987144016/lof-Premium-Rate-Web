import fs from 'node:fs/promises';
import path from 'node:path';
import { load } from 'cheerio';
import catalog from '../src/data/fundCatalog.json' with { type: 'json' };
import { parseNoticeHoldingsDisclosure } from './notice-parsers/registry.mjs';

const projectRoot = process.cwd();
const outputPath = path.join(projectRoot, 'public', 'generated', 'funds-runtime.json');
const dailyCacheDir = path.join(projectRoot, '.cache', 'fund-sync', 'daily');
const intradayCacheDir = path.join(projectRoot, '.cache', 'fund-sync', 'intraday');
const watchlistStatePath = path.join(projectRoot, '.cache', 'fund-sync', 'watchlist-state.json');
const holdingsDisclosurePath = path.join(projectRoot, '.cache', 'fund-sync', 'holdings-disclosures.json');
const PUBLISHED_RUNTIME_URLS = [
  'https://987144016.github.io/lof-Premium-Rate-Web/generated/funds-runtime.json',
  'https://987144016.github.io/lof-Premium-Rate-Web/?state-probe=1',
];
const now = new Date();
const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
const WATCHLIST_STATE_VERSION = 5;
const DAILY_CACHE_VERSION = 32;
const MAX_MARKET_MOVE = 0.08;
const MAX_PROXY_MOVE = 0.15;
const MAX_CLOSE_GAP = 0.2;
const MAX_FX_MOVE = 0.05;
const JOURNAL_RETENTION_DAYS = 90;
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
const PROXY_BASKETS = {
  'us-tech-large': {
    name: '美股科技篮子',
    components: [
      { ticker: 'QQQ', name: 'Invesco QQQ Trust', weight: 0.7 },
      { ticker: 'XLK', name: 'Technology Select Sector SPDR', weight: 0.3 },
    ],
  },
  'us-semiconductor': {
    name: '半导体篮子',
    components: [{ ticker: 'SOXX', name: 'iShares Semiconductor ETF', weight: 1 }],
  },
  'us-commodities': {
    name: '大宗商品篮子',
    components: [{ ticker: 'DBC', name: 'Invesco DB Commodity Index Tracking Fund', weight: 1 }],
  },
  'us-gold': {
    name: '黄金篮子',
    components: [{ ticker: 'GLD', name: 'SPDR Gold Shares', weight: 1 }],
  },
  'us-silver': {
    name: '白银篮子',
    components: [{ ticker: 'SLV', name: 'iShares Silver Trust', weight: 1 }],
  },
  'us-precious-metals': {
    name: '贵金属篮子',
    components: [
      { ticker: 'GLD', name: 'SPDR Gold Shares', weight: 0.75 },
      { ticker: 'SLV', name: 'iShares Silver Trust', weight: 0.25 },
    ],
  },
  'us-oil': {
    name: '原油篮子',
    components: [
      { ticker: 'USO', name: 'United States Oil Fund', weight: 0.75 },
      { ticker: 'XLE', name: 'Energy Select Sector SPDR', weight: 0.25 },
    ],
  },
  'us-oil-upstream': {
    name: '油气上游篮子',
    components: [
      { ticker: 'XOP', name: 'SPDR S&P Oil & Gas E&P ETF', weight: 0.7 },
      { ticker: 'XLE', name: 'Energy Select Sector SPDR', weight: 0.3 },
    ],
  },
  'us-sandp500': {
    name: '标普500篮子',
    components: [{ ticker: 'SPY', name: 'SPDR S&P 500 ETF Trust', weight: 1 }],
  },
  'us-overseas-tech': {
    name: '海外科技篮子',
    components: [
      { ticker: 'IXN', name: 'iShares Global Tech ETF', weight: 0.35 },
      { ticker: 'XLK', name: 'Technology Select Sector SPDR', weight: 0.65 },
    ],
  },
  'us-nasdaq100': {
    name: '纳指100篮子',
    components: [{ ticker: 'QQQ', name: 'Invesco QQQ Trust', weight: 1 }],
  },
};
const RELATED_ETF_FALLBACKS = {
  '501011': '560080',
};
const SUPPLEMENTAL_NOTICE_HOLDINGS = {
  '160216': [
    { ticker: 'CPER', aliases: ['United States Copper Index Fund'] },
    { ticker: 'GLD', aliases: ['SPDR Gold Shares ETF', 'SPDR Gold ETF'] },
    { ticker: 'GLDM', aliases: ['SPDR Gold MiniShares Trust', 'MiniShares Trust'] },
    { ticker: 'SGOL', aliases: ['abrdn Physical Gold Shares ETF', 'abrdn Physical Gold ETF'] },
    { ticker: 'UGL', aliases: ['ProShares Ultra Gold ETF'] },
    { ticker: 'COPX', aliases: ['Global X Copper Miners ETF'] },
    { ticker: 'DBB', aliases: ['Invesco DB Base Metals Fund'] },
    { ticker: 'GDXU', aliases: ['MicroSectors Gold Miners 3X Leveraged ETN', 'Gold Miners 3X Leveraged ETN'] },
  ],
  '161116': [
    { ticker: 'GLD', aliases: ['SPDR Gold Shares ETF'] },
    { ticker: 'SGOL', aliases: ['abrdn Physical Gold Shares ETF'] },
    { ticker: 'GLDM', aliases: ['SPDR Gold MiniShares ETF Trust', 'SPDR Gold MiniShares Trust'] },
    { ticker: 'IAU', aliases: ['iShares Gold Trust ETF', 'iShares Gold Trust'] },
    { ticker: 'UGL', aliases: ['ProShares Ultra Gold ETF'] },
  ],
  '164701': [
    { ticker: 'UGL', aliases: ['ProShares Ultra Gold ETF'] },
    { ticker: 'GLDM', aliases: ['SPDR Gold MiniShares Trust'] },
    { ticker: 'GLD', aliases: ['SPDR Gold Shares ETF'] },
    { ticker: 'AAAU', aliases: ['Goldman Sachs Physical Gold ETF'] },
    { ticker: 'SIVR', aliases: ['abrdn Physical Silver Shares ETF'] },
  ],
  '160719': [
    { ticker: 'GLD', aliases: ['SPDR Gold Shares ETF'] },
    { ticker: 'SGOL', aliases: ['abrdn Physical Gold Shares ETF', 'Physical Gold Shares ETF'] },
    { ticker: 'IAU', aliases: ['iShares Gold Trust ETF', 'iShares Gold Trust'] },
  ],
  '501312': [
    { ticker: 'ARKK', aliases: ['ARK Innovation ETF'] },
    { ticker: 'ARKG', aliases: ['ARK Genomic Revolution ETF'] },
    { ticker: 'ARKQ', aliases: ['ARK Autonomous Technology & Robotics ETF'] },
    { ticker: 'SOXX', aliases: ['iShares Semiconductor ETF'] },
    { ticker: 'AIQ', aliases: ['Global X Artificial Intelligence & Technology ETF', 'Artificial Intelligence & Technology ETF'] },
    { ticker: 'BOTZ', aliases: ['Global X Robotics & Artificial Intelligence ETF'] },
    { ticker: 'QQQ', aliases: ['Invesco QQQ Trust Series 1'] },
    { ticker: 'XLK', aliases: ['Technology Select Sector SPDR ETF'] },
    { ticker: 'SMH', aliases: ['VanEck Semiconductor ETF'] },
    { ticker: 'FINX', aliases: ['Global X FinTech ETF', 'FinTech ETF'] },
  ],
  '501018': [
    { ticker: 'USO', aliases: ['United States Oil Fund LP', 'United States Oil ETF', 'United States Oil'] },
    { ticker: 'BNO', aliases: ['United States Brent Oil Fund LP', 'Brent Oil Fund LP'] },
    { ticker: 'DBO', aliases: ['Invesco DB Oil Fund', 'Invesco DB Oil'] },
    { ticker: 'WTI_ETC', quoteTicker: 'USO', aliases: ['WisdomTree WTI Crude Oil ETF', 'WisdomTree WTI Crude Oil ETC'] },
    { ticker: 'BRENT_ETC', quoteTicker: 'BNO', aliases: ['WisdomTree Brent Crude Oil ETF', 'WisdomTree Brent Crude Oil ETC'] },
    { ticker: 'SIMPLEX_WTI', quoteTicker: 'USO', aliases: ['Simplex WTI ETF'] },
    { ticker: '1699', quoteTicker: 'USO', aliases: ['NEXT FUNDS NOMURA Crude Oil Long Index Linked ETF'] },
    { ticker: 'UBS_CMCI_OIL', quoteTicker: 'DBO', aliases: ['UBS CMCI Oil SF ETF'] },
  ],
  '501225': [
    { ticker: 'SMH', aliases: ['VanEck Semiconductor ETF'] },
    { ticker: 'SOXQ', aliases: ['Invesco PHLX Semiconductor ETF', 'PHLX Semiconductor ETF'] },
    { ticker: 'SOXX', aliases: ['iShares Semiconductor ETF'] },
    { ticker: 'PSI', aliases: ['Invesco Dynamic Semiconductors ETF', 'Dynamic Semiconductors ETF'] },
    { ticker: '159995', aliases: ['华夏国证半导体芯片ETF', '国证半导体芯片 ETF'] },
    { ticker: '512760', aliases: ['国泰CES半导体芯片行业ETF', 'CES 半导体芯片行业 ETF'] },
    { ticker: '159560', aliases: ['景顺长城中证芯片产业ETF', '中证芯片产业 ETF'] },
  ],
  '161129': [
    { ticker: 'DBO', aliases: ['Invesco DB Oil Fund', 'Invesco DB Oil'] },
  ],
  '160723': [
    { ticker: 'USO', aliases: ['United States Oil Fund LP', 'United States Oil ETF'] },
    { ticker: 'WTI_ETC', quoteTicker: 'USO', aliases: ['WisdomTree WTI Crude Oil', 'WisdomTree WTI Crude Oil ETC'] },
    { ticker: 'SIMPLEX_WTI', quoteTicker: 'USO', aliases: ['Simplex WTI ETF'] },
    { ticker: 'BRENT_ETC', quoteTicker: 'BNO', aliases: ['WisdomTree Brent Crude Oil', 'WisdomTree Brent Crude Oil ETC'] },
    { ticker: 'BNO', aliases: ['United States Brent Oil Fund LP', 'Brent Oil Fund LP'] },
    { ticker: '1699', quoteTicker: 'USO', aliases: ['NEXT FUNDS NOMURA Crude Oil Long Index Linked Exchange Traded', 'NEXT FUNDS NOMURA Crude Oil Long Index Linked ETF'] },
    { ticker: 'BRENT_BBG_ETC', quoteTicker: 'BNO', aliases: ['WisdomTree Bloomberg Brent Crude Oil'] },
  ],
};
let intradayPromise = null;

function clamp(value, limit) {
  return Math.max(-limit, Math.min(limit, value));
}

function getWeightedProxyReturn(runtime) {
  const proxyQuotes = runtime.proxyQuotes ?? [];
  const totalWeight = proxyQuotes.reduce((sum, item) => sum + item.weight, 0);

  if (totalWeight <= 0) {
    return 0;
  }

  return proxyQuotes.reduce((sum, item) => {
    const localReturn = item.previousClose > 0 ? item.currentPrice / item.previousClose - 1 : 0;
    return sum + localReturn * (item.weight / totalWeight);
  }, 0);
}

function getHoldingLineReturn(item) {
  if (item.previousClose <= 0) {
    return 0;
  }

  return item.currentPrice / item.previousClose - 1;
}

function getWeightedHoldingReturn(runtime) {
  const disclosedByTicker = new Map((runtime.disclosedHoldings ?? []).map((item) => [item.ticker.toUpperCase(), item]));
  const weightedQuotes = (runtime.holdingQuotes ?? [])
    .map((item) => {
      const disclosed = disclosedByTicker.get(item.ticker.toUpperCase());
      if (!disclosed?.weight || item.previousClose <= 0) {
        return null;
      }

      return {
        weight: disclosed.weight,
        lineReturn: getHoldingLineReturn(item),
      };
    })
    .filter(Boolean);
  const totalWeight = weightedQuotes.reduce((sum, item) => sum + item.weight, 0);

  if (totalWeight <= 0) {
    return 0;
  }

  return weightedQuotes.reduce((sum, item) => sum + item.lineReturn * (item.weight / totalWeight), 0);
}

function hasHoldingsSignal(runtime) {
  return (runtime.disclosedHoldings?.length ?? 0) > 0 && (runtime.holdingQuotes?.length ?? 0) > 0;
}

function hasUsdHoldingSignal(runtime) {
  return (runtime.holdingQuotes ?? []).some((item) => item.currency === 'USD');
}

function getFxReturn(runtime) {
  const currentRate = runtime.fx?.currentRate ?? 0;
  const previousCloseRate = runtime.fx?.previousCloseRate ?? 0;
  return currentRate > 0 && previousCloseRate > 0 ? currentRate / previousCloseRate - 1 : 0;
}

function toIsoDateWithOffset(days) {
  const value = new Date();
  value.setDate(value.getDate() + days);
  return value.toISOString().slice(0, 10);
}

function getSnapshotPriceType(runtime) {
  return runtime.pageCategory === 'domestic-lof' && runtime.marketTime >= '15:00:00' ? 'close' : 'intraday';
}

function finalizeSnapshotWithClose(snapshot, runtime) {
  if (
    runtime.pageCategory !== 'domestic-lof' ||
    !runtime.marketDate ||
    !runtime.navDate ||
    runtime.marketDate <= snapshot.estimateDate ||
    snapshot.estimateDate !== runtime.navDate ||
    runtime.previousClose <= 0
  ) {
    return snapshot;
  }

  return {
    ...snapshot,
    marketPrice: runtime.previousClose,
    premiumRate: snapshot.estimatedNav > 0 ? runtime.previousClose / snapshot.estimatedNav - 1 : snapshot.premiumRate,
    marketPriceDate: snapshot.estimateDate,
    marketPriceTime: '15:00:00',
    marketPriceType: 'close',
  };
}

function pruneJournal(journal) {
  const cutoffDate = toIsoDateWithOffset(-JOURNAL_RETENTION_DAYS);

  return {
    snapshots: (journal.snapshots ?? []).filter((item) => item.estimateDate >= cutoffDate),
    errors: (journal.errors ?? []).filter((item) => item.date >= cutoffDate),
  };
}

function getDefaultWatchlistModel() {
  return {
    alpha: 0,
    betaLead: 0.38,
    betaGap: 0,
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

function normalizePersistedState(entry) {
  if (!entry) {
    return {
      modelVersion: WATCHLIST_STATE_VERSION,
      model: getDefaultWatchlistModel(),
      journal: getDefaultJournal(),
    };
  }

  return {
    modelVersion: WATCHLIST_STATE_VERSION,
    model: entry.modelVersion === WATCHLIST_STATE_VERSION ? { ...getDefaultWatchlistModel(), ...(entry.model ?? {}) } : getDefaultWatchlistModel(),
    journal: pruneJournal({
      snapshots: entry.journal?.snapshots ?? [],
      errors: entry.journal?.errors ?? [],
    }),
  };
}

function estimateWatchlistFund(runtime, model) {
  const anchorNav = runtime.officialNavT1;
  const useHoldingsEstimate = hasHoldingsSignal(runtime);
  const useProxyEstimate = runtime.estimateMode === 'proxy' && !useHoldingsEstimate;
  const rawLeadReturn = useProxyEstimate
    ? getWeightedProxyReturn(runtime)
    : useHoldingsEstimate
      ? getWeightedHoldingReturn(runtime)
      : runtime.previousClose > 0
        ? runtime.marketPrice / runtime.previousClose - 1
        : 0;
  const leadReturn = clamp(rawLeadReturn, useProxyEstimate ? MAX_PROXY_MOVE : MAX_MARKET_MOVE);
  const rawCloseGapReturn = useProxyEstimate
    ? getFxReturn(runtime)
    : useHoldingsEstimate
      ? hasUsdHoldingSignal(runtime)
        ? getFxReturn(runtime)
        : 0
      : anchorNav > 0 && runtime.previousClose > 0
        ? runtime.previousClose / anchorNav - 1
        : 0;
  const closeGapReturn = clamp(rawCloseGapReturn, useProxyEstimate ? MAX_FX_MOVE : MAX_CLOSE_GAP);
  const learnedBiasReturn = model.alpha;
  const impliedReturn = learnedBiasReturn + model.betaLead * leadReturn + model.betaGap * closeGapReturn;
  const estimatedNav = anchorNav * (1 + impliedReturn);
  const premiumRate = estimatedNav > 0 ? runtime.marketPrice / estimatedNav - 1 : 0;

  return {
    anchorNav,
    leadReturn,
    closeGapReturn,
    learnedBiasReturn,
    impliedReturn,
    estimatedNav,
    premiumRate,
  };
}

function reconcileJournal(runtime, currentModel, currentJournal) {
  const actualNavByDate = new Map(runtime.navHistory.map((item) => [item.date, item.nav]));
  const normalizedJournal = pruneJournal({
    ...currentJournal,
    snapshots: (currentJournal.snapshots ?? []).map((item) => finalizeSnapshotWithClose(item, runtime)),
  });
  const baseJournal = normalizedJournal;
  const trainedDates = new Set(baseJournal.errors.map((item) => item.date));
  const errorByDate = new Map(baseJournal.errors.map((item) => [item.date, item]));
  let model = { ...getDefaultWatchlistModel(), ...currentModel };

  for (const snapshot of baseJournal.snapshots) {
    const actualNav = actualNavByDate.get(snapshot.estimateDate);
    if (!actualNav) {
      continue;
    }

    const targetReturn = snapshot.anchorNav > 0 ? actualNav / snapshot.anchorNav - 1 : 0;
    const predictedReturn = snapshot.impliedReturn;
    const residualError = targetReturn - predictedReturn;
    const displayError = actualNav > 0 ? snapshot.estimatedNav / actualNav - 1 : 0;
    const actualPremiumRate = actualNav > 0 && snapshot.marketPrice > 0 ? snapshot.marketPrice / actualNav - 1 : 0;
    const premiumError = snapshot.premiumRate - actualPremiumRate;
    if (!trainedDates.has(snapshot.estimateDate)) {
      const nextSampleCount = model.sampleCount + 1;
      const adaptiveRate = model.learningRate / Math.sqrt(nextSampleCount);
      const nextMae =
        model.sampleCount === 0
          ? Math.abs(displayError)
          : (model.meanAbsError * model.sampleCount + Math.abs(displayError)) / nextSampleCount;

      model = {
        ...model,
        alpha: model.alpha + adaptiveRate * residualError,
        betaLead: model.betaLead + adaptiveRate * residualError * snapshot.leadReturn,
        betaGap: model.betaGap + adaptiveRate * residualError * snapshot.closeGapReturn,
        sampleCount: nextSampleCount,
        meanAbsError: nextMae,
        lastUpdatedAt: new Date().toISOString(),
      };
      trainedDates.add(snapshot.estimateDate);
    }

    errorByDate.set(snapshot.estimateDate, {
      date: snapshot.estimateDate,
      marketPrice: snapshot.marketPrice,
      estimatedNav: snapshot.estimatedNav,
      actualNav,
      premiumRate: snapshot.premiumRate,
      actualPremiumRate,
      premiumError,
      absPremiumError: Math.abs(premiumError),
      error: displayError,
      absError: Math.abs(displayError),
    });
  }

  const nextErrors = [...errorByDate.values()].sort((left, right) => left.date.localeCompare(right.date));

  return {
    model,
    journal: pruneJournal({
      snapshots: baseJournal.snapshots,
      errors: nextErrors,
    }),
  };
}

function recordEstimateSnapshot(journal, runtime, estimate) {
  const estimateDate = runtime.marketDate || new Date().toISOString().slice(0, 10);
  const snapshots = journal.snapshots ?? [];
  const nextSnapshot = {
    estimateDate,
    estimatedNav: estimate.estimatedNav,
    marketPrice: runtime.marketPrice,
    premiumRate: estimate.premiumRate,
    marketPriceDate: runtime.marketDate || estimateDate,
    marketPriceTime: runtime.marketTime || '',
    marketPriceType: getSnapshotPriceType(runtime),
    anchorNav: estimate.anchorNav,
    leadReturn: estimate.leadReturn,
    closeGapReturn: estimate.closeGapReturn,
    impliedReturn: estimate.impliedReturn,
    createdAt: new Date().toISOString(),
  };

  return pruneJournal({
    ...journal,
    snapshots: [...snapshots.filter((item) => item.estimateDate !== estimateDate), nextSnapshot].sort((left, right) => left.estimateDate.localeCompare(right.estimateDate)),
  });
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

function parseIsoDate(value) {
  if (!value) {
    return null;
  }

  const parsed = new Date(`${value}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function getAgeInDays(value) {
  const parsed = parseIsoDate(value);
  if (!parsed) {
    return Number.POSITIVE_INFINITY;
  }

  return Math.floor((Date.now() - parsed.getTime()) / (24 * 60 * 60 * 1000));
}

function isHoldingsDisclosureWindow(referenceDate = now) {
  const month = referenceDate.getMonth() + 1;

  return month === 1 || month === 2 || month === 3 || month === 4 || month === 7 || month === 8 || month === 10;
}

function shouldRefreshHoldingsDisclosure(cached) {
  const ageInDays = getAgeInDays(cached?.holdingsFetchedDate ?? cached?.fetchedDate ?? '');
  if (!cached?.disclosedHoldingsReportDate) {
    return ageInDays >= 7;
  }

  return ageInDays >= (isHoldingsDisclosureWindow() ? 2 : 21);
}

async function readPublishedRuntimeState() {
  const localRuntime = await readJson(outputPath, null);
  let mergedState = localRuntime?.stateByCode && typeof localRuntime.stateByCode === 'object' ? { ...localRuntime.stateByCode } : {};

  for (const url of PUBLISHED_RUNTIME_URLS) {
    try {
      const response = await fetch(`${url}${url.includes('?') ? '&' : '?'}ts=${Date.now()}`, {
        headers: {
          'user-agent': 'Mozilla/5.0',
        },
      });

      if (!response.ok) {
        continue;
      }

      const payload = await response.json();
      if (payload?.stateByCode && typeof payload.stateByCode === 'object') {
        mergedState = mergePersistedState(payload.stateByCode, mergedState);
      }
    } catch {
      continue;
    }
  }

  return mergedState;
}

function mergePersistedState(primaryState, fallbackState) {
  const merged = { ...fallbackState };

  for (const [code, entry] of Object.entries(primaryState ?? {})) {
    if (!entry || code === '__meta') {
      continue;
    }

    const previousEntry = merged[code] ?? {};
    const previousJournal = previousEntry.journal ?? getDefaultJournal();
    const nextJournal = entry.journal ?? getDefaultJournal();
    const snapshotByDate = new Map();
    const errorByDate = new Map();

    for (const snapshot of previousJournal.snapshots ?? []) {
      if (snapshot?.estimateDate) {
        snapshotByDate.set(snapshot.estimateDate, snapshot);
      }
    }

    for (const snapshot of nextJournal.snapshots ?? []) {
      if (snapshot?.estimateDate) {
        snapshotByDate.set(snapshot.estimateDate, {
          ...(snapshotByDate.get(snapshot.estimateDate) ?? {}),
          ...snapshot,
        });
      }
    }

    for (const error of previousJournal.errors ?? []) {
      if (error?.date) {
        errorByDate.set(error.date, error);
      }
    }

    for (const error of nextJournal.errors ?? []) {
      if (error?.date) {
        errorByDate.set(error.date, {
          ...(errorByDate.get(error.date) ?? {}),
          ...error,
        });
      }
    }

    merged[code] = {
      ...previousEntry,
      ...entry,
      model: entry.model ?? previousEntry.model,
      journal: pruneJournal({
        snapshots: [...snapshotByDate.values()].sort((left, right) => left.estimateDate.localeCompare(right.estimateDate)),
        errors: [...errorByDate.values()].sort((left, right) => left.date.localeCompare(right.date)),
      }),
    };
  }

  return merged;
}

function stripHtml(value) {
  return value.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function extractField(html, label) {
  const pattern = new RegExp(String.raw`${label}<\/th><td[^>]*>([\s\S]{0,500}?)<\/td>`, 'i');
  const match = html.match(pattern);
  return match ? stripHtml(match[1]) : '';
}

function extractRelatedEtfCode(html) {
  const linkMatch = html.match(/href=['"]https?:\/\/fund\.eastmoney\.com\/(\d{6})\.html['"][^>]*>查看相关ETF/i);
  return linkMatch?.[1] ?? '';
}

function parsePurchaseStatusFromHtml(html) {
  const compact = html.replace(/\s+/g, ' ');
  const match = compact.match(
    /交易状态：<\/span><span class="staticCell">([^<]+?)(?:\s*\(<span>([^<]+)<\/span>\))?<\/span><span class="staticCell">([^<]+)<\/span>/i,
  );

  if (!match) {
    return {
      buyStatus: '',
      redeemStatus: '',
      purchaseStatus: '',
      purchaseLimit: '',
    };
  }

  const baseStatus = stripHtml(match[1]);
  const limitText = stripHtml(match[2] ?? '');
  const redeemStatus = stripHtml(match[3]);
  const purchaseStatus = [baseStatus, redeemStatus].filter(Boolean).join(' / ');

  return {
    buyStatus: baseStatus,
    redeemStatus,
    purchaseStatus,
    purchaseLimit: limitText,
  };
}

function mapIsBuyToStatus(value) {
  const code = String(value ?? '').trim();
  if (!code) {
    return '';
  }

  if (code === '4') {
    return '暂停申购';
  }

  return ['1', '2', '3', '8', '9'].includes(code) ? '开放申购' : '';
}

function mapIsSalesToStatus(value) {
  const code = String(value ?? '').trim();
  if (!code) {
    return '';
  }

  return code === '1' ? '开放赎回' : '暂停赎回';
}

async function fetchPurchaseStatusFromApi(code) {
  try {
    const response = await fetchText(
      `https://api.fund.eastmoney.com/Fund/GetSingleFundInfo?callback=x&fcode=${code}&fileds=FCODE,ISBUY,ISSALES,MINDT,DTZT,SHORTNAME`,
      { referer: `https://fund.eastmoney.com/${code}.html` },
      'utf-8',
    );
    const payload = parseJsonpPayload(response);
    const data = payload?.Data;

    return {
      buyStatus: mapIsBuyToStatus(data?.ISBUY),
      redeemStatus: mapIsSalesToStatus(data?.ISSALES),
    };
  } catch {
    return {
      buyStatus: '',
      redeemStatus: '',
    };
  }
}

function mapPortalBuyStatus(value) {
  const normalized = String(value ?? '').trim();
  if (!normalized) {
    return '';
  }

  if (normalized.includes('暂停')) {
    return '暂停申购';
  }

  if (normalized.includes('限')) {
    return '限大额';
  }

  if (normalized.includes('开放')) {
    return '开放申购';
  }

  return '';
}

function mapPortalRedeemStatus(value) {
  const normalized = String(value ?? '').trim();
  if (!normalized) {
    return '';
  }

  if (normalized.includes('暂停')) {
    return '暂停赎回';
  }

  if (normalized.includes('开放')) {
    return '开放赎回';
  }

  return '';
}

async function fetchPurchaseStatusFromPortal(code) {
  try {
    const html = await fetchText(`https://fund.10jqka.com.cn/${code}/`, {}, 'utf-8');
    const plainText = stripHtml(html);
    const buyMatch = plainText.match(/申购状态[:：]\s*([^\s，。；、]{1,12})/);
    const redeemMatch = plainText.match(/赎回状态[:：]\s*([^\s，。；、]{1,12})/);

    return {
      buyStatus: mapPortalBuyStatus(buyMatch?.[1] ?? ''),
      redeemStatus: mapPortalRedeemStatus(redeemMatch?.[1] ?? ''),
    };
  } catch {
    return {
      buyStatus: '',
      redeemStatus: '',
    };
  }
}

function mapNoticeBuyStatus(title) {
  const normalized = String(title ?? '');
  if (!normalized) {
    return '';
  }

  if (/暂停申购/.test(normalized)) {
    return '暂停申购';
  }

  if (/调整大额申购|限制大额申购|大额申购/.test(normalized)) {
    return '限大额';
  }

  if (/恢复申购|开放申购/.test(normalized)) {
    return '开放申购';
  }

  return '';
}

function mapNoticeRedeemStatus(title) {
  const normalized = String(title ?? '');
  if (!normalized) {
    return '';
  }

  if (/暂停赎回/.test(normalized)) {
    return '暂停赎回';
  }

  if (/恢复赎回|开放赎回/.test(normalized)) {
    return '开放赎回';
  }

  return '';
}

function isTemporaryHolidayNotice(title) {
  const normalized = String(title ?? '');
  if (!normalized) {
    return false;
  }

  if (!/暂停申购|暂停赎回|暂停申购、赎回|暂停申购和定投|暂停申购及定投/.test(normalized)) {
    return false;
  }

  // 单日节假日：如 "2026年1月19日暂停申购"
  if (/\d{4}年\d{1,2}月\d{1,2}日/.test(normalized)) {
    return true;
  }

  // 年度境外市场节假日安排公告：如 "2026年境外主要投资市场节假日暂停申购"
  if (/境外主要投资市场节假日/.test(normalized)) {
    return true;
  }

  // 因节假日暂停：如 "因节假日暂停申购"
  if (/因.*节假日/.test(normalized)) {
    return true;
  }

  return false;
}

async function fetchPurchaseStatusFromNotices(code) {
  try {
    const response = await fetchText(
      `https://api.fund.eastmoney.com/f10/JJGG?callback=x&fundcode=${code}&pageIndex=1&pageSize=20&type=5`,
      { referer: `https://fundf10.eastmoney.com/jjgg_${code}_5.html` },
      'utf-8',
    );
    const payload = parseJsonpPayload(response);
    const notices = (payload?.Data ?? [])
      .filter((item) => {
        const title = String(item?.TITLE ?? '');
        if (!title) {
          return false;
        }

        if (!/申购|定投|赎回|大额|暂停|恢复|开放/.test(title)) {
          return false;
        }

        if (/费率优惠|销售业务|终止.*销售业务/.test(title)) {
          return false;
        }

        return !isTemporaryHolidayNotice(title);
      });
    const notice = notices[0];
    const buyStatus = mapNoticeBuyStatus(notice?.TITLE ?? '');
    const redeemStatus = mapNoticeRedeemStatus(notice?.TITLE ?? '');

    return {
      buyStatus,
      redeemStatus,
    };
  } catch {
    return {
      buyStatus: '',
      redeemStatus: '',
    };
  }
}

function pickBuyStatus(statuses) {
  if (statuses.includes('暂停申购')) {
    return '暂停申购';
  }

  if (statuses.includes('限大额')) {
    return '限大额';
  }

  return statuses.includes('开放申购') ? '开放申购' : '';
}

function pickRedeemStatus(statuses) {
  if (statuses.includes('暂停赎回')) {
    return '暂停赎回';
  }

  return statuses.includes('开放赎回') ? '开放赎回' : '';
}

function normalizeLimitNumber(raw) {
  const numeric = Number(String(raw ?? '').replace(/,/g, ''));
  if (!Number.isFinite(numeric)) {
    return '';
  }

  return Number.isInteger(numeric) ? String(numeric) : String(numeric).replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1');
}

function extractLimitAmount(limitText) {
  const normalized = String(limitText ?? '').replace(/\s+/g, '');
  const match = normalized.match(/上限([0-9]+(?:\.[0-9]+)?)(万?元)/);
  if (!match) {
    return '';
  }

  const amount = normalizeLimitNumber(match[1]);
  return amount ? `${amount}${match[2]}` : '';
}

function formatPurchaseLimit(buyStatus, limitText) {
  const normalizedBuyStatus = String(buyStatus ?? '').trim();

  // 暂停申购优先：HTML里的残留限额是历史数据，不应覆盖当前暂停状态
  if (normalizedBuyStatus === '暂停申购') {
    return '0元';
  }

  const amount = extractLimitAmount(limitText);

  if (amount) {
    return amount;
  }

  if (normalizedBuyStatus === '开放申购') {
    return '不限购';
  }

  if (normalizedBuyStatus === '限大额') {
    return '限购';
  }

  return '';
}

function mergePurchaseStatus(htmlStatus, apiStatus, portalStatus, noticeStatus) {
  const noticeBS = noticeStatus?.buyStatus ?? '';
  const htmlBS = htmlStatus?.buyStatus ?? '';
  const apiBS = apiStatus?.buyStatus ?? '';
  const portalBS = portalStatus?.buyStatus ?? '';

  // 公告和HTML是最可靠的来源。
  // 东方财富 ISBUY=4 对"暂停申购"和"限大额"都返回同一值，不够可靠，
  // 因此当公告+HTML已有明确结论时，不让API覆盖结果。
  const primaryBS = pickBuyStatus([noticeBS, htmlBS].filter(Boolean));
  const buyStatus = primaryBS || pickBuyStatus([apiBS, portalBS].filter(Boolean));

  const redeemStatus = pickRedeemStatus([
    htmlStatus?.redeemStatus ?? '',
    apiStatus?.redeemStatus ?? '',
    portalStatus?.redeemStatus ?? '',
  ].filter(Boolean));

  return {
    purchaseStatus: [buyStatus, redeemStatus].filter(Boolean).join(' / '),
    purchaseLimit: formatPurchaseLimit(buyStatus, htmlStatus?.purchaseLimit ?? ''),
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

function parseNumber(value) {
  const normalized = value.replace(/,/g, '').replace(/--/g, '').trim();
  const parsed = Number(normalized.replace(/%$/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function isHoldingTicker(value) {
  return /^[0-9A-Z]{1,10}$/.test(value);
}

function isUsHoldingTicker(value) {
  return /^[A-Z]{1,5}$/.test(value);
}

function parseHoldingsDisclosure(html, quoteByTicker = new Map()) {
  const $ = load(html);
  const reportText = $('h4').first().text().replace(/\s+/g, ' ').trim() || $.root().text().replace(/\s+/g, ' ').trim();
  const reportMatch = reportText.match(/(\d{4}年[1-4]季度股票投资明细).*?截止至：\s*(\d{4}-\d{2}-\d{2})/);
  const table = $('table').filter((_, element) => {
    const rows = $(element).find('tr');
    if (!rows.length) {
      return false;
    }

    return rows
      .toArray()
      .some((row) => {
        const cells = $(row)
          .find('td')
          .map((__, cell) => $(cell).text().replace(/\s+/g, ' ').trim())
          .get()
          .filter(Boolean);

        return cells.length >= 6 && /^\d+$/.test(cells[0]) && isHoldingTicker(cells[1]);
      });
  }).first();

  if (!table.length) {
    return {
      disclosedHoldingsTitle: '',
      disclosedHoldingsReportDate: '',
      disclosedHoldings: [],
    };
  }

  const disclosedHoldings = table
    .find('tr')
    .map((_, row) => {
      const cells = $(row)
        .find('td')
        .map((__, cell) => $(cell).text().replace(/\s+/g, ' ').trim())
        .get()
        .filter(Boolean);

      if (cells.length < 6 || !/^\d+$/.test(cells[0])) {
        return null;
      }

      return {
        ticker: cells[1],
        name: cells[2],
        currentPrice: quoteByTicker.get(cells[1].toUpperCase())?.currentPrice,
        changeRate: quoteByTicker.get(cells[1].toUpperCase())?.changeRate,
        weight: parseNumber(cells[cells.length - 3]),
        shares: parseNumber(cells[cells.length - 2]),
        marketValue: parseNumber(cells[cells.length - 1]),
      };
    })
    .get()
    .filter(Boolean)
    .slice(0, 10);

  return {
    disclosedHoldingsTitle: reportMatch?.[1] ?? '',
    disclosedHoldingsReportDate: reportMatch?.[2] ?? '',
    disclosedHoldings,
  };
}

function parseFundArchivesPayload(content) {
  try {
    return Function(`${content}; return typeof apidata !== 'undefined' ? apidata : null;`)();
  } catch {
    return null;
  }
}

function parseJsonpPayload(content) {
  const normalized = content.trim();
  const jsonText = normalized.startsWith('{')
    ? normalized
    : normalized.replace(/^[^(]+\(/, '').replace(/\);?\s*$/, '');

  try {
    return JSON.parse(jsonText);
  } catch {
    return null;
  }
}

async function fetchNoticeHoldingsDisclosure(code) {
  const aliases = SUPPLEMENTAL_NOTICE_HOLDINGS[code];
  if (!aliases?.length) {
    return null;
  }

  const listResponse = await fetchText(
    `https://api.fund.eastmoney.com/f10/JJGG?callback=x&fundcode=${code}&pageIndex=1&pageSize=20&type=3`,
    { referer: `https://fundf10.eastmoney.com/jjgg_${code}_3.html` },
    'utf-8',
  );
  const listPayload = parseJsonpPayload(listResponse);
  const reports = (listPayload?.Data ?? []).filter((item) => /季度报告/.test(item?.TITLE ?? ''));
  if (!reports.length) {
    return null;
  }

  const quoteByTicker = await fetchSupplementalHoldingQuoteMap(aliases);

  for (const report of reports) {
    const artCode = report?.ID;
    if (!artCode) {
      continue;
    }

    try {
      const contentResponse = await fetchText(
        `https://np-cnotice-fund.eastmoney.com/api/content/ann?client_source=web_fund&show_all=1&art_code=${artCode}`,
        { referer: `https://fund.eastmoney.com/gonggao/${code},${artCode}.html` },
        'utf-8',
      );
      const contentPayload = JSON.parse(contentResponse);
      const parsed = parseNoticeHoldingsDisclosure(code, {
        noticeTitle: report.TITLE,
        noticeContent: contentPayload?.data?.notice_content ?? '',
        aliases,
        quoteByTicker,
      });
      if (parsed.disclosedHoldings.length) {
        return parsed;
      }
    } catch {
      continue;
    }
  }

  return null;
}

async function fetchOverseasHoldingQuoteMap(tickers) {
  const usTickers = [...new Set(tickers.map((item) => item.toUpperCase()).filter(isUsHoldingTicker))];
  if (!usTickers.length) {
    return new Map();
  }

  const response = await fetchText(`https://qt.gtimg.cn/q=${usTickers.map((ticker) => `us${ticker}`).join(',')}`, { referer: 'https://gu.qq.com/' }, 'gb18030');
  return new Map(
    parseUsQuotes(response)
      .filter((item) => item?.ticker)
      .map((item) => [
        item.ticker.toUpperCase(),
        {
          currentPrice: item.currentPrice,
          changeRate: item.previousClose > 0 ? item.currentPrice / item.previousClose - 1 : 0,
        },
      ]),
  );
}

function extractHoldingSecids(html) {
  const $ = load(html);
  const table = $('table').filter((_, element) => {
    const rows = $(element).find('tr');
    if (!rows.length) {
      return false;
    }

    return rows
      .toArray()
      .some((row) => {
        const cells = $(row)
          .find('td')
          .map((__, cell) => $(cell).text().replace(/\s+/g, ' ').trim())
          .get()
          .filter(Boolean);

        return cells.length >= 6 && /^\d+$/.test(cells[0]) && isHoldingTicker(cells[1]);
      });
  }).first();

  return table
    .find('tbody tr')
    .map((_, row) => {
      const cells = $(row)
        .find('td')
        .map((__, cell) => $(cell).text().replace(/\s+/g, ' ').trim())
        .get()
        .filter(Boolean);

      if (cells.length < 7 || !/^\d+$/.test(cells[0]) || !isHoldingTicker(cells[1])) {
        return null;
      }

      const href = $(row).find('td').eq(1).find('a').attr('href') ?? '';
      const secidMatch = href.match(/unify\/r\/([0-9.]+)/i);
      if (!secidMatch) {
        return null;
      }

      return {
        ticker: cells[1].toUpperCase(),
        secid: secidMatch[1],
      };
    })
    .get()
    .filter(Boolean)
    .slice(0, 10);
}

async function fetchHoldingQuoteMap(secidEntries) {
  if (!secidEntries.length) {
    return new Map();
  }

  const secids = [...new Set(secidEntries.map((item) => item.secid))].join(',');
  const response = await fetchText(
    `https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&fields=f2,f3,f12,f14,f9&ut=267f9ad526dbe6b0262ab19316f5a25b&secids=${secids}`,
    { referer: 'https://fundf10.eastmoney.com/' },
    'utf-8',
  );
  const payload = JSON.parse(response);

  return new Map(
    (payload.data?.diff ?? [])
      .filter((item) => item?.f12)
      .map((item) => [
        String(item.f12).toUpperCase(),
        {
          currentPrice: Number(item.f2) || 0,
          changeRate: Number(item.f3) / 100 || 0,
        },
      ]),
  );
}

async function fetchHoldingsDisclosure(code) {
  const supplementalDisclosure = await fetchNoticeHoldingsDisclosure(code).catch(() => null);
  if (supplementalDisclosure?.disclosedHoldings.length) {
    return supplementalDisclosure;
  }

  const yearsToTry = Array.from({ length: 4 }, (_, index) => now.getFullYear() - index);

  for (const year of yearsToTry) {
    try {
      const response = await fetchText(
        `https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc&code=${code}&topline=10&year=${year}&month=&rt=${Date.now()}`,
        { referer: `https://fundf10.eastmoney.com/ccmx_${code}.html` },
        'utf-8',
      );
      const payload = parseFundArchivesPayload(response);
      if (!payload?.content) {
        continue;
      }

      const secidEntries = extractHoldingSecids(payload.content);
      const quoteByTicker = await fetchHoldingQuoteMap(secidEntries);
      const parsed = parseHoldingsDisclosure(payload.content, quoteByTicker);
      const missingTickers = parsed.disclosedHoldings
        .filter((item) => item?.ticker && (!Number.isFinite(item.currentPrice) || item.currentPrice <= 0))
        .map((item) => item.ticker);
      const overseasQuoteByTicker = missingTickers.length ? await fetchOverseasHoldingQuoteMap(missingTickers) : new Map();
      const patched = overseasQuoteByTicker.size
        ? {
            ...parsed,
            disclosedHoldings: parsed.disclosedHoldings.map((item) => {
              const quote = overseasQuoteByTicker.get(item.ticker.toUpperCase());
              return quote
                ? {
                    ...item,
                    currentPrice: quote.currentPrice,
                    changeRate: quote.changeRate,
                  }
                : item;
            }),
          }
        : parsed;
      if (patched.disclosedHoldings.length) {
        return patched;
      }
    } catch {
      continue;
    }
  }

  return {
    disclosedHoldingsTitle: '',
    disclosedHoldingsReportDate: '',
    disclosedHoldings: [],
  };
}

function getHoldingCurrency(ticker) {
  if (isUsHoldingTicker(ticker)) {
    return 'USD';
  }

  return /^0\d{4}$/.test(ticker) ? 'HKD' : 'CNY';
}

function buildHoldingQuotes(runtime) {
  if (runtime.code === '161128') {
    return {
      holdingQuotes: runtime.holdingQuotes ?? [],
      holdingsQuoteDate: runtime.holdingsQuoteDate || '',
      holdingsQuoteTime: runtime.holdingsQuoteTime || '',
    };
  }

  const holdingQuotes = (runtime.disclosedHoldings ?? [])
    .map((item) => {
      if (!item.ticker || !Number.isFinite(item.currentPrice) || item.currentPrice <= 0 || !Number.isFinite(item.changeRate)) {
        return null;
      }

      const previousClose = item.currentPrice / (1 + item.changeRate);
      if (!Number.isFinite(previousClose) || previousClose <= 0) {
        return null;
      }

      return {
        ticker: item.ticker,
        name: item.name,
        currentPrice: item.currentPrice,
        previousClose,
        quoteDate: runtime.marketDate || today,
        quoteTime: runtime.marketTime || '',
        currency: getHoldingCurrency(item.ticker),
      };
    })
    .filter(Boolean);

  return {
    holdingQuotes,
    holdingsQuoteDate: holdingQuotes.length ? runtime.marketDate || today : '',
    holdingsQuoteTime: holdingQuotes.length ? runtime.marketTime || '' : '',
  };
}

function updateDisclosureHistory(historyByCode, runtime) {
  const sanitizedRuntimeDisclosure = sanitizeDisclosureForFund(runtime.code, {
    disclosedHoldingsTitle: runtime.disclosedHoldingsTitle,
    disclosedHoldingsReportDate: runtime.disclosedHoldingsReportDate,
    disclosedHoldings: runtime.disclosedHoldings,
  });

  if (!sanitizedRuntimeDisclosure.disclosedHoldings.length || !sanitizedRuntimeDisclosure.disclosedHoldingsReportDate) {
    return historyByCode;
  }

  const current = historyByCode[runtime.code] ?? [];
  const nextEntry = {
    reportDate: sanitizedRuntimeDisclosure.disclosedHoldingsReportDate,
    title: sanitizedRuntimeDisclosure.disclosedHoldingsTitle,
    holdings: sanitizedRuntimeDisclosure.disclosedHoldings,
    capturedAt: new Date().toISOString(),
  };

  return {
    ...historyByCode,
    [runtime.code]: [
      ...current.filter(
        (item) => item.reportDate !== sanitizedRuntimeDisclosure.disclosedHoldingsReportDate || item.title !== sanitizedRuntimeDisclosure.disclosedHoldingsTitle,
      ),
      nextEntry,
    ].sort((left, right) => left.reportDate.localeCompare(right.reportDate)).slice(-8),
  };
}

function normalizeDisclosureEntry(disclosure) {
  return {
    disclosedHoldingsTitle: disclosure?.disclosedHoldingsTitle ?? disclosure?.title ?? '',
    disclosedHoldingsReportDate: disclosure?.disclosedHoldingsReportDate ?? disclosure?.reportDate ?? '',
    disclosedHoldings: disclosure?.disclosedHoldings ?? disclosure?.holdings ?? [],
  };
}

function sanitizeDisclosureForFund(code, disclosure) {
  const normalized = normalizeDisclosureEntry(disclosure);

  if (code === '161129') {
    const invalidTickers = new Set(['159995', '512760', '159560']);
    const disclosedTickers = normalized.disclosedHoldings
      .map((item) => String(item?.ticker ?? '').toUpperCase())
      .filter(Boolean);

    if (disclosedTickers.length && disclosedTickers.every((ticker) => invalidTickers.has(ticker))) {
      return normalizeDisclosureEntry(null);
    }
  }

  return normalized;
}

function sanitizeDisclosureHistory(historyByCode) {
  return Object.fromEntries(
    Object.entries(historyByCode ?? {}).map(([code, entries]) => [
      code,
      (entries ?? [])
        .map((entry) => {
          const sanitized = sanitizeDisclosureForFund(code, entry);
          if (!sanitized.disclosedHoldings.length || !sanitized.disclosedHoldingsReportDate) {
            return null;
          }

          return {
            ...entry,
            reportDate: sanitized.disclosedHoldingsReportDate,
            title: sanitized.disclosedHoldingsTitle,
            holdings: sanitized.disclosedHoldings,
          };
        })
        .filter(Boolean),
    ]).filter(([, entries]) => entries.length),
  );
}

function patchKnownDisclosureGaps(code, disclosure) {
  const normalized = sanitizeDisclosureForFund(code, disclosure);

  if (
    code === '160723'
    && normalized.disclosedHoldingsReportDate === '2025-12-31'
    && !normalized.disclosedHoldings.some((item) => item?.ticker === '1699')
  ) {
    return {
      ...normalized,
      disclosedHoldings: [
        ...normalized.disclosedHoldings,
        {
          ticker: '1699',
          name: 'NEXT FUNDS NOMURA Crude Oil Long Index Linked ETF',
          weight: 14.29,
          marketValue: 65062509.79,
        },
      ].sort((left, right) => (right.weight ?? 0) - (left.weight ?? 0)),
    };
  }

  return normalized;
}

function compareDisclosureFreshness(left, right) {
  const leftDate = left?.disclosedHoldingsReportDate ?? '';
  const rightDate = right?.disclosedHoldingsReportDate ?? '';
  if (leftDate !== rightDate) {
    return leftDate.localeCompare(rightDate);
  }

  const leftQuotedCount = (left?.disclosedHoldings ?? []).filter((item) => Number.isFinite(item?.currentPrice) && item.currentPrice > 0).length;
  const rightQuotedCount = (right?.disclosedHoldings ?? []).filter((item) => Number.isFinite(item?.currentPrice) && item.currentPrice > 0).length;
  if (leftQuotedCount !== rightQuotedCount) {
    return leftQuotedCount - rightQuotedCount;
  }

  return (left?.disclosedHoldings?.length ?? 0) - (right?.disclosedHoldings?.length ?? 0);
}

function pickPreferredDisclosure(primary, fallback) {
  const normalizedPrimary = normalizeDisclosureEntry(primary);
  const normalizedFallback = normalizeDisclosureEntry(fallback);

  if (!(normalizedFallback.disclosedHoldings?.length ?? 0)) {
    return normalizedPrimary;
  }

  if (!(normalizedPrimary.disclosedHoldings?.length ?? 0)) {
    return normalizedFallback;
  }

  return compareDisclosureFreshness(normalizedPrimary, normalizedFallback) >= 0 ? normalizedPrimary : normalizedFallback;
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

function getSupplementalQuoteSymbol(ticker) {
  const normalized = String(ticker || '').toUpperCase();
  if (!normalized) {
    return '';
  }

  if (isUsHoldingTicker(normalized)) {
    return `us${normalized}`;
  }

  if (/^0\d{4}$/.test(normalized)) {
    return `hk${normalized}`;
  }

  if (/^\d{6}$/.test(normalized)) {
    return `${normalized.startsWith('5') || normalized.startsWith('6') ? 'sh' : 'sz'}${normalized}`;
  }

  return '';
}

function parseSupplementalStandardQuoteRow(rawRow) {
  const fields = rawRow.split('~');
  const dateTimeRaw = fields.find((field) => /^\d{14}$/.test(field)) || '';

  return {
    name: fields[1] || '',
    ticker: fields[2] || '',
    currentPrice: Number(fields[3]) || 0,
    previousClose: Number(fields[4]) || 0,
    quoteDate: dateTimeRaw.length >= 8 ? `${dateTimeRaw.slice(0, 4)}-${dateTimeRaw.slice(4, 6)}-${dateTimeRaw.slice(6, 8)}` : '',
    quoteTime: dateTimeRaw.length >= 14 ? `${dateTimeRaw.slice(8, 10)}:${dateTimeRaw.slice(10, 12)}:${dateTimeRaw.slice(12, 14)}` : '',
  };
}

async function fetchSupplementalHoldingQuoteMap(aliasEntries) {
  const normalizedEntries = [...new Map(
    (aliasEntries ?? [])
      .map((item) => {
        const ticker = String(item?.ticker ?? '').toUpperCase();
        const quoteTicker = String(item?.quoteTicker ?? ticker).toUpperCase();
        return ticker ? [ticker, { ticker, quoteTicker }] : null;
      })
      .filter(Boolean),
  ).values()];
  const quoteTickers = [...new Set(normalizedEntries.map((item) => item.quoteTicker).filter(Boolean))];
  const usTickers = quoteTickers.filter(isUsHoldingTicker);
  const nonUsSymbols = [...new Set(quoteTickers.map((item) => getSupplementalQuoteSymbol(item)).filter((item) => item && !item.startsWith('us')))];

  const quoteByTicker = await fetchOverseasHoldingQuoteMap(usTickers);
  if (!nonUsSymbols.length) {
    for (const entry of normalizedEntries) {
      if (entry.quoteTicker !== entry.ticker && quoteByTicker.has(entry.quoteTicker) && !quoteByTicker.has(entry.ticker)) {
        quoteByTicker.set(entry.ticker, quoteByTicker.get(entry.quoteTicker));
      }
    }

    return quoteByTicker;
  }

  const response = await fetchText(`https://qt.gtimg.cn/q=${nonUsSymbols.join(',')}`, { referer: 'https://gu.qq.com/' }, 'gb18030');
  const localQuotes = response
    .split(';')
    .map((row) => row.trim())
    .filter(Boolean)
    .map((row) => {
      const match = row.match(/^v_([a-z]+)([^=]+)="([^"]+)"$/i);
      if (!match) {
        return null;
      }

      const [, , rawTicker, rawPayload] = match;
      const parsed = parseSupplementalStandardQuoteRow(rawPayload);
      return {
        ticker: String(parsed.ticker || rawTicker).toUpperCase(),
        currentPrice: parsed.currentPrice,
        previousClose: parsed.previousClose,
      };
    })
    .filter(Boolean)
    .filter((item) => item.currentPrice > 0 && item.previousClose > 0);

  for (const item of localQuotes) {
    quoteByTicker.set(item.ticker, {
      currentPrice: item.currentPrice,
      changeRate: item.previousClose > 0 ? item.currentPrice / item.previousClose - 1 : 0,
    });
  }

  for (const entry of normalizedEntries) {
    if (entry.quoteTicker !== entry.ticker && quoteByTicker.has(entry.quoteTicker) && !quoteByTicker.has(entry.ticker)) {
      quoteByTicker.set(entry.ticker, quoteByTicker.get(entry.quoteTicker));
    }
  }

  return quoteByTicker;
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

async function getDailyFundData(entry, holdingsHistoryByCode = {}) {
  const cachePath = path.join(dailyCacheDir, `${entry.code}.json`);
  const cached = await readJson(cachePath, null);
  if (cached?.fetchedDate === today && cached?.cacheVersion === DAILY_CACHE_VERSION) {
    return { ...cached, cacheMode: 'daily-cache' };
  }

  const cachedHoldingsDisclosure = cached?.cacheVersion === DAILY_CACHE_VERSION && !shouldRefreshHoldingsDisclosure(cached)
    ? {
        disclosedHoldingsTitle: cached?.disclosedHoldingsTitle ?? '',
        disclosedHoldingsReportDate: cached?.disclosedHoldingsReportDate ?? '',
        disclosedHoldings: cached?.disclosedHoldings ?? [],
      }
    : null;

  const [basicHtml, pingzhongData, fundHtml, holdingsDisclosure, apiPurchaseStatus, portalPurchaseStatus, noticePurchaseStatus] = await Promise.all([
    fetchText(`https://fundf10.eastmoney.com/jbgk_${entry.code}.html`, {}, 'utf-8'),
    fetchText(`https://fund.eastmoney.com/pingzhongdata/${entry.code}.js?v=${Date.now()}`, {
      referer: `https://fund.eastmoney.com/${entry.code}.html`,
    }, 'gb18030'),
    fetchText(`https://fund.eastmoney.com/${entry.code}.html`, {}, 'utf-8'),
    cachedHoldingsDisclosure ? Promise.resolve(cachedHoldingsDisclosure) : fetchHoldingsDisclosure(entry.code),
    fetchPurchaseStatusFromApi(entry.code),
    fetchPurchaseStatusFromPortal(entry.code),
    fetchPurchaseStatusFromNotices(entry.code),
  ]);

  const pingzhong = parsePingzhongData(pingzhongData);
  const basic = parseBasicInfo(basicHtml, pingzhong.name);
  const purchase = mergePurchaseStatus(parsePurchaseStatusFromHtml(fundHtml), apiPurchaseStatus, portalPurchaseStatus, noticePurchaseStatus);
  const normalizedPurchase = entry.pageCategory === 'etf'
    ? {
        purchaseStatus: '场内交易 / 开放赎回',
        purchaseLimit: '不限购',
      }
    : purchase;
  const relatedEtfCode = extractRelatedEtfCode(fundHtml) || RELATED_ETF_FALLBACKS[entry.code] || '';
  const finalHoldingsDisclosure =
    holdingsDisclosure.disclosedHoldings.length || !relatedEtfCode || relatedEtfCode === entry.code
      ? holdingsDisclosure
      : await fetchHoldingsDisclosure(relatedEtfCode);
  const historicalHoldingsDisclosure = (holdingsHistoryByCode[entry.code] ?? []).reduce(
    (best, item) => pickPreferredDisclosure(best, sanitizeDisclosureForFund(entry.code, item)),
    normalizeDisclosureEntry(null),
  );
  const resolvedHoldingsDisclosure = patchKnownDisclosureGaps(
    entry.code,
    pickPreferredDisclosure(finalHoldingsDisclosure, historicalHoldingsDisclosure),
  );
  const latestNav = pingzhong.navHistory[0] ?? { date: '', nav: 0 };
  const payload = {
    cacheVersion: DAILY_CACHE_VERSION,
    fetchedDate: today,
    holdingsFetchedDate: cachedHoldingsDisclosure ? cached?.holdingsFetchedDate ?? cached?.fetchedDate ?? today : today,
    name: basic.name || entry.code,
    fundType: basic.fundType,
    benchmark: basic.benchmark,
    officialNavT1: latestNav.nav,
    navDate: latestNav.date,
    navHistory: pingzhong.navHistory,
    purchaseStatus: normalizedPurchase.purchaseStatus,
    purchaseLimit: normalizedPurchase.purchaseLimit,
    disclosedHoldingsTitle: resolvedHoldingsDisclosure.disclosedHoldingsTitle,
    disclosedHoldingsReportDate: resolvedHoldingsDisclosure.disclosedHoldingsReportDate,
    disclosedHoldings: resolvedHoldingsDisclosure.disclosedHoldings,
  };

  await writeJson(cachePath, payload);
  return { ...payload, cacheMode: 'fresh' };
}

async function loadIntradayData() {
  const cachePath = path.join(intradayCacheDir, `${today}.json`);
  const cached = await readJson(cachePath, { funds: {}, fx: null, holdings161128: [], proxyQuotes: [] });

  try {
    const fundSymbols = catalog.map((item) => getQuoteSymbol(item.code)).join(',');
    const holdingSymbols = HOLDINGS_161128.map((item) => `us${item.ticker}`).join(',');
    const proxySymbols = [...new Set(Object.values(PROXY_BASKETS).flatMap((item) => item.components.map((component) => `us${component.ticker}`)))].join(',');
    const [fundQuotesRaw, fxRaw, holdingsRaw, proxyRaw] = await Promise.all([
      fetchText(`https://qt.gtimg.cn/q=${fundSymbols}`, { referer: 'https://gu.qq.com/' }, 'gb18030'),
      fetchText('https://hq.sinajs.cn/list=USDCNY,fx_susdcny', { referer: 'https://finance.sina.com.cn/' }, 'gb18030'),
      fetchText(`https://qt.gtimg.cn/q=${holdingSymbols}`, { referer: 'https://gu.qq.com/' }, 'gb18030'),
      fetchText(`https://qt.gtimg.cn/q=${proxySymbols}`, { referer: 'https://gu.qq.com/' }, 'gb18030'),
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
      proxyQuotes: parseUsQuotes(proxyRaw).map((item) => ({
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

async function syncFund(entry, holdingsHistoryByCode = {}) {
  const [dailyData, intradayData] = await Promise.all([getDailyFundData(entry, holdingsHistoryByCode), getIntradayData()]);
  const quote = intradayData.funds?.[entry.code] ?? {
    marketPrice: 0,
    previousClose: 0,
    marketDate: '',
    marketTime: '',
    marketSource: '腾讯行情',
  };
  const proxyConfig = entry.proxyBasketKey ? PROXY_BASKETS[entry.proxyBasketKey] : null;
  const proxyQuotes = proxyConfig
    ? proxyConfig.components
        .map((component) => {
          const matched = (intradayData.proxyQuotes ?? []).find((item) => item.ticker.toUpperCase() === component.ticker.toUpperCase());
          if (!matched) {
            return null;
          }

          return {
            ...matched,
            name: component.name,
            weight: component.weight,
          };
        })
        .filter(Boolean)
    : [];
  const proxyMeta = proxyQuotes[0] ?? null;
  const holdingQuotePayload = buildHoldingQuotes({
    code: entry.code,
    disclosedHoldings: dailyData.disclosedHoldings,
    marketDate: quote.marketDate,
    marketTime: quote.marketTime,
    holdingQuotes: entry.code === '161128' ? intradayData.holdings161128 ?? [] : [],
    holdingsQuoteDate: (intradayData.holdings161128 ?? [])[0]?.quoteDate || '',
    holdingsQuoteTime: (intradayData.holdings161128 ?? [])[0]?.quoteTime || '',
  });

  return {
    code: entry.code,
    priority: entry.priority,
    detailMode: entry.detailMode,
    pageCategory: entry.pageCategory,
    estimateMode: entry.estimateMode,
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
    disclosedHoldingsTitle: dailyData.disclosedHoldingsTitle,
    disclosedHoldingsReportDate: dailyData.disclosedHoldingsReportDate,
    disclosedHoldings: dailyData.disclosedHoldings,
    fx: intradayData.fx,
    holdingQuotes: holdingQuotePayload.holdingQuotes,
    holdingsQuoteDate: holdingQuotePayload.holdingsQuoteDate,
    holdingsQuoteTime: holdingQuotePayload.holdingsQuoteTime,
    proxyBasketName: proxyConfig?.name || '',
    proxyQuotes,
    proxyQuoteDate: proxyMeta?.quoteDate || '',
    proxyQuoteTime: proxyMeta?.quoteTime || '',
    cacheMode: intradayData.cacheMode === 'intraday-cache' ? 'intraday-cache' : dailyData.cacheMode,
  };
}

async function main() {
  await fs.mkdir(dailyCacheDir, { recursive: true });
  await fs.mkdir(intradayCacheDir, { recursive: true });

  const funds = [];
  const rawStateCache = await readJson(watchlistStatePath, {});
  const publishedStateCache = await readPublishedRuntimeState();
  let holdingsHistoryByCode = sanitizeDisclosureHistory(await readJson(holdingsDisclosurePath, {}));
  const persistedStateByCode = mergePersistedState(rawStateCache, publishedStateCache);
  const stateByCode = {};

  for (const entry of catalog) {
    try {
      const runtime = await syncFund(entry, holdingsHistoryByCode);
      const currentState = normalizePersistedState(persistedStateByCode[entry.code]);
      const reconciled = reconcileJournal(runtime, currentState.model, currentState.journal);
      const estimate = estimateWatchlistFund(runtime, reconciled.model);
      const journal = recordEstimateSnapshot(reconciled.journal, runtime, estimate);

      funds.push(runtime);
      holdingsHistoryByCode = updateDisclosureHistory(holdingsHistoryByCode, runtime);
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

  if (funds.length === 0) {
    throw new Error('Sync produced 0 funds. Aborting publish to avoid overwriting the site with an empty runtime payload.');
  }

  await writeJson(watchlistStatePath, {
    __meta: {
      version: WATCHLIST_STATE_VERSION,
      updatedAt: new Date().toISOString(),
    },
    ...stateByCode,
  });

  await writeJson(holdingsDisclosurePath, holdingsHistoryByCode);

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
