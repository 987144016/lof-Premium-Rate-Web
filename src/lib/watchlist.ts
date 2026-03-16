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
const MAX_MARKET_MOVE = 0.08;
const MAX_PROXY_MOVE = 0.15;
const MAX_CLOSE_GAP = 0.2;
const MAX_FX_MOVE = 0.05;
const JOURNAL_RETENTION_DAYS = 90;
const HOLDINGS_SIGNAL_MIN_COVERAGE_BY_CODE: Record<string, number> = {
  '513310': 0.55,
  '161128': 0.7,
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
): WatchlistEstimateResult {
  const anchorNav = runtime.officialNavT1;
  const useHoldingsEstimate = hasAnnouncedHoldingsSignal(runtime);
  const useProxyEstimate = runtime.estimateMode === 'proxy' && !useHoldingsEstimate;
  const rawLeadReturn = useProxyEstimate
    ? getWeightedProxyReturn(runtime)
    : useHoldingsEstimate
      ? getBlendedLeadReturn(runtime)
      : runtime.previousClose > 0
        ? runtime.marketPrice / runtime.previousClose - 1
        : 0;
  const leadReturn = clamp(rawLeadReturn, useProxyEstimate ? MAX_PROXY_MOVE : MAX_MARKET_MOVE);
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
    impliedReturn: estimate.impliedReturn,
    createdAt: new Date().toISOString(),
  };

  return pruneJournal({
    ...journal,
    snapshots: [...(journal.snapshots ?? []).filter((item) => item.estimateDate !== estimateDate), nextSnapshot].sort((left, right) => left.estimateDate.localeCompare(right.estimateDate)),
  });
}
