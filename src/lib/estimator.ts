import type { CalibrationModel, ContributionItem, EstimateResult, FundScenario } from '../types';

const DAILY_FEE_DENOMINATOR = 365;

function getReturn(base: number, current: number): number {
  if (base <= 0 || current <= 0) {
    return 0;
  }

  return current / base - 1;
}

function getFxReturn(scenario: FundScenario): number {
  return getReturn(scenario.fx.baseRate, scenario.fx.currentRate);
}

function buildContribution(
  key: string,
  label: string,
  weight: number,
  localReturn: number,
  fxReturn: number,
): ContributionItem {
  const totalReturn = (1 + localReturn) * (1 + fxReturn) - 1;

  return {
    key,
    label,
    weight,
    localReturn,
    contributionReturn: (weight / 100) * totalReturn,
  };
}

function getLearnedBiasReturn(model: CalibrationModel, stockBasketReturn: number, fxReturn: number): number {
  return model.alpha + model.betaBasket * stockBasketReturn + model.betaFx * fxReturn;
}

export function estimateScenario(
  scenario: FundScenario,
  calibration: CalibrationModel,
): EstimateResult {
  const fxReturn = getFxReturn(scenario);
  const contributions: ContributionItem[] = [];

  for (const holding of scenario.holdings) {
    contributions.push(
      buildContribution(
        holding.ticker,
        `${holding.ticker} ${holding.name}`,
        holding.weight,
        getReturn(holding.basePrice, holding.currentPrice),
        fxReturn,
      ),
    );
  }

  for (const bucket of scenario.proxyBuckets) {
    contributions.push(
      buildContribution(
        bucket.key,
        bucket.name,
        bucket.weight,
        getReturn(bucket.baseLevel, bucket.currentLevel),
        fxReturn,
      ),
    );
  }

  const stockContribution = contributions.reduce((total, item) => total + item.contributionReturn, 0);
  const stockBasketReturn = scenario.stockAllocation > 0 ? stockContribution / (scenario.stockAllocation / 100) : 0;
  const feeDrag = scenario.annualFeeRate / DAILY_FEE_DENOMINATOR;
  const manualBiasReturn = scenario.manualBiasBps / 10000;
  const learnedBiasReturn = getLearnedBiasReturn(calibration, stockBasketReturn, fxReturn);
  const rawReturn = stockContribution - feeDrag;
  const correctedReturn = rawReturn + manualBiasReturn + learnedBiasReturn;
  const rawEstimatedNav = scenario.officialNavT1 * (1 + rawReturn);
  const correctedEstimatedNav = scenario.officialNavT1 * (1 + correctedReturn);
  const premiumRate = scenario.latestMarketPrice / correctedEstimatedNav - 1;

  return {
    rawReturn,
    correctedReturn,
    rawEstimatedNav,
    correctedEstimatedNav,
    premiumRate,
    discountRate: -premiumRate,
    stockBasketReturn,
    fxReturn,
    feeDrag,
    manualBiasReturn,
    learnedBiasReturn,
    contributions,
  };
}

export function trainCalibration(
  currentModel: CalibrationModel,
  scenario: FundScenario,
  actualNav: number,
): CalibrationModel {
  if (actualNav <= 0) {
    return currentModel;
  }

  const fxReturn = getFxReturn(scenario);
  const stockContribution = [...scenario.holdings, ...scenario.proxyBuckets].reduce((total, item) => {
    const weight = item.weight;
    const localReturn = 'basePrice' in item
      ? getReturn(item.basePrice, item.currentPrice)
      : getReturn(item.baseLevel, item.currentLevel);
    const totalReturn = (1 + localReturn) * (1 + fxReturn) - 1;

    return total + (weight / 100) * totalReturn;
  }, 0);
  const stockBasketReturn = scenario.stockAllocation > 0 ? stockContribution / (scenario.stockAllocation / 100) : 0;
  const rawReturn = stockContribution - scenario.annualFeeRate / DAILY_FEE_DENOMINATOR;
  const targetResidualReturn = actualNav / scenario.officialNavT1 - 1 - rawReturn;
  const predictedResidual = getLearnedBiasReturn(currentModel, stockBasketReturn, fxReturn);
  const error = targetResidualReturn - predictedResidual;
  const nextSampleCount = currentModel.sampleCount + 1;
  const adaptiveRate = currentModel.learningRate / Math.sqrt(nextSampleCount);
  const nextMae =
    currentModel.sampleCount === 0
      ? Math.abs(error)
      : (currentModel.meanAbsError * currentModel.sampleCount + Math.abs(error)) / nextSampleCount;

  return {
    ...currentModel,
    alpha: currentModel.alpha + adaptiveRate * error,
    betaBasket: currentModel.betaBasket + adaptiveRate * error * stockBasketReturn,
    betaFx: currentModel.betaFx + adaptiveRate * error * fxReturn,
    sampleCount: nextSampleCount,
    meanAbsError: nextMae,
    lastUpdatedAt: new Date().toISOString(),
  };
}
