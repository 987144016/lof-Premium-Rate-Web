import React, { useEffect, useMemo, useState } from 'react';
import { Link, Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { FundTable } from './components/FundTable';
import { LineChart } from './components/LineChart';
import { MetricCard } from './components/MetricCard';
import { readDetailScrollY, readFavoriteFundCodes, readFundJournal, readFundOrder, readWatchlistModel, writeDetailScrollY, writeFavoriteFundCodes, writeFundJournal, writeFundOrder, writeWatchlistModel } from './lib/storage';
import { estimateWatchlistFund, getDefaultWatchlistModel, reconcileJournal, recordEstimateSnapshot } from './lib/watchlist';
import type { FundJournal, FundRuntimeData, FundViewModel, GithubTrafficPayload, RuntimePayload, WatchlistModel } from './types';
const FAST_SYNC_INTERVAL = 60_000;
const SLOW_SYNC_INTERVAL = 15 * 60_000;
type ViewCategory = 'qdii-lof' | 'domestic-lof' | 'qdii-etf' | 'domestic-etf' | 'favorites';

const PAGE_OPTIONS: Array<{ key: ViewCategory; path: string; label: string; lead: string; tableTitle: string; tableDescription: string }> = [
  {
    key: 'qdii-lof',
    path: '/qdii-lof',
    label: '跨境 LOF',
    lead: 'QDII 官方净值通常会慢一个到两个交易日，具体以净值日期列为准。本页默认优先按可获取的前十大持仓推算净值，持仓覆盖不足部分再由海外代理篮子补齐，并叠加 USD/CNY 与误差修正项。',
    tableTitle: 'QDII LOF 列表',
    tableDescription: '本页默认按“前十大持仓优先 + 代理篮子补足 + 汇率/修正因子”估值；若暂时拿不到持仓报价，则自动回退到代理篮子。点击表头可排序。',
  },
  {
    key: 'domestic-lof',
    path: '/domestic-lof',
    label: '国内 LOF',
    lead: '这一页放国内 LOF 和联接 LOF。默认优先按前十大持仓推算当日净值，持仓覆盖不足时由代理篮子补齐；若无法取得持仓报价，则回退到代理或场内信号。',
    tableTitle: '国内 LOF 列表',
    tableDescription: '国内 LOF 当前口径是：前十大持仓优先、代理篮子补足、修正因子校准；持仓不可用时回退到代理或场内信号。点击表头可排序。',
  },
  {
    key: 'qdii-etf',
    path: '/qdii-etf',
    label: '跨境 ETF',
    lead: '这一页放跨境 QDII ETF。默认采用“前十大持仓优先 + 代理篮子补足 + 汇率/修正因子”口径，场内价格主要用于展示溢价率。',
    tableTitle: 'QDII ETF 列表',
    tableDescription: 'QDII ETF 页估值口径与 QDII LOF 一致：前十大持仓优先、代理篮子补足、汇率和修正因子联合驱动。点击表头可排序。',
  },
  {
    key: 'domestic-etf',
    path: '/domestic-etf',
    label: '国内ETF',
    lead: '这一页放国内 ETF。默认优先按持仓推算净值，持仓覆盖不足时由代理篮子或场内信号补足。',
    tableTitle: '国内 ETF 列表',
    tableDescription: '国内 ETF 当前口径是：前十大持仓优先、代理篮子补足、修正因子校准；持仓不可用时回退到代理或场内信号。点击表头可排序。',
  },
  {
    key: 'favorites',
    path: '/favorites',
    label: '我的收藏',
    lead: '这里汇总你收藏的所有基金，跨 QDII/国内、LOF/ETF 统一展示，字段和交互与主列表完全一致。',
    tableTitle: '我的收藏列表',
    tableDescription: '收藏页与主列表同款：同列、同排序、同收藏星标、同拖拽调整。',
  },
];

const HOLDINGS_SIGNAL_MIN_COVERAGE_BY_CODE: Record<string, number> = {
  '513310': 0.55,
  '161128': 0.65,
};

function getZonedClock(date: Date, timeZone: string) {
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

function isWeekday(weekday: string) {
  return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(weekday);
}

function isCnTradingSession(date: Date) {
  const clock = getZonedClock(date, 'Asia/Shanghai');
  if (!isWeekday(clock.weekday)) {
    return false;
  }

  return (clock.minutes >= 9 * 60 + 30 && clock.minutes < 11 * 60 + 30) || (clock.minutes >= 13 * 60 && clock.minutes < 15 * 60);
}

function isUsTradingSession(date: Date) {
  const clock = getZonedClock(date, 'America/New_York');
  if (!isWeekday(clock.weekday)) {
    return false;
  }

  return clock.minutes >= 9 * 60 + 30 && clock.minutes < 16 * 60;
}

function getRuntimeRefreshInterval(now = new Date()) {
  return isCnTradingSession(now) || isUsTradingSession(now) ? FAST_SYNC_INTERVAL : SLOW_SYNC_INTERVAL;
}

function formatCurrency(value: number): string {
  return value.toFixed(4);
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function formatBps(value: number): string {
  return `${(value * 10000).toFixed(1)} bp`;
}

function getMarketChangeRate(runtime: FundRuntimeData): number {
  return runtime.previousClose > 0 ? runtime.marketPrice / runtime.previousClose - 1 : 0;
}

function formatOptionalCurrency(value?: number): string {
  return typeof value === 'number' && Number.isFinite(value) ? formatCurrency(value) : '--';
}

function formatOptionalChangeRate(value?: number): string {
  return typeof value === 'number' && Number.isFinite(value) ? formatPercent(value) : '--';
}

function formatHoldingWeight(value?: number): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(2)}%` : '--';
}

function normalizeWatchlistModel(input: Partial<WatchlistModel> | undefined): WatchlistModel {
  const fallback = getDefaultWatchlistModel();
  const source = input ?? {};
  const pickNumber = (value: unknown, fallbackValue: number) => (typeof value === 'number' && Number.isFinite(value) ? value : fallbackValue);

  return {
    alpha: pickNumber(source.alpha, fallback.alpha),
    betaLead: pickNumber(source.betaLead, fallback.betaLead),
    betaGap: pickNumber(source.betaGap, fallback.betaGap),
    learningRate: pickNumber(source.learningRate, fallback.learningRate),
    sampleCount: pickNumber(source.sampleCount, fallback.sampleCount),
    meanAbsError: pickNumber(source.meanAbsError, fallback.meanAbsError),
    lastUpdatedAt: typeof source.lastUpdatedAt === 'string' ? source.lastUpdatedAt : undefined,
  };
}

function normalizeFundJournal(input: Partial<FundJournal> | undefined): FundJournal {
  return {
    snapshots: Array.isArray(input?.snapshots) ? input.snapshots : [],
    errors: Array.isArray(input?.errors) ? input.errors : [],
  };
}

function formatDateTime(value: string): string {
  if (!value) {
    return '--';
  }

  return new Date(value).toLocaleString();
}

function formatRuntimeTime(date: string, time: string): string {
  const merged = `${date || '--'} ${time || ''}`.trim();
  return merged || '--';
}

function getDefaultGithubTrafficPayload(): GithubTrafficPayload {
  return {
    generatedAt: '',
    source: 'github-traffic-api',
    repo: '',
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
    snapshots: [],
  };
}

function getHoursSinceSync(syncedAt: string): number | null {
  if (!syncedAt) {
    return null;
  }

  const syncedAtMs = new Date(syncedAt).getTime();
  if (!Number.isFinite(syncedAtMs)) {
    return null;
  }

  return Math.max(0, (Date.now() - syncedAtMs) / (1000 * 60 * 60));
}

function getPageOption(pageCategory: ViewCategory) {
  return PAGE_OPTIONS.find((item) => item.key === pageCategory) ?? PAGE_OPTIONS[0];
}

function isQdiiEtfFund(fund: FundViewModel) {
  if (fund.runtime.pageCategory !== 'etf') {
    return false;
  }

  const text = `${fund.runtime.name || ''} ${fund.runtime.benchmark || ''} ${fund.runtime.fundType || ''}`;
  return /QDII|纳斯达克|标普|道琼斯|日经|TOPIX|德国|巴西|沙特|东南亚|全球|美国|港美|油气|生物科技/i.test(text);
}

function hasAnnouncedHoldingsSignal(runtime: FundRuntimeData) {
  const disclosedHoldings = runtime.disclosedHoldings ?? [];
  const requiredCount = Math.min(10, disclosedHoldings.length);
  if (requiredCount <= 0) {
    return false;
  }

  const quotedTickers = new Set(
    (runtime.holdingQuotes ?? [])
      .filter((item) => Number.isFinite(item.currentPrice) && item.currentPrice > 0 && Number.isFinite(item.previousClose) && item.previousClose > 0)
      .map((item) => item.ticker.toUpperCase()),
  );

  const coveredCount = disclosedHoldings
    .slice(0, requiredCount)
    .filter((item) => quotedTickers.has(String(item.ticker || '').toUpperCase())).length;
  const strictCoverage = coveredCount >= requiredCount;
  if (strictCoverage) {
    return true;
  }

  const minCoverage = HOLDINGS_SIGNAL_MIN_COVERAGE_BY_CODE[runtime.code];
  if (!Number.isFinite(minCoverage)) {
    return false;
  }

  return coveredCount >= Math.min(3, requiredCount) && getAnnouncedHoldingsCoveragePercent(runtime) / 100 >= minCoverage;
}

function getAnnouncedHoldingsCoveragePercent(runtime: FundRuntimeData) {
  const disclosedHoldings = runtime.disclosedHoldings ?? [];
  if (!disclosedHoldings.length) {
    return 0;
  }

  const quotedTickers = new Set(
    (runtime.holdingQuotes ?? [])
      .filter((item) => Number.isFinite(item.currentPrice) && item.currentPrice > 0 && Number.isFinite(item.previousClose) && item.previousClose > 0)
      .map((item) => item.ticker.toUpperCase()),
  );

  const requiredHoldings = disclosedHoldings.slice(0, Math.min(10, disclosedHoldings.length));
  const coveredWeight = requiredHoldings.reduce((sum, item) => {
    if (!quotedTickers.has(String(item.ticker || '').toUpperCase())) {
      return sum;
    }

    return sum + Math.max(0, Number(item.weight) || 0);
  }, 0);

  return Math.max(0, Math.min(100, coveredWeight));
}

function getTop10DisclosedWeightPercent(runtime: FundRuntimeData) {
  const disclosedHoldings = runtime.disclosedHoldings ?? [];
  if (!disclosedHoldings.length) {
    return 0;
  }

  return disclosedHoldings
    .slice(0, 10)
    .reduce((sum, item) => sum + Math.max(0, Number(item.weight) || 0), 0);
}

class AppErrorBoundary extends React.Component<React.PropsWithChildren, { hasError: boolean }> {
  constructor(props: React.PropsWithChildren) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      return (
        <main className="page">
          <section className="panel notice-panel">
            详情页渲染失败。通常是浏览器还缓存着旧页面资源，先强制刷新一次；如果仍然异常，再稍后重试。
          </section>
        </main>
      );
    }

    return this.props.children;
  }
}

function getEstimateDriverLabels(runtime: FundRuntimeData) {
  return hasAnnouncedHoldingsSignal(runtime)
    ? {
        summary: `该基金当前按公告披露持仓（最多前十条）估值；披露权重覆盖约 ${getAnnouncedHoldingsCoveragePercent(runtime).toFixed(2)}% 时，剩余仓位用代理篮子补足，海外资产同步计入 USD/CNY 变化。`,
        primaryFactor: '公告持仓涨跌幅（主）+ 代理篮子（补）',
        secondaryFactor: runtime.pageCategory === 'qdii-lof' ? 'USD/CNY 变化' : '学习修正项',
      }
    : runtime.estimateMode === 'proxy'
    ? {
        summary: `该基金当前按 ${runtime.proxyBasketName || '代理篮子'} + USD/CNY 推算净值，场内价格只用于计算溢价率。`,
        primaryFactor: '代理篮子涨跌幅',
        secondaryFactor: 'USD/CNY 变化',
      }
    : {
        summary: '该基金当前按最近官方净值锚点、场内日内涨跌幅和误差历史做盘中指示估值。',
        primaryFactor: '场内涨跌幅',
        secondaryFactor: '昨收相对净值偏离',
      };
}

interface AlgoVariant {
  key: string;
  label: string;
  alpha: number;
  betaLead: number;
  betaGap: number;
}

interface AlgoScore {
  variant: AlgoVariant;
  sampleCount: number;
  maeAll: number;
  mae30: number;
  maeRecent: number;
  estimatedNav: number;
  premiumRate: number;
}

interface FeatureRow {
  date: string;
  anchorNav: number;
  actualNav: number;
  leadReturn: number;
  closeGapReturn: number;
  targetReturn: number;
}

interface ResearchPoint {
  date: string;
  actualNav: number;
  predictedNav: number;
  absError: number;
}

interface ResearchCandidate {
  key: string;
  label: string;
  mode: 'path-adjust' | 'time-series';
  trainPoints: ResearchPoint[];
  validationPoints: ResearchPoint[];
  maeTrain: number;
  maeValidation: number;
  maeValidation30: number;
}

interface VolatilityBucketStat {
  label: string;
  count: number;
  mae: number;
  avgVol: number;
}

interface VolatilityDiagnostics {
  trainRange: string;
  validationRange: string;
  train: VolatilityBucketStat[];
  validation: VolatilityBucketStat[];
  summary: string;
}

interface OfflineResearchSummary {
  code: string;
  generatedAt: string;
  splitMode: string;
  method?: string;
  explanation?: string;
  fallbackMode?: string;
  disclosureCount: number;
  usedQuoteTickers?: string[];
  avgHoldingCoverage?: number;
  trainRange: string;
  validationRange: string;
  segmented: {
    maeTrain: number;
    maeValidation: number;
    maeValidation30: number;
    maeValidation30Robust?: number;
    maeValidationWeighted?: number;
    maeValidation30Weighted?: number;
  };
  dualObjective: {
    mode: string;
    lambda: number;
    maeValidation: number;
    maeValidation30: number;
    premiumProxyValidation?: number;
  };
  chartPath: string;
  notes: string;
}

interface TrainingMetricSummary {
  maeTrain: number;
  maeValidation: number;
  maeValidation30: number;
  maeValidation30Robust?: number;
  generatedAt: string;
}

interface PremiumCompareProviderRow {
  provider: string;
  sourceUrl: string;
  status: string;
  premiumRateCurrent?: number | null;
  hitCount60?: number;
  avgAbsProviderError30: number | null;
  avgAbsOurError30: number | null;
  avgAbsDelta30: number | null;
  settledCount30?: number;
  settledWindowSize?: number;
  sampleCount30: number;
}

interface PremiumCompareProviderDailyRow {
  date: string;
  time: string;
  marketPrice: number | null;
  providerPremiumRate: number;
  ourReportedPremiumRate: number | null;
  status: 'settled' | 'pending';
  actualPremiumRate: number | null;
  providerPremiumError: number | null;
  ourPremiumError: number | null;
  premiumErrorDelta: number | null;
}

interface PremiumCompareEastmoneyRow {
  date: string;
  time: string;
  marketPrice: number;
  providerPremiumRate: number;
  providerEstimatedNav: number | null;
  status: 'settled' | 'pending';
  actualNav: number | null;
  providerNavError: number | null;
  ourReportedPremiumRate: number | null;
  ourEstimatedNav: number | null;
  ourNavError: number | null;
}

interface PremiumCompareCodePayload {
  code: string;
  name: string;
  snapshotAt: string;
  ourPremiumRate: number | null;
  ourPremiumSummary?: {
    settledCount30: number;
    settledWindowSize: number;
    avgAbsOurError30: number | null;
  };
  eastmoneyDailyValuations?: PremiumCompareEastmoneyRow[];
  providerDailyComparisons?: Record<string, PremiumCompareProviderDailyRow[]>;
  providers: PremiumCompareProviderRow[];
}

interface PremiumComparePayload {
  generatedAt: string;
  syncedAt: string;
  codes: Record<string, PremiumCompareCodePayload>;
}

const OFFLINE_RESEARCH_CODES = new Set(['160216', '160723', '161725', '501018', '161129', '160719', '161116', '164701', '501225', '513310', '161130', '160416', '162719', '162411', '161125', '161126', '161127', '162415', '159329', '513080', '520830', '513730', '164824', '160644', '159100', '520870', '160620', '161217', '161124', '501300', '160140', '520580', '159509', '501312', '501011', '501050', '160221', '165520', '167301', '161226', '161128', '513800', '513880', '513520', '513100', '513500', '159502', '513290', '159561', '513030', '513850', '513300', '159518', '163208', '159577', '513400', '159985']);
const PREMIUM_COMPARE_DETAIL_CODES = new Set(['160723', '501018', '161129', '160416', '501225', '162719', '161128', '161125', '163208', '161126', '162411', '161130', '162415', '161116', '501312', '160719', '164701']);
const PREMIUM_PROVIDER_LABELS: Record<string, string> = {
  'eastmoney-fundgz': '东方财富 fundgz',
  'eastmoney-quote': '东方财富行情',
  etfpro: 'ETFPRO',
  sina: '新浪',
  xueqiu: '雪球',
  'manual-jiuquaner': '韭圈儿(手工)',
  'manual-xueqiu': '雪球(手工)',
  'manual-sina-finance': '新浪财经(手工)',
  'manual-huatai': '华泰(手工)',
  'manual-huabao': '华宝(手工)',
  'manual-xiaobeiyangji': '小倍养基(手工)',
};

function getPremiumProviderLabel(provider: string) {
  const key = String(provider || '').trim();
  if (PREMIUM_PROVIDER_LABELS[key]) {
    return PREMIUM_PROVIDER_LABELS[key];
  }
  if (key.startsWith('manual-')) {
    return `${key.replace('manual-', '')}(手工)`;
  }
  return key || '未知来源';
}

function getEstimatedNavFromPremium(marketPrice: number | null | undefined, premiumRate: number | null | undefined): number | null {
  if (typeof marketPrice !== 'number' || !Number.isFinite(marketPrice) || marketPrice <= 0) {
    return null;
  }
  if (typeof premiumRate !== 'number' || !Number.isFinite(premiumRate)) {
    return null;
  }

  const denominator = 1 + premiumRate;
  if (!Number.isFinite(denominator) || Math.abs(denominator) < 1e-9) {
    return null;
  }

  const estimatedNav = marketPrice / denominator;
  return Number.isFinite(estimatedNav) ? estimatedNav : null;
}

function getPointsDateRange(points: ResearchPoint[]) {
  if (!points.length) {
    return '-- ~ --';
  }

  return `${points[0].date} ~ ${points[points.length - 1].date}`;
}

function formatDateRange<T extends { date: string }>(rows: T[]) {
  if (!rows.length) {
    return '-- ~ --';
  }

  return `${rows[0].date} ~ ${rows[rows.length - 1].date}`;
}

function average(values: number[]) {
  if (!values.length) {
    return Number.NaN;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function solveLinearSystem(matrix: number[][], vector: number[]): number[] | null {
  const n = matrix.length;
  if (!n || vector.length !== n) {
    return null;
  }

  const a = matrix.map((row, rowIndex) => [...row, vector[rowIndex]]);

  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) {
      if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) {
        pivot = row;
      }
    }

    if (Math.abs(a[pivot][col]) < 1e-12) {
      return null;
    }

    [a[col], a[pivot]] = [a[pivot], a[col]];
    const pivotValue = a[col][col];
    for (let j = col; j <= n; j += 1) {
      a[col][j] /= pivotValue;
    }

    for (let row = 0; row < n; row += 1) {
      if (row === col) {
        continue;
      }

      const factor = a[row][col];
      if (Math.abs(factor) < 1e-12) {
        continue;
      }

      for (let j = col; j <= n; j += 1) {
        a[row][j] -= factor * a[col][j];
      }
    }
  }

  return a.map((row) => row[n]);
}

function fitLinearWeights(features: number[][], targets: number[], ridge = 0): number[] | null {
  if (!features.length || features.length !== targets.length) {
    return null;
  }

  const dim = features[0].length;
  const xtx = Array.from({ length: dim }, () => Array(dim).fill(0));
  const xty = Array(dim).fill(0);

  for (let i = 0; i < features.length; i += 1) {
    const x = features[i];
    const y = targets[i];
    for (let r = 0; r < dim; r += 1) {
      xty[r] += x[r] * y;
      for (let c = 0; c < dim; c += 1) {
        xtx[r][c] += x[r] * x[c];
      }
    }
  }

  for (let i = 0; i < dim; i += 1) {
    xtx[i][i] += ridge;
  }

  return solveLinearSystem(xtx, xty);
}

function fitHuberIrls(features: number[][], targets: number[], delta: number, ridge = 0.6, iterations = 6): number[] | null {
  if (!features.length || features.length !== targets.length) {
    return null;
  }

  const dim = features[0].length;
  let weights = fitLinearWeights(features, targets, ridge) ?? Array(dim).fill(0);

  for (let iter = 0; iter < iterations; iter += 1) {
    const weightedFeatures: number[][] = [];
    const weightedTargets: number[] = [];

    for (let i = 0; i < features.length; i += 1) {
      const x = features[i];
      const y = targets[i];
      const prediction = x.reduce((sum, value, index) => sum + value * (weights[index] ?? 0), 0);
      const residual = y - prediction;
      const absResidual = Math.abs(residual);
      const robustWeight = absResidual <= delta ? 1 : delta / Math.max(absResidual, 1e-6);
      const scale = Math.sqrt(robustWeight);

      weightedFeatures.push(x.map((value) => value * scale));
      weightedTargets.push(y * scale);
    }

    const next = fitLinearWeights(weightedFeatures, weightedTargets, ridge);
    if (!next) {
      break;
    }

    weights = next;
  }

  return weights;
}

function buildFeatureRows(fund: FundViewModel): FeatureRow[] {
  const snapshotsByDate = new Map(fund.journal.snapshots.map((item) => [item.estimateDate, item]));
  return fund.journal.errors
    .map((errorPoint) => {
      const snapshot = snapshotsByDate.get(errorPoint.date);
      if (!snapshot || snapshot.anchorNav <= 0 || errorPoint.actualNav <= 0) {
        return null;
      }

      return {
        date: errorPoint.date,
        anchorNav: snapshot.anchorNav,
        actualNav: errorPoint.actualNav,
        leadReturn: snapshot.leadReturn,
        closeGapReturn: snapshot.closeGapReturn,
        targetReturn: errorPoint.actualNav / snapshot.anchorNav - 1,
      };
    })
    .filter((item): item is FeatureRow => Boolean(item))
    .sort((left, right) => left.date.localeCompare(right.date));
}

function splitTrainValidationByYear<T extends { date: string }>(rows: T[]): { train: T[]; validation: T[] } {
  const train = rows.filter((item) => item.date.startsWith('2025-'));
  const validation = rows.filter((item) => item.date >= '2026-01-01');

  if (train.length && validation.length) {
    return { train, validation };
  }

  const splitIndex = Math.max(1, Math.floor(rows.length * 0.7));
  return {
    train: rows.slice(0, splitIndex),
    validation: rows.slice(splitIndex),
  };
}

function quantile(values: number[], q: number): number {
  if (!values.length) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q)));
  return sorted[index];
}

function buildVolatilityDiagnostics(fund: FundViewModel): VolatilityDiagnostics | null {
  const features = buildFeatureRows(fund);
  if (features.length < 40) {
    return null;
  }

  const errorByDate = new Map(fund.journal.errors.map((item) => [item.date, item.absError]));
  const rows = features
    .map((item) => ({
      date: item.date,
      vol: Math.abs(item.leadReturn) + 0.8 * Math.abs(item.closeGapReturn),
      absError: errorByDate.get(item.date) ?? Number.NaN,
    }))
    .filter((item) => Number.isFinite(item.absError));

  if (rows.length < 20) {
    return null;
  }

  const split = splitTrainValidationByYear(rows);
  const q1 = quantile(split.train.map((item) => item.vol), 0.33);
  const q2 = quantile(split.train.map((item) => item.vol), 0.66);

  const summarize = (dataset: typeof rows): VolatilityBucketStat[] => {
    const buckets = [
      { label: '低波动', rows: dataset.filter((item) => item.vol < q1) },
      { label: '中波动', rows: dataset.filter((item) => item.vol >= q1 && item.vol < q2) },
      { label: '高波动', rows: dataset.filter((item) => item.vol >= q2) },
    ];

    return buckets.map((bucket) => ({
      label: bucket.label,
      count: bucket.rows.length,
      mae: average(bucket.rows.map((item) => item.absError)),
      avgVol: average(bucket.rows.map((item) => item.vol)),
    }));
  };

  const trainStats = summarize(split.train);
  const validationStats = summarize(split.validation);
  const worstValidation = [...validationStats]
    .filter((item) => item.count > 0 && Number.isFinite(item.mae))
    .sort((left, right) => right.mae - left.mae)[0];

  const summary = worstValidation
    ? `验证集误差最高的是${worstValidation.label}区间（MAE ${formatPercent(worstValidation.mae)}，样本 ${worstValidation.count}），建议该区间优先使用“分波动状态/鲁棒”模型。`
    : '样本不足，暂无法形成波动诊断结论。';

  return {
    trainRange: formatDateRange(split.train),
    validationRange: formatDateRange(split.validation),
    train: trainStats,
    validation: validationStats,
    summary,
  };
}

function fitWeightedLinearWeights(features: number[][], targets: number[], sampleWeights: number[], ridge = 0): number[] | null {
  if (!features.length || features.length !== targets.length || sampleWeights.length !== targets.length) {
    return null;
  }

  const dim = features[0].length;
  const xtx = Array.from({ length: dim }, () => Array(dim).fill(0));
  const xty = Array(dim).fill(0);

  for (let i = 0; i < features.length; i += 1) {
    const x = features[i];
    const y = targets[i];
    const w = Math.max(1e-6, sampleWeights[i]);
    for (let r = 0; r < dim; r += 1) {
      xty[r] += w * x[r] * y;
      for (let c = 0; c < dim; c += 1) {
        xtx[r][c] += w * x[r] * x[c];
      }
    }
  }

  for (let i = 0; i < dim; i += 1) {
    xtx[i][i] += ridge;
  }

  return solveLinearSystem(xtx, xty);
}

function fitSgdWeights(rows: FeatureRow[], learningRate: number, epochs: number, clip: number): [number, number, number] {
  const weights: [number, number, number] = [0, 0.38, 0];
  for (let epoch = 0; epoch < epochs; epoch += 1) {
    const rate = learningRate / Math.sqrt(epoch + 1);
    for (const row of rows) {
      const predicted = weights[0] + weights[1] * row.leadReturn + weights[2] * row.closeGapReturn;
      const residual = Math.max(-clip, Math.min(clip, row.targetReturn - predicted));
      weights[0] += rate * residual;
      weights[1] += rate * residual * row.leadReturn;
      weights[2] += rate * residual * row.closeGapReturn;
    }
  }

  return weights;
}

function buildPathAdjustCandidates(fund: FundViewModel): ResearchCandidate[] {
  const rows = buildFeatureRows(fund);
  if (rows.length < 16) {
    return [];
  }

  const { train, validation } = splitTrainValidationByYear(rows);
  const trainFeatures = train.map((item) => [1, item.leadReturn, item.closeGapReturn]);
  const trainTargets = train.map((item) => item.targetReturn);
  const trainRecent = train.slice(-Math.min(90, train.length));
  const trainFeaturesRecent = trainRecent.map((item) => [1, item.leadReturn, item.closeGapReturn]);
  const trainTargetsRecent = trainRecent.map((item) => item.targetReturn);
  const timeDecayWeights = train.map((_, index) => Math.pow(0.985, train.length - 1 - index));

  const trainFeaturesHuber = train.map((item) => [
    1,
    item.leadReturn,
    item.closeGapReturn,
    item.leadReturn * item.closeGapReturn,
    Math.sign(item.leadReturn) * item.leadReturn * item.leadReturn,
  ]);

  const ols = fitLinearWeights(trainFeatures, trainTargets, 0) ?? [0, 0.38, 0];
  const ridge05 = fitLinearWeights(trainFeatures, trainTargets, 0.5) ?? ols;
  const ridge2 = fitLinearWeights(trainFeatures, trainTargets, 2) ?? ols;
  const recent90 = fitLinearWeights(trainFeaturesRecent, trainTargetsRecent, 0.8) ?? ols;
  const ewls = fitWeightedLinearWeights(trainFeatures, trainTargets, timeDecayWeights, 0.6) ?? ols;
  const huberPoly = fitHuberIrls(trainFeaturesHuber, trainTargets, 0.012, 1.1, 8) ?? [0, 0.38, 0, 0, 0];

  const regimeThreshold = quantile(train.map((item) => Math.abs(item.leadReturn) + 0.8 * Math.abs(item.closeGapReturn)), 0.72);
  const calmRows = train.filter((item) => Math.abs(item.leadReturn) + 0.8 * Math.abs(item.closeGapReturn) < regimeThreshold);
  const volatileRows = train.filter((item) => Math.abs(item.leadReturn) + 0.8 * Math.abs(item.closeGapReturn) >= regimeThreshold);
  const calmWeights = fitLinearWeights(
    calmRows.map((item) => [1, item.leadReturn, item.closeGapReturn]),
    calmRows.map((item) => item.targetReturn),
    0.5,
  ) ?? ridge05;
  const volatileWeights = fitHuberIrls(
    volatileRows.map((item) => [1, item.leadReturn, item.closeGapReturn, item.leadReturn * item.closeGapReturn]),
    volatileRows.map((item) => item.targetReturn),
    0.015,
    1.2,
    8,
  ) ?? [ridge2[0], ridge2[1], ridge2[2], 0];

  const predictCalm = (row: FeatureRow) => calmWeights[0] + calmWeights[1] * row.leadReturn + calmWeights[2] * row.closeGapReturn;
  const predictVolatile = (row: FeatureRow) => volatileWeights[0]
    + volatileWeights[1] * row.leadReturn
    + volatileWeights[2] * row.closeGapReturn
    + volatileWeights[3] * row.leadReturn * row.closeGapReturn;

  const sgdStable = fitSgdWeights(train, 0.08, 60, 0.03);
  const sgdAggressive = fitSgdWeights(train, 0.16, 120, 0.06);
  const mainWeights: [number, number, number] = [fund.model.alpha, fund.model.betaLead, fund.model.betaGap];

  const variants: Array<{ key: string; label: string; predict: (row: FeatureRow) => number }> = [
    { key: 'pa-main', label: '路径校正-当前线上模型', predict: (row) => mainWeights[0] + mainWeights[1] * row.leadReturn + mainWeights[2] * row.closeGapReturn },
    { key: 'pa-ols', label: '路径校正-OLS', predict: (row) => ols[0] + ols[1] * row.leadReturn + ols[2] * row.closeGapReturn },
    { key: 'pa-ridge05', label: '路径校正-Ridge(0.5)', predict: (row) => ridge05[0] + ridge05[1] * row.leadReturn + ridge05[2] * row.closeGapReturn },
    { key: 'pa-ridge2', label: '路径校正-Ridge(2.0)', predict: (row) => ridge2[0] + ridge2[1] * row.leadReturn + ridge2[2] * row.closeGapReturn },
    { key: 'pa-ewls', label: '路径校正-EWLS衰减', predict: (row) => ewls[0] + ewls[1] * row.leadReturn + ewls[2] * row.closeGapReturn },
    { key: 'pa-recent90', label: '路径校正-近期滚动90日', predict: (row) => recent90[0] + recent90[1] * row.leadReturn + recent90[2] * row.closeGapReturn },
    {
      key: 'pa-huber-poly',
      label: '路径校正-Huber鲁棒(非线性)',
      predict: (row) => huberPoly[0]
        + huberPoly[1] * row.leadReturn
        + huberPoly[2] * row.closeGapReturn
        + huberPoly[3] * row.leadReturn * row.closeGapReturn
        + huberPoly[4] * Math.sign(row.leadReturn) * row.leadReturn * row.leadReturn,
    },
    {
      key: 'pa-regime-switch',
      label: '路径校正-分波动状态',
      predict: (row) => {
        const vol = Math.abs(row.leadReturn) + 0.8 * Math.abs(row.closeGapReturn);
        if (vol < regimeThreshold) {
          return predictCalm(row);
        }

        return predictVolatile(row);
      },
    },
    {
      key: 'pa-regime-blend',
      label: '路径校正-波动率门控融合',
      predict: (row) => {
        const vol = Math.abs(row.leadReturn) + 0.8 * Math.abs(row.closeGapReturn);
        const scale = Math.max(1e-4, regimeThreshold * 0.22);
        const gate = 1 / (1 + Math.exp(-(vol - regimeThreshold) / scale));
        return predictCalm(row) * (1 - gate) + predictVolatile(row) * gate;
      },
    },
    { key: 'pa-sgd-stable', label: '路径校正-SGD稳健', predict: (row) => sgdStable[0] + sgdStable[1] * row.leadReturn + sgdStable[2] * row.closeGapReturn },
    { key: 'pa-sgd-fast', label: '路径校正-SGD灵敏', predict: (row) => sgdAggressive[0] + sgdAggressive[1] * row.leadReturn + sgdAggressive[2] * row.closeGapReturn },
  ];

  return variants.map((variant) => {
    const trainPoints = train.map((row) => {
      const predictedReturn = variant.predict(row);
      const predictedNav = row.anchorNav * (1 + predictedReturn);
      const absError = row.actualNav > 0 ? Math.abs(predictedNav / row.actualNav - 1) : 0;
      return { date: row.date, actualNav: row.actualNav, predictedNav, absError };
    });
    const validationPoints = validation.map((row) => {
      const predictedReturn = variant.predict(row);
      const predictedNav = row.anchorNav * (1 + predictedReturn);
      const absError = row.actualNav > 0 ? Math.abs(predictedNav / row.actualNav - 1) : 0;
      return { date: row.date, actualNav: row.actualNav, predictedNav, absError };
    });
    const maeTrain = average(trainPoints.map((item) => item.absError));
    const maeValidation = average(validationPoints.map((item) => item.absError));
    const maeValidation30 = average(validationPoints.slice(-30).map((item) => item.absError));

    return {
      key: variant.key,
      label: variant.label,
      mode: 'path-adjust',
      trainPoints,
      validationPoints,
      maeTrain,
      maeValidation,
      maeValidation30,
    };
  });
}

interface TsRow {
  date: string;
  actualNav: number;
  prevNav: number;
  lag1: number;
  lag2: number;
  ma3: number;
  ewma35: number;
  ewma65: number;
}

function buildTsRows(fund: FundViewModel): TsRow[] {
  const navAsc = [...fund.runtime.navHistory].sort((left, right) => left.date.localeCompare(right.date));
  if (navAsc.length < 10) {
    return [];
  }

  const returns: number[] = [];
  for (let i = 1; i < navAsc.length; i += 1) {
    const prev = navAsc[i - 1].nav;
    const curr = navAsc[i].nav;
    returns.push(prev > 0 ? curr / prev - 1 : 0);
  }

  const ewma35: number[] = [];
  const ewma65: number[] = [];
  let s35 = returns[0] ?? 0;
  let s65 = returns[0] ?? 0;
  for (let i = 0; i < returns.length; i += 1) {
    const r = returns[i] ?? 0;
    s35 = i === 0 ? r : 0.35 * r + 0.65 * s35;
    s65 = i === 0 ? r : 0.65 * r + 0.35 * s65;
    ewma35.push(s35);
    ewma65.push(s65);
  }

  const rows: TsRow[] = [];
  for (let i = 1; i < navAsc.length; i += 1) {
    const returnIndex = i - 1;
    const lastReturns = returns.slice(Math.max(0, returnIndex - 3), returnIndex);
    const ma3 = lastReturns.length ? average(lastReturns) : 0;
    rows.push({
      date: navAsc[i].date,
      actualNav: navAsc[i].nav,
      prevNav: navAsc[i - 1].nav,
      lag1: returnIndex >= 1 ? returns[returnIndex - 1] : 0,
      lag2: returnIndex >= 2 ? returns[returnIndex - 2] : 0,
      ma3,
      ewma35: returnIndex >= 1 ? ewma35[returnIndex - 1] : 0,
      ewma65: returnIndex >= 1 ? ewma65[returnIndex - 1] : 0,
    });
  }

  return rows;
}

function buildPointsByTsModel(rows: TsRow[], predictReturn: (row: TsRow) => number): ResearchPoint[] {
  return rows.map((row) => {
    const predictedNav = row.prevNav * (1 + predictReturn(row));
    const absError = row.actualNav > 0 ? Math.abs(predictedNav / row.actualNav - 1) : 0;
    return {
      date: row.date,
      actualNav: row.actualNav,
      predictedNav,
      absError,
    };
  });
}

function splitResearchPoints(points: ResearchPoint[]) {
  const { train, validation } = splitTrainValidationByYear(points);
  return { trainPoints: train, validationPoints: validation };
}

function buildTimeSeriesCandidates(fund: FundViewModel): ResearchCandidate[] {
  const rows = buildTsRows(fund);
  if (rows.length < 20) {
    return [];
  }

  const split = splitTrainValidationByYear(rows);
  const trainRows = split.train;

  const ar1Weights = fitLinearWeights(
    trainRows.map((row) => [1, row.lag1]),
    trainRows.map((row) => (row.prevNav > 0 ? row.actualNav / row.prevNav - 1 : 0)),
    0.2,
  ) ?? [0, 0];

  const ar2Weights = fitLinearWeights(
    trainRows.map((row) => [1, row.lag1, row.lag2]),
    trainRows.map((row) => (row.prevNav > 0 ? row.actualNav / row.prevNav - 1 : 0)),
    0.4,
  ) ?? [0, 0, 0];

  const tsRegimeThreshold = quantile(trainRows.map((row) => Math.abs(row.lag1) + 0.6 * Math.abs(row.lag2)), 0.7);

  const variants: Array<{ key: string; label: string; predict: (row: TsRow) => number }> = [
    { key: 'ts-naive', label: '时序-持平(naive)', predict: () => 0 },
    { key: 'ts-ma3', label: '时序-SMA3收益', predict: (row) => row.ma3 },
    { key: 'ts-ewma35', label: '时序-EWMA(0.35)', predict: (row) => row.ewma35 },
    { key: 'ts-ewma65', label: '时序-EWMA(0.65)', predict: (row) => row.ewma65 },
    { key: 'ts-ar1', label: '时序-AR1', predict: (row) => ar1Weights[0] + ar1Weights[1] * row.lag1 },
    { key: 'ts-ar2', label: '时序-AR2', predict: (row) => ar2Weights[0] + ar2Weights[1] * row.lag1 + ar2Weights[2] * row.lag2 },
    {
      key: 'ts-regime-switch',
      label: '时序-分波动状态',
      predict: (row) => {
        const vol = Math.abs(row.lag1) + 0.6 * Math.abs(row.lag2);
        return vol >= tsRegimeThreshold ? row.ewma65 : ar1Weights[0] + ar1Weights[1] * row.lag1;
      },
    },
  ];

  return variants.map((variant) => {
    const points = buildPointsByTsModel(rows, variant.predict);
    const { trainPoints, validationPoints } = splitResearchPoints(points);

    return {
      key: variant.key,
      label: variant.label,
      mode: 'time-series',
      trainPoints,
      validationPoints,
      maeTrain: average(trainPoints.map((item) => item.absError)),
      maeValidation: average(validationPoints.map((item) => item.absError)),
      maeValidation30: average(validationPoints.slice(-30).map((item) => item.absError)),
    };
  });
}

function buildResearchCandidates(fund: FundViewModel): ResearchCandidate[] {
  return [...buildPathAdjustCandidates(fund), ...buildTimeSeriesCandidates(fund)]
    .filter((item) => item.trainPoints.length >= 120 && item.validationPoints.length >= 30)
    .sort((left, right) => {
      const leftScore = Number.isFinite(left.maeValidation30) ? left.maeValidation30 : Number.POSITIVE_INFINITY;
      const rightScore = Number.isFinite(right.maeValidation30) ? right.maeValidation30 : Number.POSITIVE_INFINITY;
      if (leftScore !== rightScore) {
        return leftScore - rightScore;
      }

      const leftVal = Number.isFinite(left.maeValidation) ? left.maeValidation : Number.POSITIVE_INFINITY;
      const rightVal = Number.isFinite(right.maeValidation) ? right.maeValidation : Number.POSITIVE_INFINITY;
      return leftVal - rightVal;
    });
}

function buildAlgoVariants(fund: FundViewModel): AlgoVariant[] {
  const main = {
    key: 'main',
    label: '当前主模型',
    alpha: fund.model.alpha,
    betaLead: fund.model.betaLead,
    betaGap: fund.model.betaGap,
  };

  return [
    main,
    {
      key: 'baseline-v1',
      label: '基线 v1（固定系数）',
      alpha: 0,
      betaLead: 0.38,
      betaGap: 0,
    },
    {
      key: 'stable-v1',
      label: '稳健 v1（低灵敏）',
      alpha: main.alpha * 0.8,
      betaLead: main.betaLead * 0.82,
      betaGap: main.betaGap * 0.7,
    },
    {
      key: 'aggressive-v1',
      label: '激进 v1（高灵敏）',
      alpha: main.alpha,
      betaLead: main.betaLead * 1.15,
      betaGap: main.betaGap * 1.1,
    },
  ];
}

function computeAlgoScores(fund: FundViewModel): AlgoScore[] {
  const variants = buildAlgoVariants(fund);
  const snapshotsByDate = new Map(fund.journal.snapshots.map((item) => [item.estimateDate, item]));
  const settledRows = fund.journal.errors
    .map((errorPoint) => {
      const snapshot = snapshotsByDate.get(errorPoint.date);
      if (!snapshot || !Number.isFinite(errorPoint.actualNav) || errorPoint.actualNav <= 0 || snapshot.anchorNav <= 0) {
        return null;
      }

      return {
        actualNav: errorPoint.actualNav,
        anchorNav: snapshot.anchorNav,
        leadReturn: snapshot.leadReturn,
        closeGapReturn: snapshot.closeGapReturn,
      };
    })
    .filter(
      (item): item is { actualNav: number; anchorNav: number; leadReturn: number; closeGapReturn: number } => Boolean(item),
    );

  const recentRows7 = settledRows.slice(-7);
  const recentRows30 = settledRows.slice(-30);

  return variants
    .map((variant) => {
      const estimateReturn = variant.alpha + variant.betaLead * fund.estimate.leadReturn + variant.betaGap * fund.estimate.closeGapReturn;
      const estimatedNav = fund.estimate.anchorNav > 0 ? fund.estimate.anchorNav * (1 + estimateReturn) : 0;
      const premiumRate = estimatedNav > 0 ? fund.runtime.marketPrice / estimatedNav - 1 : 0;

      const allErrors = settledRows.map((row) => {
        const predictedReturn = variant.alpha + variant.betaLead * row.leadReturn + variant.betaGap * row.closeGapReturn;
        const predictedNav = row.anchorNav * (1 + predictedReturn);
        return Math.abs(predictedNav / row.actualNav - 1);
      });
      const recentErrors = recentRows7.map((row) => {
        const predictedReturn = variant.alpha + variant.betaLead * row.leadReturn + variant.betaGap * row.closeGapReturn;
        const predictedNav = row.anchorNav * (1 + predictedReturn);
        return Math.abs(predictedNav / row.actualNav - 1);
      });
      const last30Errors = recentRows30.map((row) => {
        const predictedReturn = variant.alpha + variant.betaLead * row.leadReturn + variant.betaGap * row.closeGapReturn;
        const predictedNav = row.anchorNav * (1 + predictedReturn);
        return Math.abs(predictedNav / row.actualNav - 1);
      });

      const maeAll = allErrors.length > 0 ? allErrors.reduce((sum, value) => sum + value, 0) / allErrors.length : NaN;
      const mae30 = last30Errors.length > 0 ? last30Errors.reduce((sum, value) => sum + value, 0) / last30Errors.length : NaN;
      const maeRecent = recentErrors.length > 0 ? recentErrors.reduce((sum, value) => sum + value, 0) / recentErrors.length : NaN;

      return {
        variant,
        sampleCount: settledRows.length,
        maeAll,
        mae30,
        maeRecent,
        estimatedNav,
        premiumRate,
      };
    })
    .sort((left, right) => {
      const leftScore = Number.isFinite(left.mae30) ? left.mae30 : Number.POSITIVE_INFINITY;
      const rightScore = Number.isFinite(right.mae30) ? right.mae30 : Number.POSITIVE_INFINITY;
      if (leftScore !== rightScore) {
        return leftScore - rightScore;
      }

      const leftRecent = Number.isFinite(left.maeRecent) ? left.maeRecent : Number.POSITIVE_INFINITY;
      const rightRecent = Number.isFinite(right.maeRecent) ? right.maeRecent : Number.POSITIVE_INFINITY;
      if (leftRecent !== rightRecent) {
        return leftRecent - rightRecent;
      }

      const leftAll = Number.isFinite(left.maeAll) ? left.maeAll : Number.POSITIVE_INFINITY;
      const rightAll = Number.isFinite(right.maeAll) ? right.maeAll : Number.POSITIVE_INFINITY;
      return leftAll - rightAll;
    });
}

function getProxyChange(currentPrice: number, previousClose: number) {
  return previousClose > 0 ? currentPrice / previousClose - 1 : 0;
}

function HomePage({
  funds,
  syncedAt,
  loading,
  error,
  pageCategory,
  trainingMetricsByCode,
  premiumCompareCodes,
}: {
  funds: FundViewModel[];
  syncedAt: string;
  loading: boolean;
  error: string;
  pageCategory: ViewCategory;
  trainingMetricsByCode: Record<string, TrainingMetricSummary>;
  premiumCompareCodes: Record<string, PremiumCompareCodePayload>;
}) {
  const pageOption = getPageOption(pageCategory);
  const [favoriteCodes, setFavoriteCodes] = useState<string[]>(() => readFavoriteFundCodes());
  const [orderedCodes, setOrderedCodes] = useState<string[]>(() => readFundOrder(pageCategory));
  const [githubTraffic, setGithubTraffic] = useState<GithubTrafficPayload>(() => getDefaultGithubTrafficPayload());

  useEffect(() => {
    setOrderedCodes(readFundOrder(pageCategory));
  }, [pageCategory]);

  useEffect(() => {
    let active = true;

    async function loadGithubTraffic() {
      try {
        const response = await fetch(`generated/github-traffic.json?ts=${Date.now()}`);
        if (!response.ok) {
          throw new Error(`traffic ${response.status}`);
        }

        const payload = (await response.json()) as GithubTrafficPayload;
        if (active) {
          setGithubTraffic({
            ...getDefaultGithubTrafficPayload(),
            ...payload,
          });
        }
      } catch {
        if (active) {
          setGithubTraffic(getDefaultGithubTrafficPayload());
        }
      }
    }

    void loadGithubTraffic();

    return () => {
      active = false;
    };
  }, [syncedAt]);

  const filteredFunds = useMemo(() => {
    if (pageCategory === 'favorites') {
      if (!favoriteCodes.length) {
        return [];
      }

      const fundByCode = new Map(funds.map((item) => [item.runtime.code, item]));
      return favoriteCodes
        .map((code) => fundByCode.get(code))
        .filter((item): item is FundViewModel => Boolean(item));
    }

    if (pageCategory === 'qdii-etf') {
      return funds.filter((item) => isQdiiEtfFund(item));
    }
    if (pageCategory === 'domestic-etf') {
      return funds.filter((item) => item.runtime.pageCategory === 'etf' && !isQdiiEtfFund(item));
    }
    return funds.filter((item) => item.runtime.pageCategory === pageCategory);
  }, [favoriteCodes, funds, pageCategory]);

  const visibleFunds = useMemo(() => {
    if (!orderedCodes.length) {
      return filteredFunds;
    }

    const orderIndex = new Map(orderedCodes.map((code, index) => [code, index]));
    return [...filteredFunds].sort((left, right) => {
      const leftIndex = orderIndex.get(left.runtime.code);
      const rightIndex = orderIndex.get(right.runtime.code);
      const leftDefined = typeof leftIndex === 'number';
      const rightDefined = typeof rightIndex === 'number';

      if (leftDefined && rightDefined) {
        return leftIndex - rightIndex;
      }
      if (leftDefined) {
        return -1;
      }
      if (rightDefined) {
        return 1;
      }

      return left.runtime.priority - right.runtime.priority;
    });
  }, [filteredFunds, orderedCodes]);

  const proxyDrivenCount = visibleFunds.filter((item) => item.runtime.estimateMode === 'proxy').length;
  const syncAgeHours = getHoursSinceSync(syncedAt);
  const untrainedCount = visibleFunds.filter((item) => !trainingMetricsByCode[item.runtime.code]).length;
  const favoriteVisibleCount = visibleFunds.filter((item) => favoriteCodes.includes(item.runtime.code)).length;
  const trafficSnapshots = (githubTraffic.snapshots ?? []).slice(-14);
  const trafficTrendPoints = useMemo(() => {
    if (!trafficSnapshots.length) {
      return '';
    }

    const maxY = Math.max(...trafficSnapshots.map((item) => item.viewUniques || 0), 1);
    const stepX = trafficSnapshots.length > 1 ? 120 / (trafficSnapshots.length - 1) : 0;
    return trafficSnapshots
      .map((item, index) => {
        const x = Number((stepX * index).toFixed(2));
        const y = Number((24 - ((item.viewUniques || 0) / maxY) * 22).toFixed(2));
        return `${x},${y}`;
      })
      .join(' ');
  }, [trafficSnapshots]);
  const latestTrafficDay = trafficSnapshots.length ? trafficSnapshots[trafficSnapshots.length - 1].date : '';
  const cumulativeSnapshotUniques = githubTraffic.snapshotSummary?.cumulativeViewUniques ?? trafficSnapshots.reduce((sum, item) => sum + (Number(item?.viewUniques) || 0), 0);
  const recent7UniquesDisplay = Number(githubTraffic?.recent7?.viewUniques) > 0 ? String(githubTraffic.recent7.viewUniques) : '--';
  const eastmoneyPremiumByCode = useMemo(() => {
    const next: Record<string, number | null> = {};
    for (const item of visibleFunds) {
      const compare = premiumCompareCodes[item.runtime.code];
      const eastmoney = compare?.providers?.find((provider) => provider.provider === 'eastmoney-fundgz');
      const rate = eastmoney?.premiumRateCurrent;
      next[item.runtime.code] = typeof rate === 'number' && Number.isFinite(rate) ? rate : null;
    }
    return next;
  }, [premiumCompareCodes, visibleFunds]);

  const handleToggleFavorite = (code: string) => {
    setFavoriteCodes((current) => {
      const next = current.includes(code) ? current.filter((item) => item !== code) : [code, ...current.filter((item) => item !== code)];
      writeFavoriteFundCodes(next);
      return next;
    });
  };

  const handleReorder = (next: string[]) => {
    if (!next.length) {
      return;
    }
    setOrderedCodes(next);
    writeFundOrder(pageCategory, next);
  };

  const handleFavoriteReorder = (next: string[]) => {
    if (!next.length) {
      return;
    }

    setFavoriteCodes(next);
    writeFavoriteFundCodes(next);
  };

  return (
    <main className="page">
      <section className="hero panel hero--wide">
        <div className="hero__copy">
          <span className="eyebrow">本地缓存 + 免费行情 + 每基金独立模型</span>
          <h1>溢价率日常看板</h1>
          <div className="page-tabs" role="tablist" aria-label="基金分类页面">
            {PAGE_OPTIONS.map((item) => (
              <Link key={item.key} className={`page-tab${item.key === pageCategory ? ' page-tab--active' : ''}`} to={item.path}>
                {item.label}
              </Link>
            ))}
            <Link className="page-tab" to="/docs">
              说明文档
            </Link>
          </div>
          <p className="hero__lead">{pageOption.lead}</p>
        </div>
        <div className="hero__facts hero__facts--compact">
          <div className="hero__fact hero__fact--accent">
            <span>当前页基金数</span>
            <strong>{visibleFunds.length}</strong>
          </div>
          <div className="hero__fact">
            <span>代理估值数</span>
            <strong>{proxyDrivenCount}</strong>
          </div>
          <Link className="hero__fact hero__fact--link" to="/traffic" title="查看访客趋势详情">
            <span>最近7日访客</span>
            <strong>{recent7UniquesDisplay}</strong>
            <small className="hero__fact-subtle">
              累计访客（快照）{cumulativeSnapshotUniques}
              {latestTrafficDay ? `，最新快照 ${latestTrafficDay}` : ''}
            </small>
            {trafficTrendPoints ? (
              <svg className="traffic-mini-chart" viewBox="0 0 120 26" aria-label="访客趋势图">
                <polyline points={trafficTrendPoints} />
              </svg>
            ) : null}
          </Link>
          <div className="hero__fact">
            <span>状态</span>
            <strong>{loading ? '同步中' : error ? '同步异常' : '可用'}</strong>
            <small className="hero__fact-subtle">
              本页未训练基金 {untrainedCount} 只，已收藏 {favoriteVisibleCount} 只
              {!githubTraffic.available && githubTraffic.reason ? `；访客数据不可用：${githubTraffic.reason}` : ''}
            </small>
          </div>
          <div className="hero__fact hero__fact--wide">
            <span>最近同步</span>
            <strong>{syncedAt ? formatDateTime(syncedAt) : '等待同步'}</strong>
            <small className="hero__fact-subtle">
              交易时段约 60 秒自动刷新，切回页面会立即补拉一次。
            </small>
          </div>
        </div>
        <div className="hero__note">
          <strong>公告栏</strong>
          <p>
            本页面仅用于基金溢价率观察与估值研究，不构成任何投资建议，也不保证数据实时、完整或绝对准确。
          </p>
          <div className="hero__bulletins">
            <p>如需增加基金、增加功能或提供建议，可搜索公众号“利奥的笔记”加群反馈。</p>
          </div>
          <div className="hero__promo">
            <span className="hero__promo-label">公众号</span>
            <strong>利奥的笔记</strong>
            <p>后续更新说明、误差复盘和新增基金支持会优先整理到公众号，微信搜索“利奥的笔记”即可找到。</p>
          </div>
        </div>
      </section>

      {error ? <section className="panel notice-panel">{error}</section> : null}
      {!error && syncAgeHours !== null && syncAgeHours >= 12 ? (
        <section className="panel notice-panel">
          当前页面数据同步时间偏旧，最新净值和盘中估值可能还没刷新。这不会阻止进入详情页；如果详情页异常，通常是旧页面缓存和新数据不一致，先强制刷新一次。
        </section>
      ) : null}

      <FundTable
        funds={visibleFunds}
        trainingMetricsByCode={trainingMetricsByCode}
        eastmoneyPremiumByCode={eastmoneyPremiumByCode}
        formatCurrency={formatCurrency}
        formatPercent={formatPercent}
        title={pageOption.tableTitle}
        description={pageOption.tableDescription}
        pagePath={pageOption.path}
        favoriteCodes={favoriteCodes}
        onToggleFavorite={handleToggleFavorite}
        onReorder={pageCategory === 'favorites' ? handleFavoriteReorder : handleReorder}
      />

      <section className="panel notice-panel">
        首页显示的是列表主看板。净值列展示最近一次已公布的官方净值，具体是 T-1 还是 T-2 直接看净值日期列；估值列展示的是当前预估净值。默认策略是“前十大持仓优先、代理篮子补足、汇率和误差修正联合驱动”；当持仓报价暂不可用时，会自动回退到代理篮子或场内信号。点击基金代码进入详情页后，可查看误差折线、净值误差、溢价率误差和历史估值口径。
      </section>
    </main>
  );
}

function DocsPage() {
  return (
    <main className="page">
      <section className="hero panel hero--wide">
        <div className="hero__copy">
          <span className="eyebrow">新手说明 + 口径定义 + 持续更新</span>
          <h1>估值说明文档</h1>
          <div className="page-tabs" role="tablist" aria-label="页面导航">
            {PAGE_OPTIONS.map((item) => (
              <Link key={item.key} className="page-tab" to={item.path}>
                {item.label}
              </Link>
            ))}
            <Link className="page-tab page-tab--active" to="/docs">
              说明文档
            </Link>
          </div>
          <p className="hero__lead">
            这个页面专门解释看板里每个指标是什么意思、估值大概怎么做、为什么会和盘中感受有偏差。后续新增规则、口径调整、异常处理都会优先补到这里。
          </p>
        </div>
        <div className="hero__facts hero__facts--single">
          <div className="hero__fact hero__fact--accent">
            <span>阅读建议</span>
            <strong>先看误差定义，再看估值流程</strong>
            <small className="hero__fact-subtle">这样最容易把“数字”和“结果”对应起来。</small>
          </div>
          <div className="hero__fact">
            <span>更新方式</span>
            <strong>文档随版本持续补充</strong>
            <small className="hero__fact-subtle">每次口径变化会同步到此页。</small>
          </div>
        </div>
      </section>

      <section className="panel docs-section">
        <h2>三个误差指标是什么意思</h2>
        <div className="docs-grid">
          <article className="docs-card">
            <h3>训练误差</h3>
            <p>看模型在离线验证数据上的平均误差，主要用来判断“模型本身的底子”是否靠谱。</p>
            <p>一般来说越小越好，适合看长期能力，不代表今天一定最准。</p>
          </article>
          <article className="docs-card">
            <h3>最近误差</h3>
            <p>最近一个已结算交易日的实际偏差，反映模型刚刚那次估值的命中情况。</p>
            <p>这个值会受单日突发影响比较大，波动通常最大。</p>
          </article>
          <article className="docs-card">
            <h3>30d误差</h3>
            <p>最近 30 个交易日平均绝对误差，用于看近期稳定性。</p>
            <p>可以把它理解为“最近一个月平均偏离多少”。</p>
          </article>
        </div>
      </section>

      <section className="panel docs-section">
        <h2>估值是怎么做出来的（小白版）</h2>
        <ol className="docs-list">
          <li>先用最近一次官方净值作为起点（通常是 T-1 或 T-2）。</li>
          <li>优先看前十大持仓的盘中涨跌，估算基金今天大概涨跌多少。</li>
          <li>如果持仓行情拿不全，就用代理篮子补足缺失信号。</li>
          <li>QDII 基金会叠加汇率变化影响。</li>
          <li>把历史误差学习得到的修正项加进去，减少系统性偏差。</li>
          <li>得到当日估值后，再和场内价格比较，算出溢价率。</li>
        </ol>
      </section>

      <section className="panel docs-section">
        <h2>为什么有时你觉得在跌，表里却显示涨</h2>
        <ul className="docs-list">
          <li>行情有刷新间隔，短时间内可能看到的是上一轮快照。</li>
          <li>不同数据源更新时间不完全一致，分钟级会有错位。</li>
          <li>基金估值是组合信号，不是单一股票涨跌的直接映射。</li>
          <li>若遇到节假日、跨市场休市、临停等情况，误差会放大。</li>
        </ul>
      </section>

      <section className="panel docs-section">
        <h2>刷新与缓存口径</h2>
        <ul className="docs-list">
          <li>公告和持仓结构按日更新，不需要每分钟重抓。</li>
          <li>盘中行情按短周期刷新，当前策略是最多约 5 分钟一轮。</li>
          <li>即使分组同步，也会对全基金统一叠加实时行情覆盖。</li>
        </ul>
      </section>

      <section className="panel notice-panel">
        说明页面会持续补充：例如新增误差口径、特殊基金处理逻辑、以及数据源异常时的兜底策略。你后续提到的解释需求都可以直接加在这里。
      </section>
    </main>
  );
}

function TrafficPage() {
  const [githubTraffic, setGithubTraffic] = useState<GithubTrafficPayload>(() => getDefaultGithubTrafficPayload());

  useEffect(() => {
    let active = true;

    async function loadGithubTraffic() {
      try {
        const response = await fetch(`generated/github-traffic.json?ts=${Date.now()}`);
        if (!response.ok) {
          throw new Error(`traffic ${response.status}`);
        }

        const payload = (await response.json()) as GithubTrafficPayload;
        if (active) {
          setGithubTraffic({
            ...getDefaultGithubTrafficPayload(),
            ...payload,
          });
        }
      } catch {
        if (active) {
          setGithubTraffic(getDefaultGithubTrafficPayload());
        }
      }
    }

    void loadGithubTraffic();

    return () => {
      active = false;
    };
  }, []);

  const recentTrafficDays = githubTraffic.recent7?.days ?? [];
  const trafficSnapshots = (githubTraffic.snapshots ?? []).slice(-30);
  const snapshotVisitorSeries = trafficSnapshots.map((item) => ({
    label: item.date,
    value: Number(item.viewUniques) || 0,
  }));
  const snapshotViewSeries = trafficSnapshots.map((item) => ({
    label: item.date,
    value: Number(item.viewCount) || 0,
  }));
  const recentVisitorSeries = recentTrafficDays.map((item) => ({
    label: item.date,
    value: Number(item.viewUniques) || 0,
  }));
  const recentViewSeries = recentTrafficDays.map((item) => ({
    label: item.date,
    value: Number(item.viewCount) || 0,
  }));
  const trafficRecent7UvDisplay = Number(githubTraffic?.recent7?.viewUniques) > 0 ? String(githubTraffic.recent7.viewUniques) : '--';
  const trafficRecent7PvDisplay = Number(githubTraffic?.recent7?.viewCount) > 0 ? String(githubTraffic.recent7.viewCount) : '--';

  return (
    <main className="page">
      <section className="hero panel hero--wide">
        <div className="hero__copy">
          <span className="eyebrow">GitHub Traffic 趋势</span>
          <h1>访客趋势页</h1>
          <div className="page-tabs" role="tablist" aria-label="页面导航">
            {PAGE_OPTIONS.map((item) => (
              <Link key={item.key} className="page-tab" to={item.path}>
                {item.label}
              </Link>
            ))}
            <Link className="page-tab" to="/docs">
              说明文档
            </Link>
            <Link className="page-tab page-tab--active" to="/traffic">
              访客趋势
            </Link>
          </div>
          <p className="hero__lead">这里专门看访客趋势和快照口径，不占首页空间。最近 7 天看短期波动，固定时点快照看长期趋势。</p>
        </div>
        <div className="hero__facts hero__facts--single">
          <div className="hero__fact hero__fact--accent">
            <span>最近7日访客(UV)</span>
            <strong>{trafficRecent7UvDisplay}</strong>
            <small className="hero__fact-subtle">最近7日浏览(PV) {trafficRecent7PvDisplay}</small>
          </div>
          <div className="hero__fact">
            <span>累计访客（快照）</span>
            <strong>{githubTraffic.snapshotSummary?.cumulativeViewUniques ?? 0}</strong>
            <small className="hero__fact-subtle">已记录天数 {githubTraffic.snapshotSummary?.totalDays ?? 0}</small>
          </div>
          <div className="hero__fact">
            <span>数据状态</span>
            <strong>{githubTraffic.available ? '可用' : '不可用'}</strong>
            <small className="hero__fact-subtle">{githubTraffic.available ? '由 GitHub traffic API 提供' : (githubTraffic.reason || '未知原因')}</small>
          </div>
        </div>
      </section>

      <section className="panel traffic-detail-panel">
        <div className="traffic-detail-grid">
          <LineChart
            title="每日快照访客趋势（近30天）"
            primary={snapshotVisitorSeries}
            secondary={snapshotViewSeries}
            primaryLabel="访客(UV)"
            secondaryLabel="浏览(PV)"
            valueFormatter={(value) => `${Math.round(value)}`}
          />
          <LineChart
            title="GitHub API 最近7天趋势"
            primary={recentVisitorSeries}
            secondary={recentViewSeries}
            primaryLabel="访客(UV)"
            secondaryLabel="浏览(PV)"
            valueFormatter={(value) => `${Math.round(value)}`}
          />
        </div>

        <ul className="docs-list">
          <li>最近7日访客：GitHub traffic API 返回的滚动 7 天去重访客总和。</li>
          <li>累计访客（快照）：每天固定时段抓取一次，便于比较长期变化趋势。</li>
          <li>快照时间默认北京时间中午，窗口内只记一次，避免同一天重复累计。</li>
        </ul>
      </section>
    </main>
  );
}

function DetailPage({ funds, syncedAt, loading }: { funds: FundViewModel[]; syncedAt: string; loading: boolean }) {
  const params = useParams();
  const location = useLocation();
  const fundCode = params.code ?? '';
  const [offlineResearch, setOfflineResearch] = useState<OfflineResearchSummary | null>(null);
  const [premiumCompare, setPremiumCompare] = useState<PremiumCompareCodePayload | null>(null);
  const fund = funds.find((item) => item.runtime.code === params.code);
  const syncAgeHours = getHoursSinceSync(syncedAt);

  useEffect(() => {
    let active = true;

    if (!OFFLINE_RESEARCH_CODES.has(fundCode)) {
      setOfflineResearch(null);
      return () => {
        active = false;
      };
    }

    async function loadOfflineResearch() {
      try {
        const response = await fetch(`generated/${fundCode}-offline-research.json?ts=${Date.now()}`);
        if (!response.ok) {
          throw new Error(`离线研究文件读取失败: ${response.status}`);
        }

        const payload = (await response.json()) as OfflineResearchSummary;
        if (active) {
          setOfflineResearch(payload);
        }
      } catch {
        if (active) {
          setOfflineResearch(null);
        }
      }
    }

    void loadOfflineResearch();

    return () => {
      active = false;
    };
  }, [fundCode, syncedAt]);

  useEffect(() => {
    let active = true;

    async function loadPremiumCompare() {
      try {
        const response = await fetch(`generated/premium-compare.json?ts=${Date.now()}`);
        if (!response.ok) {
          throw new Error(`premium compare ${response.status}`);
        }

        const payload = (await response.json()) as PremiumComparePayload;
        if (!active) {
          return;
        }

        setPremiumCompare(payload?.codes?.[fundCode] ?? null);
      } catch {
        if (active) {
          setPremiumCompare(null);
        }
      }
    }

    void loadPremiumCompare();

    return () => {
      active = false;
    };
  }, [fundCode, syncedAt]);

  useEffect(() => {
    if (!fundCode) {
      return;
    }

    const storedY = readDetailScrollY(fundCode);
    const rafId = window.requestAnimationFrame(() => {
      if (storedY > 0) {
        window.scrollTo({ top: storedY, behavior: 'auto' });
      }
    });

    const onScroll = () => {
      writeDetailScrollY(fundCode, window.scrollY || window.pageYOffset || 0);
    };

    window.addEventListener('scroll', onScroll, { passive: true });

    return () => {
      window.cancelAnimationFrame(rafId);
      window.removeEventListener('scroll', onScroll);
      writeDetailScrollY(fundCode, window.scrollY || window.pageYOffset || 0);
    };
  }, [fundCode]);

  if (loading && !fund) {
    return (
      <main className="page">
        <section className="panel notice-panel">基金数据加载中...</section>
      </main>
    );
  }

  if (!fund) {
    return (
      <main className="page">
        <section className="panel notice-panel">
          没找到基金 {params.code || ''} 的详情数据。可能是页面资源还是旧版本、同步数据偏旧，或者这次部署还没完全切换。
        </section>
        <section className="panel notice-panel">
          <Link className="back-link" to="/qdii-lof">
            返回看板
          </Link>
        </section>
      </main>
    );
  }

  const fromPath = new URLSearchParams(location.search).get('from');
  const backPath = PAGE_OPTIONS.some((item) => item.path === fromPath) ? fromPath ?? '/qdii-lof' : '/qdii-lof';
  const driverLabels = getEstimateDriverLabels(fund.runtime);
  const recentProxyQuotes = fund.runtime.proxyQuotes ?? [];

  const historyPoints = fund.journal.errors.slice(-20);
  const estimatedSeries = historyPoints.map((item) => ({ label: item.date, value: item.estimatedNav }));
  const actualSeries = historyPoints.map((item) => ({ label: item.date, value: item.actualNav }));
  const errorSeries = historyPoints.map((item) => ({ label: item.date, value: item.error }));
  const premiumTone = fund.estimate.premiumRate > 0 ? 'positive' : 'negative';
  const actualNavByDate = new Map(fund.runtime.navHistory.map((item) => [item.date, item.nav]));
  const errorByDate = new Map(fund.journal.errors.map((item) => [item.date, item]));
  const recentSnapshots = [...fund.journal.snapshots].slice(-20).reverse();
  const top10WeightPercent = getTop10DisclosedWeightPercent(fund.runtime);
  const currentEstimateDate = fund.runtime.marketDate || fund.runtime.navDate;
  const currentSnapshot = recentSnapshots.find((item) => item.estimateDate === currentEstimateDate) ?? recentSnapshots[0];
  const adaptiveStatusEnabled = fund.runtime.code === '161725' && Boolean(currentSnapshot?.adaptiveUsed);
  const adaptiveShockTriggered = Boolean(currentSnapshot?.adaptiveShockTriggered);
  const showOfflineResearch = OFFLINE_RESEARCH_CODES.has(fund.runtime.code) && offlineResearch;
  const offlineChartVersion = offlineResearch?.generatedAt || syncedAt || Date.now().toString();
  const shouldShowPremiumCompareDetails = Boolean(premiumCompare);
  const premiumCompareProviders = premiumCompare?.providers ?? [];
  const providerDailyComparisons = premiumCompare?.providerDailyComparisons ?? {};
  const providerStatsByName = new Map(premiumCompareProviders.map((item) => [item.provider, item]));
  const eastmoneyProvider = premiumCompareProviders.find((item) => item.provider === 'eastmoney-fundgz') ?? null;
  const eastmoneyRows = premiumCompare?.eastmoneyDailyValuations ?? [];
  const hasEastmoneyRows = eastmoneyRows.length > 0;
  const providersWithRows = Object.entries(providerDailyComparisons)
    .filter((entry) => Array.isArray(entry[1]) && entry[1].length > 0)
    .map((entry) => entry[0]);
  const summaryProviders = premiumCompareProviders.filter((item) => {
    if (item.provider === 'eastmoney-fundgz') {
      return hasEastmoneyRows;
    }
    return providersWithRows.includes(item.provider);
  });
  const otherPremiumProviders = providersWithRows
    .filter((provider) => provider !== 'eastmoney-fundgz')
    .map((provider) => ({
      provider,
      rows: providerDailyComparisons[provider] ?? [],
      stats: providerStatsByName.get(provider) ?? null,
    }));
  const ourPremiumSummary = premiumCompare?.ourPremiumSummary;

  return (
    <main className="page">
      {syncAgeHours !== null && syncAgeHours >= 12 ? (
        <section className="panel notice-panel">
          当前站点同步时间较旧，最新净值可能尚未刷新；这不是“更新中禁止查看”，而是部署或数据源还没产出更新。
        </section>
      ) : null}

      <section className="detail-header panel">
        <div>
          <Link className="back-link" to={backPath}>返回看板</Link>
          <span className="eyebrow">{fund.runtime.code} 详情</span>
          <h1>{fund.runtime.name}</h1>
          <p>{fund.runtime.benchmark || '该基金已纳入自动同步，但基准文本暂未抓取到。'}</p>
        </div>
        <div className="hero__facts hero__facts--single">
          <div>
            <span>最新净值日期</span>
            <strong>{fund.runtime.navDate || '--'}</strong>
          </div>
          <div>
            <span>自动估值日期</span>
            <strong>{fund.runtime.marketDate || fund.runtime.navDate || '--'}</strong>
          </div>
          <div>
            <span>自动同步时间</span>
            <strong>{syncedAt ? formatDateTime(syncedAt) : '--'}</strong>
          </div>
        </div>
      </section>

      <section className="metrics-grid">
        <MetricCard label="当日预估净值" value={formatCurrency(fund.estimate.estimatedNav)} hint={`以 ${fund.runtime.navDate || '--'} 最近官方净值为锚`} tone="neutral" />
        <MetricCard label="场内价格" value={formatCurrency(fund.runtime.marketPrice)} hint={formatRuntimeTime(fund.runtime.marketDate, fund.runtime.marketTime)} tone="neutral" />
        <MetricCard label="场内涨跌幅" value={formatPercent(getMarketChangeRate(fund.runtime))} hint={`昨收 ${formatCurrency(fund.runtime.previousClose)}`} tone={getMarketChangeRate(fund.runtime) >= 0 ? 'positive' : 'negative'} />
        <MetricCard label="自动溢价率" value={formatPercent(fund.estimate.premiumRate)} hint={fund.estimate.premiumRate >= 0 ? '价格高于当日预估净值' : '价格低于当日预估净值'} tone={premiumTone} />
      </section>

      <section className="panel summary-strip summary-strip--stacked">
        <div><span>模型 MAE</span><strong>{formatPercent(fund.model.meanAbsError)}</strong></div>
        <div><span>模型样本数</span><strong>{fund.model.sampleCount}</strong></div>
        {adaptiveStatusEnabled ? (
          <div><span>当日波动修正</span><strong className={adaptiveShockTriggered ? 'tone-positive' : 'muted-text'}>{adaptiveShockTriggered ? '已触发极端分支' : '未触发（常规分支）'}</strong></div>
        ) : null}
      </section>

      <section className="panel split-panel">
        <div className="split-panel__column">
          <div className="panel__header">
            <h2>自动模型说明</h2>
            <p>{driverLabels.summary} 它估的是“以最近官方净值为锚的当日预估净值”，不是已经公布出来的官方净值本身。</p>
          </div>
          <div className="coefficient-grid">
            <div><span>alpha</span><strong>{formatBps(fund.model.alpha)}</strong></div>
            <div><span>betaLead</span><strong>{fund.model.betaLead.toFixed(4)}</strong></div>
            <div><span>betaGap</span><strong>{fund.model.betaGap.toFixed(4)}</strong></div>
            <div><span>{driverLabels.primaryFactor}</span><strong>{formatPercent(fund.estimate.leadReturn)}</strong></div>
            <div><span>{driverLabels.secondaryFactor}</span><strong>{formatPercent(fund.estimate.closeGapReturn)}</strong></div>
            <div><span>最近训练</span><strong>{fund.model.lastUpdatedAt ? formatDateTime(fund.model.lastUpdatedAt) : '暂无'}</strong></div>
          </div>
        </div>
        <div className="split-panel__column">
          <div className="panel__header">
            <h2>误差入口</h2>
            <p>这里同时看净值误差和溢价率误差。净值误差口径为 估值 / 真实净值 - 1；已结算日期的场内价会尽量切到该日收盘参考价。</p>
          </div>
          <div className="summary-strip summary-strip--stacked">
            <div><span>历史已结算样本</span><strong>{fund.journal.errors.length}</strong></div>
            <div><span>最近估值误差</span><strong>{historyPoints.length > 0 ? formatPercent(historyPoints[historyPoints.length - 1].error) : '--'}</strong></div>
          </div>
        </div>
      </section>

      <section className="mini-data-grid">
        {!shouldShowPremiumCompareDetails && premiumCompare ? (
          <section className="chart-card">
            <div className="chart-card__header">
              <h3>第三方估值误差</h3>
              <div className="muted-text">当前只在研究中的重点基金详情页展示分网站误差表，其他基金暂不展开。</div>
            </div>
            <div className="mini-data-empty">该基金暂未开启分网站估值误差明细。</div>
          </section>
        ) : null}

        {shouldShowPremiumCompareDetails && premiumCompare ? (
          <section className="chart-card">
            <div className="chart-card__header">
              <h3>第三方误差总表</h3>
              <div className="muted-text">总表汇总最近30条已结算样本；第一行是本站口径，后面是各来源。</div>
            </div>
            {summaryProviders.length ? (
              <div className="table-scroll table-scroll--window">
                <table className="mini-data-table">
                  <thead>
                    <tr>
                      <th>来源</th>
                      <th>状态</th>
                      <th>当前溢价率</th>
                      <th>命中(60天)</th>
                      <th>已结算(最近30条)</th>
                      <th>来源误差MAE</th>
                      <th>本站误差MAE</th>
                      <th>误差差距</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>本站</td>
                      <td>--</td>
                      <td>--</td>
                      <td>--</td>
                      <td>{typeof ourPremiumSummary?.settledCount30 === 'number' ? ourPremiumSummary.settledCount30 : 0}/{typeof ourPremiumSummary?.settledWindowSize === 'number' ? ourPremiumSummary.settledWindowSize : 30}</td>
                      <td>--</td>
                      <td>{typeof ourPremiumSummary?.avgAbsOurError30 === 'number' ? formatPercent(ourPremiumSummary.avgAbsOurError30) : '--'}</td>
                      <td>--</td>
                    </tr>
                    {summaryProviders.map((providerItem) => (
                      <tr key={`summary-${providerItem.provider}`}>
                        <td>{getPremiumProviderLabel(providerItem.provider)}</td>
                        <td>{providerItem.sourceUrl ? <a className="fund-table__link" href={providerItem.sourceUrl} target="_blank" rel="noreferrer">{providerItem.status}</a> : providerItem.status}</td>
                        <td className={typeof providerItem.premiumRateCurrent === 'number' ? (providerItem.premiumRateCurrent >= 0 ? 'tone-positive' : 'tone-negative') : 'muted-text'}>{typeof providerItem.premiumRateCurrent === 'number' ? formatPercent(providerItem.premiumRateCurrent) : '--'}</td>
                        <td>{typeof providerItem.hitCount60 === 'number' ? providerItem.hitCount60 : 0}</td>
                        <td>{typeof providerItem.settledCount30 === 'number' ? providerItem.settledCount30 : providerItem.sampleCount30}/{typeof providerItem.settledWindowSize === 'number' ? providerItem.settledWindowSize : 30}</td>
                        <td>{typeof providerItem.avgAbsProviderError30 === 'number' ? formatPercent(providerItem.avgAbsProviderError30) : '--'}</td>
                        <td>{typeof providerItem.avgAbsOurError30 === 'number' ? formatPercent(providerItem.avgAbsOurError30) : '--'}</td>
                        <td className={typeof providerItem.avgAbsDelta30 === 'number' ? (providerItem.avgAbsDelta30 <= 0 ? 'tone-positive' : 'tone-negative') : 'muted-text'}>{typeof providerItem.avgAbsDelta30 === 'number' ? formatPercent(providerItem.avgAbsDelta30) : '--'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <div className="mini-data-empty">暂未抓到可用的第三方来源数据。</div>}
          </section>
        ) : null}

        <section className="chart-card">
          <div className="chart-card__header">
            <h3>本站最近误差</h3>
            <div className="muted-text">未结算日期显示估值快照；结算后自动回填真实净值与溢价误差。净值误差口径：估值 / 真实净值 - 1；溢价率误差口径：估算溢价率 - 实际收盘溢价率。</div>
          </div>
          {recentSnapshots.length > 0 ? (
            <div className="table-scroll table-scroll--window">
              <table className="mini-data-table">
                <thead><tr><th>日期</th><th>状态</th><th>估值</th><th>参考场内价</th><th>价格口径</th><th>对应真实净值</th><th>净值误差</th><th>估算溢价率</th><th>实际收盘溢价率</th><th>溢价率误差</th></tr></thead>
                <tbody>
                  {recentSnapshots.map((item) => {
                    const settled = errorByDate.get(item.estimateDate);
                    const actualNav = settled?.actualNav ?? actualNavByDate.get(item.estimateDate);
                    const hasActual = typeof actualNav === 'number';
                    const estimateError = settled?.error;
                    const premiumError = settled?.premiumError;
                    return (
                      <tr key={item.estimateDate}>
                        <td>{item.estimateDate}</td>
                        <td className={hasActual ? 'tone-positive' : 'muted-text'}>{hasActual ? '已结算' : '待净值'}</td>
                        <td>{formatCurrency(item.estimatedNav)}</td>
                        <td>{formatCurrency(item.marketPrice)}</td>
                        <td>{item.marketPriceType === 'close' ? '收盘' : '快照'}</td>
                        <td>{formatOptionalCurrency(actualNav)}</td>
                        <td className={typeof estimateError === 'number' ? (estimateError >= 0 ? 'tone-positive' : 'tone-negative') : 'muted-text'}>{typeof estimateError === 'number' ? formatPercent(estimateError) : '--'}</td>
                        <td className={item.premiumRate >= 0 ? 'tone-positive' : 'tone-negative'}>{formatPercent(item.premiumRate)}</td>
                        <td className={typeof settled?.actualPremiumRate === 'number' ? ((settled.actualPremiumRate ?? 0) >= 0 ? 'tone-positive' : 'tone-negative') : 'muted-text'}>{typeof settled?.actualPremiumRate === 'number' ? formatPercent(settled.actualPremiumRate) : '--'}</td>
                        <td className={typeof premiumError === 'number' ? (premiumError >= 0 ? 'tone-positive' : 'tone-negative') : 'muted-text'}>{typeof premiumError === 'number' ? formatPercent(premiumError) : '--'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : <div className="mini-data-empty">还没有历史估值记录。</div>}
        </section>

        {shouldShowPremiumCompareDetails && premiumCompare ? (
          <section className="chart-card">
            <div className="chart-card__header"><h3>东财估值误差（东财日度）</h3><div className="muted-text">按东财溢价率反算估值；待结算日先展示，结算后自动补东财估值误差。</div></div>
            {premiumCompare.eastmoneyDailyValuations?.length ? (
              <div className="table-scroll table-scroll--window">
                <table className="mini-data-table">
                  <thead><tr><th>日期</th><th>快照时间</th><th>场内价</th><th>东财溢价率</th><th>东财反算估值</th><th>状态</th><th>真实净值</th><th>东财估值误差</th></tr></thead>
                  <tbody>
                    {[...premiumCompare.eastmoneyDailyValuations].reverse().map((item) => (
                      <tr key={`${item.date}-${item.time || 'na'}`}>
                        <td>{item.date}</td><td>{item.time || '--'}</td><td>{formatCurrency(item.marketPrice)}</td><td>{formatPercent(item.providerPremiumRate)}</td><td>{typeof item.providerEstimatedNav === 'number' ? formatCurrency(item.providerEstimatedNav) : '--'}</td>
                        <td className={item.status === 'settled' ? 'tone-positive' : 'muted-text'}>{item.status === 'settled' ? '已结算' : '待结算'}</td>
                        <td>{typeof item.actualNav === 'number' ? formatCurrency(item.actualNav) : '--'}</td>
                        <td className={typeof item.providerNavError === 'number' ? (item.providerNavError >= 0 ? 'tone-positive' : 'tone-negative') : 'muted-text'}>{typeof item.providerNavError === 'number' ? formatPercent(item.providerNavError) : '--'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <div className="mini-data-empty">暂未抓到可用于反算的东财溢价率快照。</div>}
          </section>
        ) : null}

        {shouldShowPremiumCompareDetails && premiumCompare ? otherPremiumProviders.map((item) => (
          <section className="chart-card" key={`provider-card-${item.provider}`}>
            <div className="chart-card__header">
              <h3>{getPremiumProviderLabel(item.provider)}日度误差</h3>
              <div className="muted-text">仅保留最近30条已结算样本，并保留已抓到溢价率但尚未结算的待验证样本。</div>
            </div>
            {item.rows.length ? (
              <div className="table-scroll table-scroll--window">
                <table className="mini-data-table">
                  <thead><tr><th>日期</th><th>快照时间</th><th>场内价</th><th>来源溢价率</th><th>来源反算估值</th><th>本站溢价率</th><th>状态</th><th>实际收盘溢价率</th><th>来源误差</th><th>本站误差</th><th>误差差距</th></tr></thead>
                  <tbody>
                    {[...item.rows].reverse().map((dailyItem) => {
                      const estimatedNav = getEstimatedNavFromPremium(dailyItem.marketPrice, dailyItem.providerPremiumRate);
                      return (
                        <tr key={`${item.provider}-${dailyItem.date}-${dailyItem.time || 'na'}`}>
                          <td>{dailyItem.date}</td><td>{dailyItem.time || '--'}</td><td>{typeof dailyItem.marketPrice === 'number' ? formatCurrency(dailyItem.marketPrice) : '--'}</td><td>{formatPercent(dailyItem.providerPremiumRate)}</td>
                          <td>{typeof estimatedNav === 'number' ? formatCurrency(estimatedNav) : '--'}</td>
                          <td className={typeof dailyItem.ourReportedPremiumRate === 'number' ? (dailyItem.ourReportedPremiumRate >= 0 ? 'tone-positive' : 'tone-negative') : 'muted-text'}>{typeof dailyItem.ourReportedPremiumRate === 'number' ? formatPercent(dailyItem.ourReportedPremiumRate) : '--'}</td>
                          <td className={dailyItem.status === 'settled' ? 'tone-positive' : 'muted-text'}>{dailyItem.status === 'settled' ? '已结算' : '待结算'}</td>
                          <td className={typeof dailyItem.actualPremiumRate === 'number' ? (dailyItem.actualPremiumRate >= 0 ? 'tone-positive' : 'tone-negative') : 'muted-text'}>{typeof dailyItem.actualPremiumRate === 'number' ? formatPercent(dailyItem.actualPremiumRate) : '--'}</td>
                          <td className={typeof dailyItem.providerPremiumError === 'number' ? (dailyItem.providerPremiumError <= 0 ? 'tone-positive' : 'tone-negative') : 'muted-text'}>{typeof dailyItem.providerPremiumError === 'number' ? formatPercent(dailyItem.providerPremiumError) : '--'}</td>
                          <td className={typeof dailyItem.ourPremiumError === 'number' ? (dailyItem.ourPremiumError <= 0 ? 'tone-positive' : 'tone-negative') : 'muted-text'}>{typeof dailyItem.ourPremiumError === 'number' ? formatPercent(dailyItem.ourPremiumError) : '--'}</td>
                          <td className={typeof dailyItem.premiumErrorDelta === 'number' ? (dailyItem.premiumErrorDelta <= 0 ? 'tone-positive' : 'tone-negative') : 'muted-text'}>{typeof dailyItem.premiumErrorDelta === 'number' ? formatPercent(dailyItem.premiumErrorDelta) : '--'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : <div className="mini-data-empty">该来源暂无日度记录。</div>}
          </section>
        )) : null}

        {fund.runtime.proxyBasketName || recentProxyQuotes.length > 0 ? (
          <section className="chart-card">
            <div className="chart-card__header">
              <h3>代理篮子</h3>
              <div className="muted-text">{fund.runtime.proxyBasketName || '代理篮子'} {formatRuntimeTime(fund.runtime.proxyQuoteDate || '', fund.runtime.proxyQuoteTime || '')}</div>
            </div>
            {recentProxyQuotes.length > 0 ? (
              <div className="table-scroll table-scroll--window">
                <table className="mini-data-table">
                  <thead>
                    <tr>
                      <th>代码</th>
                      <th>名称</th>
                      <th>权重</th>
                      <th>涨跌幅</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentProxyQuotes.map((item) => (
                      <tr key={item.ticker}>
                        <td>{item.ticker}</td>
                        <td>{item.name}</td>
                        <td>{formatPercent(item.weight)}</td>
                        <td className={getProxyChange(item.currentPrice, item.previousClose) >= 0 ? 'tone-positive' : 'tone-negative'}>{formatPercent(getProxyChange(item.currentPrice, item.previousClose))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="mini-data-empty">该基金当前有代理篮子配置，但本次同步未抓到可展示的代理行情明细。</div>
            )}
          </section>
        ) : null}

        {fund.runtime.disclosedHoldings?.length ? (
          <section className="chart-card">
            <div className="chart-card__header">
              <h3>最新前十大持仓公告</h3>
              <div className="muted-text">
                {fund.runtime.disclosedHoldingsTitle || '基金持仓'} {fund.runtime.disclosedHoldingsReportDate ? `截止至 ${fund.runtime.disclosedHoldingsReportDate}` : ''}
                {fund.runtime.disclosedHoldings?.length ? `，前十大持仓合计 ${top10WeightPercent.toFixed(2)}%` : ''}
                {fund.runtime.holdingsQuoteDate ? `，行情时间 ${formatRuntimeTime(fund.runtime.holdingsQuoteDate, fund.runtime.holdingsQuoteTime || '')}` : ''}
              </div>
            </div>
            <div className="table-scroll table-scroll--window">
              <table className="mini-data-table">
                <thead>
                  <tr>
                    <th>代码</th>
                    <th>名称</th>
                    <th>权重</th>
                    <th>现价</th>
                    <th>涨跌幅</th>
                  </tr>
                </thead>
                <tbody>
                  {fund.runtime.disclosedHoldings.map((item) => (
                    <tr key={`${item.ticker}-${item.name}`}>
                      <td>{item.ticker}</td>
                      <td>{item.name}</td>
                      <td>{formatHoldingWeight(item.weight)}</td>
                      <td>{formatOptionalCurrency(item.currentPrice)}</td>
                      <td className={typeof item.changeRate === 'number' ? (item.changeRate >= 0 ? 'tone-positive' : 'tone-negative') : 'muted-text'}>{formatOptionalChangeRate(item.changeRate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}

      </section>

      {showOfflineResearch ? (
        <section className="panel">
          <div className="panel__header">
            <h2>{fund.runtime.code} 离线本地出图研究</h2>
            <p>
              该图由本地脚本在同步后离线生成并写入站点静态文件，避免浏览器端多图叠加造成的可读性问题。
              当前页面只保留按持仓披露期分段训练的结果展示，不再展示双目标对比和时序类试验界面。
            </p>
          </div>

          <div className="table-scroll table-scroll--window">
            <table className="mini-data-table">
              <thead>
                <tr>
                  <th>方案</th>
                  <th>训练 MAE</th>
                  <th>验证 MAE</th>
                  <th>验证近30 MAE</th>
                  <th>验证近30鲁棒 MAE</th>
                  <th>验证加权 MAE</th>
                  <th>补充信息</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>持仓期分段训练</td>
                  <td>{Number.isFinite(offlineResearch.segmented.maeTrain) ? formatPercent(offlineResearch.segmented.maeTrain) : '--'}</td>
                  <td>{Number.isFinite(offlineResearch.segmented.maeValidation) ? formatPercent(offlineResearch.segmented.maeValidation) : '--'}</td>
                  <td>{Number.isFinite(offlineResearch.segmented.maeValidation30) ? formatPercent(offlineResearch.segmented.maeValidation30) : '--'}</td>
                  <td>{Number.isFinite(offlineResearch.segmented.maeValidation30Robust) ? formatPercent(offlineResearch.segmented.maeValidation30Robust || 0) : '--'}</td>
                  <td>{Number.isFinite(offlineResearch.segmented.maeValidation30Weighted) ? formatPercent(offlineResearch.segmented.maeValidation30Weighted || 0) : (Number.isFinite(offlineResearch.segmented.maeValidationWeighted) ? formatPercent(offlineResearch.segmented.maeValidationWeighted || 0) : '--')}</td>
                  <td>{`披露期数 ${offlineResearch.disclosureCount} 个${typeof offlineResearch.avgHoldingCoverage === 'number' ? `，平均覆盖 ${(offlineResearch.avgHoldingCoverage * 100).toFixed(1)}%` : ''}`}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div className="research-time-note">
            训练集：{offlineResearch.trainRange}；验证集：{offlineResearch.validationRange}；切分模式：{offlineResearch.splitMode}。
            {offlineResearch.notes}
            {Number.isFinite(offlineResearch.segmented.maeValidation30Robust) ? ' 当前专项优化优先看“验证近30鲁棒 MAE”（剔除已标记异常日并做尾部鲁棒处理）。' : ''}
          </div>

          <div className="offline-research-image-wrap">
            <img
              className="offline-research-image"
              src={`${offlineResearch.chartPath}?ts=${encodeURIComponent(offlineChartVersion)}`}
              alt={`${fund.runtime.code} 离线研究图`}
              loading="lazy"
            />
          </div>
        </section>
      ) : null}

      <section className="chart-grid">
        <LineChart title="估值与真实净值" primary={estimatedSeries} secondary={actualSeries} primaryLabel="昨日估值" secondaryLabel="后续真实净值" valueFormatter={formatCurrency} />
        <LineChart title="估值误差折线" primary={errorSeries} primaryLabel="误差" valueFormatter={formatPercent} />
      </section>
    </main>
  );
}

export default function App() {
  const [funds, setFunds] = useState<FundViewModel[]>([]);
  const [syncedAt, setSyncedAt] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [trainingMetricsByCode, setTrainingMetricsByCode] = useState<Record<string, TrainingMetricSummary>>({});
  const [premiumCompareCodes, setPremiumCompareCodes] = useState<Record<string, PremiumCompareCodePayload>>({});

  useEffect(() => {
    let active = true;
    let timer = 0;

    async function loadRuntime(options?: { silent?: boolean }) {
      const silent = Boolean(options?.silent);
      if (!silent) {
        setLoading(true);
      }
      setError('');

      try {
        const response = await fetch(`generated/funds-runtime.json?ts=${Date.now()}`);
        if (!response.ok) {
          throw new Error(`同步文件读取失败: ${response.status}`);
        }

        const payload = (await response.json()) as RuntimePayload;
        const nextFunds = payload.funds.map((runtime: FundRuntimeData) => {
          const persistedState = payload.stateByCode?.[runtime.code];
          const initialModel = normalizeWatchlistModel(persistedState?.model ?? readWatchlistModel(runtime.code));
          const initialJournal = normalizeFundJournal(persistedState?.journal ?? readFundJournal(runtime.code));
          const reconciled = reconcileJournal(runtime, initialModel, initialJournal);
          const estimate = estimateWatchlistFund(runtime, reconciled.model, reconciled.journal);
          const journal = recordEstimateSnapshot(reconciled.journal, runtime, estimate);

          writeWatchlistModel(runtime.code, reconciled.model);
          writeFundJournal(runtime.code, journal);

          return {
            runtime,
            model: reconciled.model,
            journal,
            estimate,
          };
        });

        nextFunds.sort((left, right) => left.runtime.priority - right.runtime.priority);

        if (!active) {
          return;
        }

        setFunds(nextFunds);
        setSyncedAt(payload.syncedAt);
      } catch (loadError) {
        if (!active) {
          return;
        }

        setError(loadError instanceof Error ? loadError.message : '同步失败');
      } finally {
        if (active && !silent) {
          setLoading(false);
        }
      }
    }

    function scheduleNextRefresh() {
      timer = window.setTimeout(() => {
        void loadRuntime({ silent: true }).finally(() => {
          if (active) {
            scheduleNextRefresh();
          }
        });
      }, getRuntimeRefreshInterval());
    }

    function triggerImmediateRefresh() {
      window.clearTimeout(timer);
      void loadRuntime({ silent: true }).finally(() => {
        if (active) {
          scheduleNextRefresh();
        }
      });
    }

    function handleVisibilityChange() {
      if (document.visibilityState === 'visible') {
        triggerImmediateRefresh();
      }
    }

    void loadRuntime({ silent: false });
    scheduleNextRefresh();
    window.addEventListener('focus', triggerImmediateRefresh);
    window.addEventListener('pageshow', triggerImmediateRefresh);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      active = false;
      window.clearTimeout(timer);
      window.removeEventListener('focus', triggerImmediateRefresh);
      window.removeEventListener('pageshow', triggerImmediateRefresh);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  useEffect(() => {
    let active = true;

    async function loadTrainingMetrics() {
      const entries = await Promise.all(
        [...OFFLINE_RESEARCH_CODES].map(async (code) => {
          try {
            const response = await fetch(`generated/${code}-offline-research.json?ts=${Date.now()}`);
            if (!response.ok) {
              return null;
            }

            const payload = (await response.json()) as OfflineResearchSummary;
            const maeValidation30 = Number(payload?.segmented?.maeValidation30);
            const maeValidation30Robust = Number((payload as OfflineResearchSummary & { segmented?: { maeValidation30Robust?: number } })?.segmented?.maeValidation30Robust);
            const maeValidation = Number(payload?.segmented?.maeValidation);
            const maeTrain = Number(payload?.segmented?.maeTrain);
            if (!Number.isFinite(maeValidation30)) {
              return null;
            }

            return [code, {
              maeTrain,
              maeValidation,
              maeValidation30: Number.isFinite(maeValidation30Robust) ? maeValidation30Robust : maeValidation30,
              maeValidation30Robust: Number.isFinite(maeValidation30Robust) ? maeValidation30Robust : undefined,
              generatedAt: payload.generatedAt,
            }] as const;
          } catch {
            return null;
          }
        }),
      );

      if (!active) {
        return;
      }

      const next: Record<string, TrainingMetricSummary> = {};
      for (const item of entries) {
        if (!item) {
          continue;
        }
        next[item[0]] = item[1];
      }
      setTrainingMetricsByCode(next);
    }

    void loadTrainingMetrics();

    return () => {
      active = false;
    };
  }, [syncedAt]);

  useEffect(() => {
    let active = true;

    async function loadPremiumCompareCodes() {
      try {
        const response = await fetch(`generated/premium-compare.json?ts=${Date.now()}`);
        if (!response.ok) {
          throw new Error(`premium compare ${response.status}`);
        }

        const payload = (await response.json()) as PremiumComparePayload;
        if (!active) {
          return;
        }

        setPremiumCompareCodes(payload?.codes ?? {});
      } catch {
        if (active) {
          setPremiumCompareCodes({});
        }
      }
    }

    void loadPremiumCompareCodes();

    return () => {
      active = false;
    };
  }, [syncedAt]);

  return (
    <div className="app-shell">
      <div className="background-orb background-orb--amber" />
      <div className="background-orb background-orb--teal" />
      <AppErrorBoundary>
        <Routes>
          <Route path="/" element={<Navigate to="/qdii-lof" replace />} />
          <Route path="/domestic-lof" element={<HomePage funds={funds} syncedAt={syncedAt} loading={loading} error={error} pageCategory="domestic-lof" trainingMetricsByCode={trainingMetricsByCode} premiumCompareCodes={premiumCompareCodes} />} />
          <Route path="/qdii-lof" element={<HomePage funds={funds} syncedAt={syncedAt} loading={loading} error={error} pageCategory="qdii-lof" trainingMetricsByCode={trainingMetricsByCode} premiumCompareCodes={premiumCompareCodes} />} />
          <Route path="/qdii-etf" element={<HomePage funds={funds} syncedAt={syncedAt} loading={loading} error={error} pageCategory="qdii-etf" trainingMetricsByCode={trainingMetricsByCode} premiumCompareCodes={premiumCompareCodes} />} />
          <Route path="/domestic-etf" element={<HomePage funds={funds} syncedAt={syncedAt} loading={loading} error={error} pageCategory="domestic-etf" trainingMetricsByCode={trainingMetricsByCode} premiumCompareCodes={premiumCompareCodes} />} />
          <Route path="/favorites" element={<HomePage funds={funds} syncedAt={syncedAt} loading={loading} error={error} pageCategory="favorites" trainingMetricsByCode={trainingMetricsByCode} premiumCompareCodes={premiumCompareCodes} />} />
          <Route path="/docs" element={<DocsPage />} />
          <Route path="/traffic" element={<TrafficPage />} />
          <Route path="/etf" element={<Navigate to="/qdii-etf" replace />} />
          <Route path="/detail/:code" element={<DetailPage funds={funds} syncedAt={syncedAt} loading={loading} />} />
          <Route path="/fund/:code" element={<DetailPage funds={funds} syncedAt={syncedAt} loading={loading} />} />
          <Route path="*" element={<Navigate to="/qdii-lof" replace />} />
        </Routes>
      </AppErrorBoundary>
    </div>
  );
}
