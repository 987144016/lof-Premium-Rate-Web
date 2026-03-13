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
import type { CalibrationModel, FundJournal, FundRuntimeData, FundScenario, FundViewModel, PageCategory, RuntimePayload, WatchlistModel } from './types';

const DETAIL_CALIBRATION_PREFIX = 'premium-estimator:detailed-calibration:';
const FAST_SYNC_INTERVAL = 60_000;
const SLOW_SYNC_INTERVAL = 15 * 60_000;
const MULTI_ALGO_CODES = new Set(['161128', '160719', '160723']);
const PAGE_OPTIONS: Array<{ key: PageCategory; path: string; label: string; lead: string; tableTitle: string; tableDescription: string }> = [
  {
    key: 'qdii-lof',
    path: '/qdii-lof',
    label: 'QDII 的 LOF',
    lead: 'QDII 官方净值通常会慢一个到两个交易日，具体以净值日期列为准。本页默认按海外代理篮子和 USD/CNY 变化推算；像 501312 这类已接入季度前十大基金/ETF 持仓的品种，会优先按持仓与汇率变化估值。',
    tableTitle: 'QDII LOF 列表',
    tableDescription: '本页预估口径默认是 最近官方净值锚点 + 海外代理篮子涨跌幅 + USD/CNY 变化；若该基金已接入可报价的最新海外持仓，则改为持仓优先。点击表头可排序。',
  },
  {
    key: 'domestic-lof',
    path: '/domestic-lof',
    label: '国内 LOF',
    lead: '这一页放国内 LOF 和联接 LOF。有前十大持仓报价时，优先按持仓涨跌幅推算当日净值；拿不到持仓报价时，再回退到场内日内信号。像白银这类商品 LOF 则继续改用对应海外代理品种和汇率推算。',
    tableTitle: '国内 LOF 列表',
    tableDescription: '国内 LOF 当前口径是：优先用前十大持仓涨跌幅估值，拿不到持仓再回退到场内信号；商品类例外继续用代理品种。点击表头可排序。',
  },
  {
    key: 'etf',
    path: '/etf',
    label: 'ETF 类',
    lead: '这一页单独放 ETF 类基金。当前纳入的 ETF 都是跨境品种，所以同样按海外代理篮子和 USD/CNY 变化推算净值，场内价格只负责显示溢价率。',
    tableTitle: 'ETF 类列表',
    tableDescription: 'ETF 页当前以跨境 ETF 为主，预估净值按海外代理篮子和汇率推算，场内价格不参与净值驱动。点击表头可排序。',
  },
];

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
  return runtime.disclosedHoldings?.length && runtime.holdingQuotes?.length
    ? {
        summary: '该基金当前优先按最近披露前十大持仓的盘中涨跌幅推算净值；海外持仓会同步计入 USD/CNY 变化，场内价格只用于计算溢价率。',
        primaryFactor: '前十大持仓涨跌幅',
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

function HomePage({ funds, syncedAt, loading, error, pageCategory }: { funds: FundViewModel[]; syncedAt: string; loading: boolean; error: string; pageCategory: PageCategory }) {
  const pageOption = getPageOption(pageCategory);
  const visibleFunds = useMemo(() => funds.filter((item) => item.runtime.pageCategory === pageCategory), [funds, pageCategory]);
  const proxyDrivenCount = visibleFunds.filter((item) => item.runtime.estimateMode === 'proxy').length;
  const syncAgeHours = getHoursSinceSync(syncedAt);

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
            <span>状态</span>
            <strong>{loading ? '同步中' : error ? '同步异常' : '可用'}</strong>
          </div>
          <div className="hero__fact hero__fact--wide">
            <span>最近同步</span>
            <strong>{syncedAt ? formatDateTime(syncedAt) : '等待同步'}</strong>
          </div>
        </div>
        <div className="hero__note">
          <strong>公告栏</strong>
          <p>
            本页面仅用于基金溢价率观察与估值研究，不构成任何投资建议，也不保证数据实时、完整或绝对准确。
          </p>
          <div className="hero__bulletins">
            <p>限购状态暂时不准，请忽略，具体以基金公司公告和销售页面为准。</p>
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
        formatCurrency={formatCurrency}
        formatPercent={formatPercent}
        title={pageOption.tableTitle}
        description={pageOption.tableDescription}
        pagePath={pageOption.path}
      />

      <section className="panel notice-panel">
        首页显示的是列表主看板。净值列展示最近一次已公布的官方净值，具体是 T-1 还是 T-2 直接看净值日期列；估值列展示的是当前预估净值。国内 LOF 现在已经切到“前十大持仓优先，拿不到再回退场内信号”，QDII 和跨境 ETF 页面默认按海外代理篮子加汇率驱动；像 501312 这种已经接入季度前十大基金/ETF 持仓的品种，则会优先按持仓与汇率变化估值。点击基金代码进入详情页后，可以看误差折线、净值误差、溢价率误差和历史估值口径；161128 还会额外显示持仓级估值实验室、前十大持仓公告、USD/CNY 时间和夜间美股持仓报价。
      </section>
    </main>
  );
}

