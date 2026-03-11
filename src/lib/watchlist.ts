import type {
  FundErrorPoint,
  FundJournal,
  FundRuntimeData,
  WatchlistEstimateResult,
  WatchlistModel,
} from '../types';

const DEFAULT_LEARNING_RATE = 0.24;
const DEFAULT_BETA_LEAD = 0.38;
const MAX_LEAD_MOVE = 0.08;

export function getDefaultWatchlistModel(): WatchlistModel {
  return {
    alpha: 0,
    betaLead: DEFAULT_BETA_LEAD,
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

export function reconcileJournal(
  runtime: FundRuntimeData,
  currentModel: WatchlistModel,
  currentJournal: FundJournal,
): { model: WatchlistModel; journal: FundJournal } {
  const actualNavByDate = new Map(runtime.navHistory.map((item) => [item.date, item.nav]));
  const resolvedDates = new Set(currentJournal.errors.map((item) => item.date));
  let model = { ...currentModel };
  const nextErrors = [...currentJournal.errors];

  for (const snapshot of currentJournal.snapshots) {
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

    const errorPoint: FundErrorPoint = {
      date: snapshot.estimateDate,
      estimatedNav: snapshot.estimatedNav,
      actualNav,
      premiumRate: snapshot.premiumRate,
      error,
      absError: Math.abs(error),
    };

    nextErrors.push(errorPoint);
    resolvedDates.add(snapshot.estimateDate);
  }

  nextErrors.sort((left, right) => left.date.localeCompare(right.date));

  return {
    model,
    journal: {
      ...currentJournal,
      errors: nextErrors,
    },
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

  return {
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
        impliedReturn: estimate.impliedReturn,
        createdAt: new Date().toISOString(),
      },
    ].sort((left, right) => left.estimateDate.localeCompare(right.estimateDate)),
  };
}
