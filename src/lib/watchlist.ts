import type {
  FundErrorPoint,
  FundEstimateSnapshot,
  FundJournal,
  FundRuntimeData,
  HoldingQuote,
  WatchlistEstimateResult,
  WatchlistModel,
} from '../types';

const DEFAULT_LEARNING_RATE = 0.24;
const DEFAULT_BETA_LEAD = 0.38;
const DEFAULT_BETA_INTRADAY = 0.05;
const DEFAULT_BETA_INTRADAY_MIN = 0.001;
const DEFAULT_BETA_INTRADAY_MAX = 0.3;
const MAX_MARKET_MOVE = 0.08;
const MAX_PROXY_MOVE = 0.15;
const MAX_CLOSE_GAP = 0.2;
const MAX_FX_MOVE = 0.05;
const MAX_INTRADAY_MOVE = 0.08;
const STALE_LEAD_REPEAT_EPSILON = 1e-6;
const STALE_LEAD_SIGNAL_THRESHOLD = 0.015;
const STALE_LEAD_PROXY_BLEND = 0.65;
const STALE_LEAD_CLAMP = 0.02;
const JOURNAL_RETENTION_DAYS = 90;
const GOLD_REALTIME_PROXY_CODES = new Set(['160719', '161116', '164701', '161226']);
const GOLD_CONTINUOUS_FACTOR_WEIGHT_BY_CODE: Record<string, number> = {
  '160719': 0.7,
  '161116': 0.65,
  '164701': 0.65,
  '161226': 0.65,
};
const GOLD_CONTINUOUS_FACTOR_MAX_MOVE = 0.08;
const GOLD_CONTINUOUS_FACTOR_ANOMALY_MOVE = 0.12;
const GOLD_CLOSE_FORCE_TIME = '15:00:00';
const GOLD_CLOSE_FORCE_MIN_DROP = -0.08;
const GOLD_CLOSE_FORCE_MARKET_WEIGHT = 0.96;
const HOLDINGS_SIGNAL_MIN_COVERAGE_BY_CODE: Record<string, number> = {
  '513310': 0.55,
  '161128': 0.7,
};

// 原油类基金学习配置：通过历史误差自动调整期货权重
const OIL_CONTINUOUS_CODES = new Set(['160723', '501018', '161129']);
const OIL_CONTINUOUS_FACTOR_INIT_WEIGHT_BY_CODE: Record<string, number> = {
  '160723': 0.4,  // 初始权重，会被学习覆盖
  '501018': 0.35,
  '161129': 0.35,
};
const OIL_CONTINUOUS_FACTOR_MAX_MOVE = 0.15;
const OIL_CONTINUOUS_FACTOR_ANOMALY_MOVE = 0.25;
const OIL_ADAPTIVE_LEARNING_BY_CODE: Record<string, { weight: number; learningRate: number; sampleCount: number }> = {
  '160723': { weight: 0.4, learningRate: 0.15, sampleCount: 0 },
  '501018': { weight: 0.35, learningRate: 0.15, sampleCount: 0 },
  '161129': { weight: 0.35, learningRate: 0.15, sampleCount: 0 },
};

function clamp(value: number, limit: number): number {
  return Math.max(-limit, Math.min(limit, value));
}