function DetailPage({ funds, syncedAt, loading }: { funds: FundViewModel[]; syncedAt: string; loading: boolean }) {
  const params = useParams();
  const location = useLocation();
  const fund = funds.find((item) => item.runtime.code === params.code);
  const syncAgeHours = getHoursSinceSync(syncedAt);

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
  const showMultiAlgoBoard = MULTI_ALGO_CODES.has(fund.runtime.code);
  const algoScores = showMultiAlgoBoard ? computeAlgoScores(fund) : [];

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
      </section>

      {showMultiAlgoBoard ? (
        <section className="chart-card">
          <div className="chart-card__header">
            <h3>多算法并行观察（内测）</h3>
            <div className="muted-text">阶段目标：单基金日估值误差 &lt; 1%，长期目标 0.1%。当前按近30天平均误差优先排序。</div>
          </div>
          <div className="table-scroll">
            <table className="mini-data-table">
              <thead>
                <tr>
                  <th>算法</th>
                  <th>当前估值</th>
                  <th>当前溢价率</th>
                  <th>近30天 MAE</th>
                  <th>全样本 MAE</th>
                  <th>近7样本 MAE</th>
                  <th>样本数</th>
                  <th>参数 (alpha / betaLead / betaGap)</th>
                </tr>
              </thead>
              <tbody>
                {algoScores.map((item, index) => (
                  <tr key={item.variant.key}>
                    <td>{index === 0 ? `#1 ${item.variant.label}` : item.variant.label}</td>
                    <td>{formatCurrency(item.estimatedNav)}</td>
                    <td className={item.premiumRate >= 0 ? 'tone-positive' : 'tone-negative'}>{formatPercent(item.premiumRate)}</td>
                    <td>{Number.isFinite(item.mae30) ? formatPercent(item.mae30) : '--'}</td>
                    <td>{Number.isFinite(item.maeAll) ? formatPercent(item.maeAll) : '--'}</td>
                    <td>{Number.isFinite(item.maeRecent) ? formatPercent(item.maeRecent) : '--'}</td>
                    <td>{item.sampleCount}</td>
                    <td>{`${item.variant.alpha.toFixed(4)} / ${item.variant.betaLead.toFixed(4)} / ${item.variant.betaGap.toFixed(4)}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

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
            <div className="table-scroll">
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
                {fund.runtime.holdingsQuoteDate ? `，行情时间 ${formatRuntimeTime(fund.runtime.holdingsQuoteDate, fund.runtime.holdingsQuoteTime || '')}` : ''}
              </div>
            </div>
            <div className="table-scroll">
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
            <div className="table-scroll">
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
            <div className="table-scroll">
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
          <div className="table-scroll">
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

  return (
    <div className="app-shell">
      <div className="background-orb background-orb--amber" />
      <div className="background-orb background-orb--teal" />
      <AppErrorBoundary>
        <Routes>
          <Route path="/" element={<Navigate to="/qdii-lof" replace />} />
          <Route path="/domestic-lof" element={<HomePage funds={funds} syncedAt={syncedAt} loading={loading} error={error} pageCategory="domestic-lof" />} />
          <Route path="/qdii-lof" element={<HomePage funds={funds} syncedAt={syncedAt} loading={loading} error={error} pageCategory="qdii-lof" />} />
          <Route path="/etf" element={<HomePage funds={funds} syncedAt={syncedAt} loading={loading} error={error} pageCategory="etf" />} />
          <Route path="/detail/:code" element={<DetailPage funds={funds} syncedAt={syncedAt} loading={loading} />} />
          <Route path="/fund/:code" element={<DetailPage funds={funds} syncedAt={syncedAt} loading={loading} />} />
          <Route path="*" element={<Navigate to="/qdii-lof" replace />} />
        </Routes>
      </AppErrorBoundary>
    </div>
  );
}
