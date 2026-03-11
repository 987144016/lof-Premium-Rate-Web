import type { CalibrationModel, FundRuntimeData, FundScenario } from '../types';

export const defaultCalibration: CalibrationModel = {
  alpha: 0,
  betaBasket: 0,
  betaFx: 0,
  learningRate: 0.35,
  sampleCount: 0,
  meanAbsError: 0,
};

export const initialFundScenario: FundScenario = {
  code: '161128',
  name: '易方达标普信息科技指数(QDII-LOF)A',
  benchmark: '标普500信息科技指数收益率(估值汇率折算) * 95% + 活期存款利率 * 5%',
  reportDate: '2025-12-31',
  navDate: '2026-03-05',
  officialNavT1: 5.4844,
  latestMarketPrice: 5.62,
  stockAllocation: 87.02,
  cashAllocation: 12.53,
  annualFeeRate: 0.01,
  manualBiasBps: 0,
  fx: {
    pair: 'USD/CNY',
    baseRate: 7.18,
    currentRate: 7.18,
  },
  holdings: [
    { ticker: 'NVDA', name: '英伟达', weight: 19.61, basePrice: 177.82, currentPrice: 177.82, currency: 'USD' },
    { ticker: 'AAPL', name: '苹果', weight: 17.38, basePrice: 257.46, currentPrice: 257.46, currency: 'USD' },
    { ticker: 'MSFT', name: '微软', weight: 15.55, basePrice: 408.96, currentPrice: 408.96, currency: 'USD' },
    { ticker: 'AVGO', name: '博通', weight: 7.07, basePrice: 330.48, currentPrice: 330.48, currency: 'USD' },
    { ticker: 'PLTR', name: 'Palantir', weight: 1.76, basePrice: 157.16, currentPrice: 157.16, currency: 'USD' },
    { ticker: 'AMD', name: '超威半导体', weight: 1.51, basePrice: 192.43, currentPrice: 192.43, currency: 'USD' },
    { ticker: 'ORCL', name: '甲骨文', weight: 1.42, basePrice: 152.96, currentPrice: 152.96, currency: 'USD' },
    { ticker: 'MU', name: '美光科技', weight: 1.39, basePrice: 370.3, currentPrice: 370.3, currency: 'USD' },
    { ticker: 'CSCO', name: '思科', weight: 1.31, basePrice: 78.64, currentPrice: 78.64, currency: 'USD' },
    { ticker: 'IBM', name: 'IBM', weight: 1.2, basePrice: 258.85, currentPrice: 258.85, currency: 'USD' },
  ],
  proxyBuckets: [
    {
      key: 'other-tech',
      name: '其他科技成分代理篮子',
      weight: 19.82,
      baseLevel: 100,
      currentLevel: 100,
      note: '用来承接前十大之外的股票权重，初期建议用 XLK 或标普500信息科技指数夜盘替代。',
    },
  ],
};

export function cloneInitialScenario(runtime?: FundRuntimeData): FundScenario {
  const next = JSON.parse(JSON.stringify(initialFundScenario)) as FundScenario;

  if (!runtime) {
    return next;
  }

  next.code = runtime.code;
  next.name = runtime.name || next.name;
  next.benchmark = runtime.benchmark || next.benchmark;
  next.navDate = runtime.navDate || next.navDate;
  next.officialNavT1 = runtime.officialNavT1 || next.officialNavT1;
  next.latestMarketPrice = runtime.marketPrice || next.latestMarketPrice;

  if (runtime.fx?.currentRate) {
    next.fx.currentRate = runtime.fx.currentRate;
    next.fx.baseRate = runtime.fx.previousCloseRate || runtime.fx.currentRate;
  }

  if (runtime.holdingQuotes?.length) {
    const quoteMap = new Map(runtime.holdingQuotes.map((item) => [item.ticker.toUpperCase(), item]));
    next.holdings = next.holdings.map((holding) => {
      const quote = quoteMap.get(holding.ticker.toUpperCase());
      if (!quote) {
        return holding;
      }

      return {
        ...holding,
        basePrice: quote.previousClose || quote.currentPrice || holding.basePrice,
        currentPrice: quote.currentPrice || holding.currentPrice,
      };
    });
  }

  return next;
}
