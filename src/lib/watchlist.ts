import type {
  FundErrorPoint,
  FundJournal,
  FundRuntimeData,
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
        localReturn: item.currentPrice / item.previousClose - 1,
      };
    })
    .filter((item): item is { weight: number; localReturn: number } => Boolean(item));

  const totalWeight = weightedQuotes.reduce((sum, item) => sum + item.weight, 0);
  if (totalWeight <= 0) {
    return 0;
  }

  return weightedQuotes.reduce((sum, item) => sum + item.localReturn * (item.weight / totalWeight), 0);
}

function hasHoldingsSignal(runtime: FundRuntimeData): boolean {
  return (runtime.disclosedHoldings?.length ?? 0) > 0 && (runtime.holdingQuotes?.length ?? 0) > 0;
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
  const useProxyEstimate = runtime.estimateMode === 'proxy';
  const useHoldingsEstimate = !useProxyEstimate && hasHoldingsSignal(runtime);
  const rawLeadReturn = useProxyEstimate
    ? getWeightedProxyReturn(runtime)
    : useHoldingsEstimate
      ? getWeightedHoldingReturn(runtime)
      : runtime.previousClose > 0
        ? runtime.marketPrice / runtime.previousClose - 1
        : 0;
  const leadReturn = clamp(rawLeadReturn, useProxyEstimate ? MAX_PROXY_MOVE : MAX_MARKET_MOVE);
  const rawCloseGapReturn = useProxyEstimate ? getFxReturn(runtime) : useHoldingsEstimate ? 0 : anchorNav > 0 && runtime.previousClose > 0 ? runtime.previousClose / anchorNav - 1 : 0;
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
  const baseJournal = pruneJournal(currentJournal);
  const resolvedDates = new Set(baseJournal.errors.map((item) => item.date));
  let model = { ...getDefaultWatchlistModel(), ...currentModel };
  const nextErrors = [...baseJournal.errors];

  for (const snapshot of baseJournal.snapshots) {
    if (resolvedDates.has(snapshot.estimateDate)) {
      continue;
    }

    const actualNav = actualNavByDate.get(snapshot.estimateDate);
    if (!actualNav) {
      continue;
    }

    const targetReturn = snapshot.anchorNav > 0 ? actualNav / snapshot.anchorNav - 1 : 0;
    const predictedReturn = snapshot.impliedReturn;
    const residualError = targetReturn - predictedReturn;
    const displayError = actualNav > 0 ? snapshot.estimatedNav / actualNav - 1 : 0;
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

    const errorPoint: FundErrorPoint = {
      date: snapshot.estimateDate,
      estimatedNav: snapshot.estimatedNav,
      actualNav,
      premiumRate: snapshot.premiumRate,
      error: displayError,
      absError: Math.abs(displayError),
    };

    nextErrors.push(errorPoint);
    resolvedDates.add(snapshot.estimateDate);
  }

  nextErrors.sort((left, right) => left.date.localeCompare(right.date));

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
  const existing = journal.snapshots.find((item) => item.estimateDate === estimateDate);
  if (existing) {
    return journal;
  }

  return pruneJournal({
    ...journal,
    snapshots: [
      ...journal.snapshots,
      {
        estimateDate,
        estimatedNav: estimate.estimatedNav,
        marketPrice: runtime.marketPrice,
        premiumRate: estimate.premiumRate,
        anchorNav: estimate.anchorNav,
        leadReturn: estimate.leadReturn,
        closeGapReturn: estimate.closeGapReturn,
        impliedReturn: estimate.impliedReturn,
        createdAt: new Date().toISOString(),
      },
    ].sort((left, right) => left.estimateDate.localeCompare(right.estimateDate)),
  });
}
