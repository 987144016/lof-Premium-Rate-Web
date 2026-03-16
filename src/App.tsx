import React, { useEffect, useMemo, useState } from 'react';
import { Link, Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { FundTable } from './components/FundTable';
import { EditableHoldingsTable } from './components/EditableHoldingsTable';
import { LineChart } from './components/LineChart';
import { MetricCard } from './components/MetricCard';
import { cloneInitialScenario, defaultCalibration } from './data/funds';
import { estimateScenario, trainCalibration } from './lib/estimator';
import { readFundJournal, readWatchlistModel, writeFundJournal, writeWatchlistModel } from './lib/storage';
import { estimateWatchlistFund, getDefaultWatchlistModel, reconcileJournal, recordEstimateSnapshot } from './lib/watchlist';
import type { CalibrationModel, FundJournal, FundRuntimeData, FundScenario, FundViewModel, GithubTrafficPayload, PageCategory, RuntimePayload, WatchlistModel } from './types';

const DETAIL_CALIBRATION_PREFIX = 'premium-estimator:detailed-calibration:';
const FAST_SYNC_INTERVAL = 60_000;
const SLOW_SYNC_INTERVAL = 15 * 60_000;
const PAGE_OPTIONS: Array<{ key: PageCategory; path: string; label: string; lead: string; tableTitle: string; tableDescription: string }> = [
  {
    key: 'qdii-lof',
    path: '/qdii-lof',
    label: 'QDII 的 LOF',
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
    key: 'etf',
    path: '/etf',
    label: 'ETF 类',
    lead: '这一页单独放 ETF 类基金。默认同样采用“前十大持仓优先 + 代理篮子补足 + 汇率/修正因子”口径，场内价格主要用于展示溢价率。',
    tableTitle: 'ETF 类列表',
    tableDescription: 'ETF 页当前以跨境 ETF 为主，估值口径与 QDII 一致：前十大持仓优先、代理篮子补足、汇率和修正因子联合驱动。点击表头可排序。',
  },
];

const DEFAULT_GITHUB_TRAFFIC: GithubTrafficPayload = {
  generatedAt: '',
  source: 'github-traffic-api',
  repo: '',
  available: false,
  reason: 'not-loaded',
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
const HOLDINGS_SIGNAL_MIN_COVERAGE_BY_CODE: Record<string, number> = {
  '513310': 0.55,
  '161128': 0.7,
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

function getPageOption(pageCategory: PageCategory) {
  return PAGE_OPTIONS.find((item) => item.key === pageCategory) ?? PAGE_OPTIONS[0];
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

function buildSparklinePoints(values: number[], width: number, height: number) {
  if (!values.length) {
    return '';
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(1e-9, max - min);
  const step = values.length > 1 ? width / (values.length - 1) : 0;

  return values
    .map((value, index) => {
      const x = (index * step).toFixed(2);
      const y = (height - ((value - min) / range) * height).toFixed(2);
      return `${x},${y}`;
    })
    .join(' ');
}

const OFFLINE_RESEARCH_CODES = new Set(['160216', '160723', '161725', '501018', '161129', '160719', '161116', '164701', '501225', '513310', '161130', '160416', '162719', '162411', '161125', '159509', '501312', '501011', '501050', '160221', '165520', '167301', '161226', '161128', '513800', '513880', '513520', '513100', '513500']);

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

function readStoredCalibration(code: string): CalibrationModel {
  if (typeof window === 'undefined') {
    return defaultCalibration;
  }

  try {
    const raw = window.localStorage.getItem(`${DETAIL_CALIBRATION_PREFIX}${code}`);
    if (!raw) {
      return defaultCalibration;
    }

    return { ...defaultCalibration, ...JSON.parse(raw) } as CalibrationModel;
  } catch {
    return defaultCalibration;
  }
}

function writeStoredCalibration(code: string, calibration: CalibrationModel) {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(`${DETAIL_CALIBRATION_PREFIX}${code}`, JSON.stringify(calibration));
  } catch {
    // Ignore storage failures in restricted browser contexts.
  }
}

function DetailedEstimatorPanel({ fund }: { fund: FundViewModel }) {
  const [scenario, setScenario] = useState<FundScenario>(() => cloneInitialScenario(fund.runtime));
  const [calibration, setCalibration] = useState<CalibrationModel>(() => readStoredCalibration(fund.runtime.code));
  const [actualNavInput, setActualNavInput] = useState('');
  const result = estimateScenario(scenario, calibration);
  const premiumTone = result.premiumRate > 0 ? 'positive' : 'negative';

  useEffect(() => {
    setScenario(cloneInitialScenario(fund.runtime));
  }, [fund.runtime]);

  useEffect(() => {
    writeStoredCalibration(fund.runtime.code, calibration);
  }, [calibration, fund.runtime.code]);

  const updateScenario = (updater: (current: FundScenario) => FundScenario) => {
    setScenario((current) => updater(current));
  };

  const handleHoldingChange = (index: number, field: 'basePrice' | 'currentPrice', value: number) => {
    updateScenario((current) => {
      const next = structuredClone(current);
      next.holdings[index][field] = Number.isFinite(value) && value > 0 ? value : 0;
      return next;
    });
  };

  const handleProxyChange = (index: number, field: 'baseLevel' | 'currentLevel', value: number) => {
    updateScenario((current) => {
      const next = structuredClone(current);
      next.proxyBuckets[index][field] = Number.isFinite(value) && value > 0 ? value : 0;
      return next;
    });
  };

  const handleLearn = () => {
    const actualNav = Number(actualNavInput);
    if (!Number.isFinite(actualNav) || actualNav <= 0) {
      return;
    }

    setCalibration((current) => trainCalibration(current, scenario, actualNav));
    setActualNavInput('');
  };

  return (
    <section className="detail-stack">
      <section className="metrics-grid">
        <MetricCard
          label="持仓模式当日预估净值"
          value={formatCurrency(result.correctedEstimatedNav)}
          hint={`以最近官方净值 ${scenario.officialNavT1.toFixed(4)} 为锚推算当日未公布净值`}
          tone="neutral"
        />
        <MetricCard
          label="场内价格"
          value={formatCurrency(scenario.latestMarketPrice)}
          hint={formatRuntimeTime(fund.runtime.marketDate, fund.runtime.marketTime)}
          tone="neutral"
        />
        <MetricCard
          label="持仓模式溢价率"
          value={formatPercent(result.premiumRate)}
          hint={result.premiumRate >= 0 ? '价格高于当日预估净值' : '价格低于当日预估净值'}
          tone={premiumTone}
        />
        <MetricCard
          label="细模型修正"
          value={formatBps(result.learnedBiasReturn)}
          hint={`样本数 ${calibration.sampleCount}，平均绝对误差 ${formatPercent(calibration.meanAbsError)}`}
          tone={result.learnedBiasReturn >= 0 ? 'positive' : 'negative'}
        />
      </section>

      <section className="panel summary-strip summary-strip--stacked detail-time-strip">
        <div>
          <span>估值锚定净值日期</span>
          <strong>{scenario.navDate || '--'}</strong>
        </div>
        <div>
          <span>场内价格时间</span>
          <strong>{formatRuntimeTime(fund.runtime.marketDate, fund.runtime.marketTime)}</strong>
        </div>
        <div>
          <span>USD/CNY 时间</span>
          <strong>{fund.runtime.fx ? formatRuntimeTime(fund.runtime.fx.quoteDate, fund.runtime.fx.quoteTime) : '--'}</strong>
        </div>
        <div>
          <span>持仓报价时间</span>
          <strong>{formatRuntimeTime(fund.runtime.holdingsQuoteDate || '', fund.runtime.holdingsQuoteTime || '')}</strong>
        </div>
      </section>

      <section className="panel control-panel">
        <div className="panel__header">
          <h2>161128 细颗粒度估值实验室</h2>
          <p>主页日常只看自动溢价率。点进来后再用持仓、代理篮子和汇率细调 161128 的估值。</p>
        </div>
        <div className="control-grid">
          <label>
            <span>最近官方净值锚点</span>
            <input
              type="number"
              value={scenario.officialNavT1}
              step="0.0001"
              onChange={(event) =>
                updateScenario((current) => ({
                  ...current,
                  officialNavT1: Number(event.target.value) || 0,
                }))
              }
            />
          </label>
          <label>
            <span>场内现价</span>
            <input
              type="number"
              value={scenario.latestMarketPrice}
              step="0.0001"
              onChange={(event) =>
                updateScenario((current) => ({
                  ...current,
                  latestMarketPrice: Number(event.target.value) || 0,
                }))
              }
            />
          </label>
          <label>
            <span>USD/CNY 基准汇率</span>
            <input
              type="number"
              value={scenario.fx.baseRate}
              step="0.0001"
              onChange={(event) =>
                updateScenario((current) => ({
                  ...current,
                  fx: { ...current.fx, baseRate: Number(event.target.value) || 0 },
                }))
              }
            />
          </label>
          <label>
            <span>USD/CNY 当前汇率</span>
            <input
              type="number"
              value={scenario.fx.currentRate}
              step="0.0001"
              onChange={(event) =>
                updateScenario((current) => ({
                  ...current,
                  fx: { ...current.fx, currentRate: Number(event.target.value) || 0 },
                }))
              }
            />
          </label>
          <label>
            <span>人工修正</span>
            <input
              type="number"
              value={scenario.manualBiasBps}
              step="1"
              onChange={(event) =>
                updateScenario((current) => ({
                  ...current,
                  manualBiasBps: Number(event.target.value) || 0,
                }))
              }
            />
            <small>单位 bp，用来覆盖已知但尚未建模的偏差。</small>
          </label>
        </div>

        <div className="summary-strip">
          <div>
            <span>股票篮子收益</span>
            <strong>{formatPercent(result.stockBasketReturn)}</strong>
          </div>
          <div>
            <span>汇率变化</span>
            <strong>{formatPercent(result.fxReturn)}</strong>
          </div>
          <div>
            <span>日费用拖累</span>
            <strong>{formatBps(-result.feeDrag)}</strong>
          </div>
          <div>
            <span>人工修正</span>
            <strong>{formatBps(result.manualBiasReturn)}</strong>
          </div>
        </div>
      </section>

      <EditableHoldingsTable
        scenario={scenario}
        onHoldingChange={handleHoldingChange}
        onProxyChange={handleProxyChange}
      />

      <section className="panel split-panel">
        <div className="split-panel__column">
          <div className="panel__header">
            <h2>贡献拆解</h2>
            <p>每一项都是按净值权重贡献到整体估值，而不是只做简单平均。</p>
          </div>
          <div className="contribution-list">
            {result.contributions.map((item) => (
              <div className="contribution-row" key={item.key}>
                <div>
                  <strong>{item.label}</strong>
                  <span>{item.weight.toFixed(2)}% 权重</span>
                </div>
                <div>
                  <strong>{formatPercent(item.contributionReturn)}</strong>
                  <span>本地涨跌 {formatPercent(item.localReturn)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="split-panel__column">
          <div className="panel__header">
            <h2>细模型自学习</h2>
            <p>这里是 161128 单独的持仓模型，不和其他基金混用参数。</p>
          </div>

          <div className="learning-card">
            <label>
              <span>真实净值回填</span>
              <input
                type="number"
                value={actualNavInput}
                placeholder="例如 5.5128"
                step="0.0001"
                onChange={(event) => setActualNavInput(event.target.value)}
              />
            </label>
            <button type="button" onClick={handleLearn}>
              记录真实值并训练
            </button>
          </div>

          <div className="coefficient-grid">
            <div>
              <span>alpha</span>
              <strong>{formatBps(calibration.alpha)}</strong>
            </div>
            <div>
              <span>betaBasket</span>
              <strong>{calibration.betaBasket.toFixed(4)}</strong>
            </div>
            <div>
              <span>betaFx</span>
              <strong>{calibration.betaFx.toFixed(4)}</strong>
            </div>
            <div>
              <span>最近训练</span>
              <strong>{calibration.lastUpdatedAt ? new Date(calibration.lastUpdatedAt).toLocaleString() : '暂无'}</strong>
            </div>
          </div>
        </div>
      </section>
    </section>
  );
}

function HomePage({
  funds,
  syncedAt,
  loading,
  error,
  pageCategory,
  githubTraffic,
  trainingMetricsByCode,
}: {
  funds: FundViewModel[];
  syncedAt: string;
  loading: boolean;
  error: string;
  pageCategory: PageCategory;
  githubTraffic: GithubTrafficPayload;
  trainingMetricsByCode: Record<string, TrainingMetricSummary>;
}) {
  const pageOption = getPageOption(pageCategory);
  const visibleFunds = useMemo(() => funds.filter((item) => item.runtime.pageCategory === pageCategory), [funds, pageCategory]);
  const proxyDrivenCount = visibleFunds.filter((item) => item.runtime.estimateMode === 'proxy').length;
  const syncAgeHours = getHoursSinceSync(syncedAt);
  const untrainedCount = visibleFunds.filter((item) => !trainingMetricsByCode[item.runtime.code]).length;
  const uvSeries = githubTraffic.available ? githubTraffic.recent7.days.map((item) => item.viewUniques) : [];
  const uvSparkline = buildSparklinePoints(uvSeries, 120, 26);

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
          <div className="hero__fact">
            <span>累计访客</span>
            <strong id="busuanzi_value_site_uv">--</strong>
          </div>
          <div className="hero__fact">
            <span>页面浏览</span>
            <strong id="busuanzi_value_site_pv">--</strong>
          </div>
          <div className="hero__fact">
            <span>近7天访客</span>
            <strong>{githubTraffic.available ? githubTraffic.recent7.viewUniques : '--'}</strong>
            <small className="hero__fact-subtle">GitHub 仓库 UV</small>
            {uvSparkline ? (
              <svg className="traffic-mini-chart" viewBox="0 0 120 26" aria-hidden="true">
                <polyline points={uvSparkline} />
              </svg>
            ) : null}
          </div>
          <div className="hero__fact">
            <span>近7天浏览</span>
            <strong>{githubTraffic.available ? githubTraffic.recent7.viewCount : '--'}</strong>
            <small className="hero__fact-subtle">GitHub 仓库 PV</small>
          </div>
          <div className="hero__fact">
            <span>状态</span>
            <strong>{loading ? '同步中' : error ? '同步异常' : '可用'}</strong>
            <small className="hero__fact-subtle">本页未训练基金 {untrainedCount} 只</small>
          </div>
          <div className="hero__fact hero__fact--wide">
            <span>最近同步</span>
            <strong>{syncedAt ? formatDateTime(syncedAt) : '等待同步'}</strong>
            <small className="hero__fact-subtle">
              {githubTraffic.available ? `GitHub 访客更新时间 ${formatDateTime(githubTraffic.generatedAt)}` : 'GitHub 访客数据暂不可用'}
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
        formatCurrency={formatCurrency}
        formatPercent={formatPercent}
        title={pageOption.tableTitle}
        description={pageOption.tableDescription}
        pagePath={pageOption.path}
      />

      <section className="panel notice-panel">
        首页显示的是列表主看板。净值列展示最近一次已公布的官方净值，具体是 T-1 还是 T-2 直接看净值日期列；估值列展示的是当前预估净值。默认策略是“前十大持仓优先、代理篮子补足、汇率和误差修正联合驱动”；当持仓报价暂不可用时，会自动回退到代理篮子或场内信号。点击基金代码进入详情页后，可以看误差折线、净值误差、溢价率误差和历史估值口径；161128 还会额外显示持仓级估值实验室、前十大持仓公告、USD/CNY 时间和夜间美股持仓报价。
      </section>
    </main>
  );
}

function DetailPage({ funds, syncedAt, loading }: { funds: FundViewModel[]; syncedAt: string; loading: boolean }) {
  const params = useParams();
  const location = useLocation();
  const fundCode = params.code ?? '';
  const [offlineResearch, setOfflineResearch] = useState<OfflineResearchSummary | null>(null);
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

  if (loading) {
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
  const recentErrors = [...fund.journal.errors].slice(-20).reverse();
  const estimatedSeries = historyPoints.map((item) => ({ label: item.date, value: item.estimatedNav }));
  const actualSeries = historyPoints.map((item) => ({ label: item.date, value: item.actualNav }));
  const errorSeries = historyPoints.map((item) => ({ label: item.date, value: item.error }));
  const premiumTone = fund.estimate.premiumRate > 0 ? 'positive' : 'negative';
  const actualNavByDate = new Map(fund.runtime.navHistory.map((item) => [item.date, item.nav]));
  const errorByDate = new Map(fund.journal.errors.map((item) => [item.date, item]));
  const recentSnapshots = [...fund.journal.snapshots].slice(-20).reverse();
  const recentNavHistory = fund.runtime.navHistory.slice(0, 20);
  const top10WeightPercent = getTop10DisclosedWeightPercent(fund.runtime);
  const currentEstimateDate = fund.runtime.marketDate || fund.runtime.navDate;
  const currentSnapshot = recentSnapshots.find((item) => item.estimateDate === currentEstimateDate) ?? recentSnapshots[0];
  const adaptiveStatusEnabled = fund.runtime.code === '161725' && Boolean(currentSnapshot?.adaptiveUsed);
  const adaptiveShockTriggered = Boolean(currentSnapshot?.adaptiveShockTriggered);
  const showOfflineResearch = OFFLINE_RESEARCH_CODES.has(fund.runtime.code) && offlineResearch;
  const offlineChartVersion = offlineResearch?.generatedAt || syncedAt || Date.now().toString();

  return (
    <main className="page">
      {syncAgeHours !== null && syncAgeHours >= 12 ? (
        <section className="panel notice-panel">
          当前站点同步时间较旧，最新净值可能尚未刷新；这不是“更新中禁止查看”，而是部署或数据源还没产出更新。
        </section>
      ) : null}
      <section className="detail-header panel">
        <div>
          <Link className="back-link" to={backPath}>
            返回看板
          </Link>
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
            <span>场内现价时间</span>
            <strong>{formatRuntimeTime(fund.runtime.marketDate, fund.runtime.marketTime)}</strong>
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
        <MetricCard
          label="场内价格"
          value={formatCurrency(fund.runtime.marketPrice)}
          hint={formatRuntimeTime(fund.runtime.marketDate, fund.runtime.marketTime)}
          tone="neutral"
        />
        <MetricCard
          label="场内涨跌幅"
          value={formatPercent(getMarketChangeRate(fund.runtime))}
          hint={`昨收 ${formatCurrency(fund.runtime.previousClose)}`}
          tone={getMarketChangeRate(fund.runtime) >= 0 ? 'positive' : 'negative'}
        />
        <MetricCard
          label="自动溢价率"
          value={formatPercent(fund.estimate.premiumRate)}
          hint={fund.estimate.premiumRate >= 0 ? '价格高于当日预估净值' : '价格低于当日预估净值'}
          tone={premiumTone}
        />
      </section>

      <section className="panel summary-strip summary-strip--stacked">
        <div>
          <span>模型 MAE</span>
          <strong>{formatPercent(fund.model.meanAbsError)}</strong>
        </div>
        <div>
          <span>模型样本数</span>
          <strong>{fund.model.sampleCount}</strong>
        </div>
        {adaptiveStatusEnabled ? (
          <div>
            <span>当日波动修正</span>
            <strong className={adaptiveShockTriggered ? 'tone-positive' : 'muted-text'}>{adaptiveShockTriggered ? '已触发极端分支' : '未触发（常规分支）'}</strong>
          </div>
        ) : null}
      </section>

      <section className="panel split-panel">
        <div className="split-panel__column">
          <div className="panel__header">
            <h2>自动模型说明</h2>
            <p>{driverLabels.summary} 它估的是“以最近官方净值为锚的当日预估净值”，不是已经公布出来的官方净值本身。</p>
          </div>
          <div className="coefficient-grid">
            <div>
              <span>alpha</span>
              <strong>{formatBps(fund.model.alpha)}</strong>
            </div>
            <div>
              <span>betaLead</span>
              <strong>{fund.model.betaLead.toFixed(4)}</strong>
            </div>
            <div>
              <span>betaGap</span>
              <strong>{fund.model.betaGap.toFixed(4)}</strong>
            </div>
            <div>
              <span>{driverLabels.primaryFactor}</span>
              <strong>{formatPercent(fund.estimate.leadReturn)}</strong>
            </div>
            <div>
              <span>{driverLabels.secondaryFactor}</span>
              <strong>{formatPercent(fund.estimate.closeGapReturn)}</strong>
            </div>
            <div>
              <span>最近训练</span>
              <strong>{fund.model.lastUpdatedAt ? formatDateTime(fund.model.lastUpdatedAt) : '暂无'}</strong>
            </div>
          </div>
        </div>
        <div className="split-panel__column">
          <div className="panel__header">
            <h2>误差入口</h2>
            <p>这里同时看净值误差和溢价率误差。净值误差口径为 估值 / 真实净值 - 1；已结算日期的场内价会尽量切到该日收盘参考价。</p>
          </div>
          <div className="summary-strip summary-strip--stacked">
            <div>
              <span>历史已结算样本</span>
              <strong>{fund.journal.errors.length}</strong>
            </div>
            <div>
              <span>最近估值误差</span>
              <strong>{historyPoints.length > 0 ? formatPercent(historyPoints[historyPoints.length - 1].error) : '--'}</strong>
            </div>
          </div>
        </div>
      </section>

      <section className="mini-data-grid">
        {fund.runtime.estimateMode === 'proxy' && recentProxyQuotes.length > 0 ? (
          <section className="chart-card">
            <div className="chart-card__header">
              <h3>代理篮子</h3>
              <div className="muted-text">{fund.runtime.proxyBasketName || '代理篮子'} {formatRuntimeTime(fund.runtime.proxyQuoteDate || '', fund.runtime.proxyQuoteTime || '')}</div>
            </div>
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

        <section className="chart-card">
          <div className="chart-card__header">
            <h3>最近估值记录</h3>
            <div className="muted-text">未结算日期显示当时快照价；已结算日期会优先改用该日收盘参考价，并同步计算净值误差与溢价率误差</div>
          </div>
          {recentSnapshots.length > 0 ? (
            <div className="table-scroll table-scroll--window">
              <table className="mini-data-table">
                <thead>
                  <tr>
                    <th>估值日期</th>
                    <th>估值</th>
                    <th>参考场内价</th>
                    <th>价格口径</th>
                    <th>对应真实净值</th>
                    <th>净值误差</th>
                    <th>溢价率误差</th>
                    <th>状态</th>
                  </tr>
                </thead>
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
                        <td>{formatCurrency(item.estimatedNav)}</td>
                        <td>{formatCurrency(item.marketPrice)}</td>
                        <td>{item.marketPriceType === 'close' ? '收盘' : '快照'}</td>
                        <td>{formatOptionalCurrency(actualNav)}</td>
                        <td className={typeof estimateError === 'number' ? (estimateError >= 0 ? 'tone-positive' : 'tone-negative') : 'muted-text'}>
                          {typeof estimateError === 'number' ? formatPercent(estimateError) : '--'}
                        </td>
                        <td className={typeof premiumError === 'number' ? (premiumError >= 0 ? 'tone-positive' : 'tone-negative') : 'muted-text'}>
                          {typeof premiumError === 'number' ? formatPercent(premiumError) : '--'}
                        </td>
                        <td className={hasActual ? 'tone-positive' : 'muted-text'}>{hasActual ? '已结算' : '待净值'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="mini-data-empty">还没有历史估值记录。</div>
          )}
        </section>

        <section className="chart-card">
          <div className="chart-card__header">
            <h3>最近误差记录</h3>
            <div className="muted-text">净值误差口径为 估值 / 真实净值 - 1；溢价率误差口径为 估算溢价率 - 实际收盘溢价率</div>
          </div>
          {recentErrors.length > 0 ? (
            <div className="table-scroll table-scroll--window">
              <table className="mini-data-table">
                <thead>
                  <tr>
                    <th>结算日期</th>
                    <th>参考场内价</th>
                    <th>估值</th>
                    <th>真实净值</th>
                    <th>净值误差</th>
                    <th>估算溢价率</th>
                    <th>实际收盘溢价率</th>
                    <th>溢价率误差</th>
                  </tr>
                </thead>
                <tbody>
                  {recentErrors.map((item) => (
                    <tr key={item.date}>
                      <td>{item.date}</td>
                      <td>{formatOptionalCurrency(item.marketPrice)}</td>
                      <td>{formatCurrency(item.estimatedNav)}</td>
                      <td>{formatCurrency(item.actualNav)}</td>
                      <td className={item.error >= 0 ? 'tone-positive' : 'tone-negative'}>{formatPercent(item.error)}</td>
                      <td className={item.premiumRate >= 0 ? 'tone-positive' : 'tone-negative'}>{formatPercent(item.premiumRate)}</td>
                      <td className={(item.actualPremiumRate ?? 0) >= 0 ? 'tone-positive' : 'tone-negative'}>{typeof item.actualPremiumRate === 'number' ? formatPercent(item.actualPremiumRate) : '--'}</td>
                      <td className={(item.premiumError ?? 0) >= 0 ? 'tone-positive' : 'tone-negative'}>{typeof item.premiumError === 'number' ? formatPercent(item.premiumError) : '--'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="mini-data-empty">还没有已结算的误差记录。</div>
          )}
        </section>

        <section className="chart-card">
          <div className="chart-card__header">
            <h3>最近抓到的官方净值</h3>
            <div className="muted-text">这里展示同步脚本当前抓到的最近一个多月净值</div>
          </div>
          <div className="table-scroll table-scroll--window">
            <table className="mini-data-table">
              <thead>
                <tr>
                  <th>净值日期</th>
                  <th>官方净值</th>
                </tr>
              </thead>
              <tbody>
                {recentNavHistory.map((item) => (
                  <tr key={item.date}>
                    <td>{item.date}</td>
                    <td>{formatCurrency(item.nav)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
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

      {fund.runtime.detailMode === 'holdings' ? <DetailedEstimatorPanel fund={fund} /> : null}
    </main>
  );
}

export default function App() {
  const [funds, setFunds] = useState<FundViewModel[]>([]);
  const [syncedAt, setSyncedAt] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [githubTraffic, setGithubTraffic] = useState<GithubTrafficPayload>(DEFAULT_GITHUB_TRAFFIC);
  const [trainingMetricsByCode, setTrainingMetricsByCode] = useState<Record<string, TrainingMetricSummary>>({});

  useEffect(() => {
    let active = true;

    async function loadRuntime() {
      setLoading(true);
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
          const estimate = estimateWatchlistFund(runtime, reconciled.model);
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
        if (active) {
          setLoading(false);
        }
      }
    }

    void loadRuntime();

    let timer = window.setTimeout(function scheduleNext() {
      void loadRuntime().finally(() => {
        timer = window.setTimeout(scheduleNext, getRuntimeRefreshInterval());
      });
    }, getRuntimeRefreshInterval());

    return () => {
      active = false;
      window.clearTimeout(timer);
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

    async function loadGithubTraffic() {
      try {
        const response = await fetch(`generated/github-traffic.json?ts=${Date.now()}`);
        if (!response.ok) {
          throw new Error(`访客数据读取失败: ${response.status}`);
        }

        const payload = (await response.json()) as GithubTrafficPayload;
        if (active) {
          setGithubTraffic({ ...DEFAULT_GITHUB_TRAFFIC, ...payload });
        }
      } catch {
        if (active) {
          setGithubTraffic(DEFAULT_GITHUB_TRAFFIC);
        }
      }
    }

    void loadGithubTraffic();
    const timer = window.setInterval(() => {
      void loadGithubTraffic();
    }, 60 * 60 * 1000);

    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  return (
    <div className="app-shell">
      <div className="background-orb background-orb--amber" />
      <div className="background-orb background-orb--teal" />
      <AppErrorBoundary>
        <Routes>
          <Route path="/" element={<Navigate to="/qdii-lof" replace />} />
          <Route path="/domestic-lof" element={<HomePage funds={funds} syncedAt={syncedAt} loading={loading} error={error} pageCategory="domestic-lof" githubTraffic={githubTraffic} trainingMetricsByCode={trainingMetricsByCode} />} />
          <Route path="/qdii-lof" element={<HomePage funds={funds} syncedAt={syncedAt} loading={loading} error={error} pageCategory="qdii-lof" githubTraffic={githubTraffic} trainingMetricsByCode={trainingMetricsByCode} />} />
          <Route path="/etf" element={<HomePage funds={funds} syncedAt={syncedAt} loading={loading} error={error} pageCategory="etf" githubTraffic={githubTraffic} trainingMetricsByCode={trainingMetricsByCode} />} />
          <Route path="/detail/:code" element={<DetailPage funds={funds} syncedAt={syncedAt} loading={loading} />} />
          <Route path="/fund/:code" element={<DetailPage funds={funds} syncedAt={syncedAt} loading={loading} />} />
          <Route path="*" element={<Navigate to="/qdii-lof" replace />} />
        </Routes>
      </AppErrorBoundary>
    </div>
  );
}