function getWeightedProxyReturn(runtime: FundRuntimeData): number {
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

function getHoldingLineReturn(item: HoldingQuote): number {
  if (!item || item.previousClose <= 0) {
    return 0;
  }

  return item.currentPrice / item.previousClose - 1;
}

function getWeightedHoldingReturn(runtime: FundRuntimeData): number {
  const disclosedHoldings = runtime.disclosedHoldings ?? [];
  const holdingQuotes = runtime.holdingQuotes ?? [];
  const disclosedByTicker = new Map(disclosedHoldings.map((item) => [item.ticker.toUpperCase(), item]));
  const weightedQuotes = holdingQuotes
    .map((item) => {
      const disclosed = disclosedByTicker.get(item.ticker.toUpperCase());
      if (!disclosed || !disclosed.weight || item.previousClose <= 0) {
        return null;
      }

      return {
        weight: disclosed.weight,
        localReturn: getHoldingLineReturn(item),
      };
    })
    .filter((item): item is { weight: number; localReturn: number } => Boolean(item));

  const totalWeight = weightedQuotes.reduce((sum, item) => sum + item.weight, 0);
  if (totalWeight <= 0) {
    return 0;
  }

  return weightedQuotes.reduce((sum, item) => sum + item.localReturn * (item.weight / totalWeight), 0);
}

function getAnnouncedHoldingsCoverageWeight(runtime: FundRuntimeData): number {
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

  return Math.max(0, Math.min(1, coveredWeight / 100));
}

function hasAnnouncedHoldingsSignal(runtime: FundRuntimeData): boolean {
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

  return coveredCount >= Math.min(3, requiredCount) && getAnnouncedHoldingsCoverageWeight(runtime) >= minCoverage;
}

function getBlendedLeadReturn(runtime: FundRuntimeData): number {
  const holdingsCoverage = getAnnouncedHoldingsCoverageWeight(runtime);
  const holdingsReturn = getWeightedHoldingReturn(runtime);
  const proxyReturn = getWeightedProxyReturn(runtime);
  const proxyWeight = runtime.estimateMode === 'proxy' ? 1 - holdingsCoverage : 0;

  return holdingsReturn * (1 - proxyWeight) + proxyReturn * proxyWeight;
}

function hasUsdHoldingSignal(runtime: FundRuntimeData): boolean {
  return (runtime.holdingQuotes ?? []).some((item) => item.currency === 'USD');
}

function getFxReturn(runtime: FundRuntimeData): number {
  const currentRate = runtime.fx?.currentRate ?? 0;
  const previousCloseRate = runtime.fx?.previousCloseRate ?? 0;
  return currentRate > 0 && previousCloseRate > 0 ? currentRate / previousCloseRate - 1 : 0;
}

function protectStaleLeadSignal(
  runtime: FundRuntimeData,
  rawLeadReturn: number,
  useHoldingsEstimate: boolean,
  useProxyEstimate: boolean,
  journal?: FundJournal,
): number {
  if (!useHoldingsEstimate || useProxyEstimate) {
    return rawLeadReturn;
  }

  if (Math.abs(rawLeadReturn) < STALE_LEAD_SIGNAL_THRESHOLD) {
    return rawLeadReturn;
  }

  const snapshots = Array.isArray(journal?.snapshots) ? journal.snapshots : [];
  const recent = snapshots.slice(-2).filter((item) => Number.isFinite(item?.leadReturn));
  if (recent.length < 2) {
    return rawLeadReturn;
  }

  const lastLead = recent[recent.length - 1].leadReturn;
  const prevLead = recent[recent.length - 2].leadReturn;
  const repeated = Math.abs(lastLead - prevLead) <= STALE_LEAD_REPEAT_EPSILON
    && Math.abs(rawLeadReturn - lastLead) <= STALE_LEAD_REPEAT_EPSILON;
  if (!repeated) {
    return rawLeadReturn;
  }

  const proxyReturn = getWeightedProxyReturn(runtime);
  const blended = rawLeadReturn * (1 - STALE_LEAD_PROXY_BLEND) + proxyReturn * STALE_LEAD_PROXY_BLEND;
  return clamp(blended, STALE_LEAD_CLAMP);
}

function blendGoldContinuousLeadReturn(runtime: FundRuntimeData, baseLeadReturn: number, useProxyEstimate: boolean): number {
  if (!useProxyEstimate || !GOLD_REALTIME_PROXY_CODES.has(runtime.code)) {
    return baseLeadReturn;
  }

  const rawContinuous = Number(runtime.goldContinuousReturn);
  if (!Number.isFinite(rawContinuous) || Math.abs(rawContinuous) > GOLD_CONTINUOUS_FACTOR_ANOMALY_MOVE) {
    return baseLeadReturn;
  }

  const weightRaw = Number(GOLD_CONTINUOUS_FACTOR_WEIGHT_BY_CODE[runtime.code]);
  const weight = Number.isFinite(weightRaw) ? Math.max(0, Math.min(0.9, weightRaw)) : 0;
  if (!(weight > 0)) {
    return baseLeadReturn;
  }

  const continuous = clamp(rawContinuous, GOLD_CONTINUOUS_FACTOR_MAX_MOVE);
  return baseLeadReturn * (1 - weight) + continuous * weight;
}

function blendOilContinuousLeadReturn(runtime: FundRuntimeData, baseLeadReturn: number, useProxyEstimate: boolean): number {
  if (!useProxyEstimate || !OIL_CONTINUOUS_CODES.has(runtime.code)) {
    return baseLeadReturn;
  }

  const rawContinuous = Number(runtime.oilContinuousReturn);
  if (!Number.isFinite(rawContinuous) || Math.abs(rawContinuous) > OIL_CONTINUOUS_FACTOR_ANOMALY_MOVE) {
    return baseLeadReturn;
  }

  const adaptiveModel = OIL_ADAPTIVE_LEARNING_BY_CODE[runtime.code];
  if (!adaptiveModel) {
    return baseLeadReturn;
  }

  const weight = Math.max(0, Math.min(0.9, adaptiveModel.weight));
  if (!(weight > 0)) {
    return baseLeadReturn;
  }

  const continuous = clamp(rawContinuous, OIL_CONTINUOUS_FACTOR_MAX_MOVE);
  return baseLeadReturn * (1 - weight) + continuous * weight;
}

function applyGoldCloseForceImpliedReturn(runtime: FundRuntimeData, impliedReturn: number): number {
  if (!GOLD_REALTIME_PROXY_CODES.has(runtime.code)) {
    return impliedReturn;
  }

  const marketTime = String(runtime.marketTime || '');
  if (!marketTime || marketTime < GOLD_CLOSE_FORCE_TIME) {
    return impliedReturn;
  }

  if (!(runtime.marketPrice > 0) || !(runtime.previousClose > 0)) {
    return impliedReturn;
  }

  const marketReturn = runtime.marketPrice / runtime.previousClose - 1;
  if (!Number.isFinite(marketReturn) || marketReturn >= 0) {
    return impliedReturn;
  }

  const floorByMarket = Math.min(-0.0001, marketReturn * GOLD_CLOSE_FORCE_MARKET_WEIGHT);
  const forcedFloor = Math.min(floorByMarket, GOLD_CLOSE_FORCE_MIN_DROP);
  return Math.min(impliedReturn, forcedFloor);
}

function toIsoDateWithOffset(days: number): string {
  const value = new Date();
  value.setDate(value.getDate() + days);
  return value.toISOString().slice(0, 10);
}

function getSnapshotPriceType(runtime: FundRuntimeData): 'intraday' | 'close' {
  return runtime.pageCategory === 'domestic-lof' && runtime.marketTime >= '15:00:00' ? 'close' : 'intraday';
}

function finalizeSnapshotWithClose(snapshot: FundEstimateSnapshot, runtime: FundRuntimeData): FundEstimateSnapshot {
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

function pruneJournal(journal: FundJournal): FundJournal {
  const cutoffDate = toIsoDateWithOffset(-JOURNAL_RETENTION_DAYS);

  return {
    snapshots: journal.snapshots.filter((item) => item.estimateDate >= cutoffDate),
    errors: journal.errors.filter((item) => item.date >= cutoffDate),
  };
}

export function getDefaultWatchlistModel(): WatchlistModel {
  return {
    alpha: 0,
    betaLead: DEFAULT_BETA_LEAD,
    betaGap: 0,
    betaIntraday: DEFAULT_BETA_INTRADAY,
    learningRate: DEFAULT_LEARNING_RATE,
    sampleCount: 0,
    meanAbsError: 0,
  };
}

export function getDefaultJournal(): FundJournal {
  return {
    snapshots: [],
    errors: [],
  };
}

export function estimateWatchlistFund(
  runtime: FundRuntimeData,
  model: WatchlistModel,
  journal?: FundJournal,
): WatchlistEstimateResult {
  const anchorNav = runtime.officialNavT1;
  const useHoldingsEstimate = hasAnnouncedHoldingsSignal(runtime);
  const useProxyEstimate = runtime.estimateMode === 'proxy' && !useHoldingsEstimate;
  
  // 计算当日涨跌幅 (仅用于国内LOF，海外QDII不用)
  const enableIntradayFactor = runtime.pageCategory === 'domestic-lof' && !useProxyEstimate;
  const intradayReturn = enableIntradayFactor && runtime.previousClose > 0
    ? runtime.marketPrice / runtime.previousClose - 1
    : 0;
  const clampedIntradayReturn = clamp(intradayReturn, MAX_INTRADAY_MOVE);
  
  const modeLeadReturn = useProxyEstimate
    ? getWeightedProxyReturn(runtime)
    : useHoldingsEstimate
      ? getBlendedLeadReturn(runtime)
      : runtime.previousClose > 0
        ? runtime.marketPrice / runtime.previousClose - 1
        : 0;
  const goldBlendedReturn = blendGoldContinuousLeadReturn(runtime, modeLeadReturn, useProxyEstimate);
  const rawLeadReturn = blendOilContinuousLeadReturn(runtime, goldBlendedReturn, useProxyEstimate);
  const stabilizedLeadReturn = protectStaleLeadSignal(runtime, rawLeadReturn, useHoldingsEstimate, useProxyEstimate, journal);
  const leadReturn = clamp(stabilizedLeadReturn, useProxyEstimate ? MAX_PROXY_MOVE : MAX_MARKET_MOVE);
  const rawCloseGapReturn = useProxyEstimate
    ? getFxReturn(runtime)
    : useHoldingsEstimate
      ? hasUsdHoldingSignal(runtime) || (runtime.estimateMode === 'proxy' && (runtime.proxyQuotes?.length ?? 0) > 0)
        ? getFxReturn(runtime)
        : 0
      : anchorNav > 0 && runtime.previousClose > 0
        ? runtime.previousClose / anchorNav - 1
        : 0;
  const closeGapReturn = clamp(rawCloseGapReturn, useProxyEstimate ? MAX_FX_MOVE : MAX_CLOSE_GAP);
  const learnedBiasReturn = model.alpha;
  const betaIntra = enableIntradayFactor ? (model.betaIntraday ?? DEFAULT_BETA_INTRADAY) : 0;
  const rawImpliedReturn = learnedBiasReturn + model.betaLead * leadReturn + model.betaGap * closeGapReturn + betaIntra * clampedIntradayReturn;
  const impliedReturn = applyGoldCloseForceImpliedReturn(runtime, rawImpliedReturn);
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

export function reconcileJournal(
  runtime: FundRuntimeData,
  currentModel: WatchlistModel,
  currentJournal: FundJournal,
): { model: WatchlistModel; journal: FundJournal } {
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
      
      // 计算当日涨跌幅用于训练 betaIntraday
      const intradayReturn = snapshot.intradayReturn ?? 0;
      const nextBetaIntraday = model.betaIntraday + adaptiveRate * residualError * intradayReturn;
      // 约束 betaIntraday 在合理范围内
      const clampedBetaIntraday = Math.max(DEFAULT_BETA_INTRADAY_MIN, Math.min(DEFAULT_BETA_INTRADAY_MAX, nextBetaIntraday));

      model = {
        ...model,
        alpha: model.alpha + adaptiveRate * residualError,
        betaLead: model.betaLead + adaptiveRate * residualError * snapshot.leadReturn,
        betaGap: model.betaGap + adaptiveRate * residualError * snapshot.closeGapReturn,
        betaIntraday: clampedBetaIntraday,
        sampleCount: nextSampleCount,
        meanAbsError: nextMae,
        lastUpdatedAt: new Date().toISOString(),
      };
      trainedDates.add(snapshot.estimateDate);
    }

    const errorPoint: FundErrorPoint = {
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
    };

    errorByDate.set(snapshot.estimateDate, errorPoint);
  }

  const nextErrors = [...errorByDate.values()].sort((left, right) => left.date.localeCompare(right.date));

  return {
    model,
    journal: pruneJournal({
      ...baseJournal,
      errors: nextErrors,
    }),
  };
}

export function recordEstimateSnapshot(
  journal: FundJournal,
  runtime: FundRuntimeData,
  estimate: WatchlistEstimateResult,
): FundJournal {
  const estimateDate = runtime.marketDate || new Date().toISOString().slice(0, 10);
  // 计算当日涨跌幅用于保存到快照
  const intradayReturn = runtime.pageCategory === 'domestic-lof' && runtime.previousClose > 0
    ? runtime.marketPrice / runtime.previousClose - 1
    : undefined;
  
  const nextSnapshot: FundEstimateSnapshot = {
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
    intradayReturn,
    impliedReturn: estimate.impliedReturn,
    createdAt: new Date().toISOString(),
  };

  return pruneJournal({
    ...journal,
    snapshots: [...(journal.snapshots ?? []).filter((item) => item.estimateDate !== estimateDate), nextSnapshot].sort((left, right) => left.estimateDate.localeCompare(right.estimateDate)),
  });
}
