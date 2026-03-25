export type Currency = 'USD' | 'CNY' | 'HKD';
export type DetailMode = 'holdings' | 'summary';
export type PageCategory = 'domestic-lof' | 'qdii-lof' | 'etf';
export type EstimateMode = 'market' | 'proxy';

export interface HoldingInput {
  ticker: string;
  name: string;
  weight: number;
  basePrice: number;
  currentPrice: number;
  currency: Currency;
  note?: string;
}

export interface ProxyBucketInput {
  key: string;
  name: string;
  weight: number;
  baseLevel: number;
  currentLevel: number;
  note?: string;
}

export interface FxInput {
  pair: string;
  baseRate: number;
  currentRate: number;
}

export interface FundScenario {
  code: string;
  name: string;
  benchmark: string;
  reportDate: string;
  navDate: string;
  officialNavT1: number;
  latestMarketPrice: number;
  stockAllocation: number;
  cashAllocation: number;
  annualFeeRate: number;
  manualBiasBps: number;
  holdings: HoldingInput[];
  proxyBuckets: ProxyBucketInput[];
  fx: FxInput;
}

export interface CalibrationModel {
  alpha: number;
  betaBasket: number;
  betaFx: number;
  learningRate: number;
  sampleCount: number;
  meanAbsError: number;
  lastUpdatedAt?: string;
}

export interface ContributionItem {
  key: string;
  label: string;
  weight: number;
  localReturn: number;
  contributionReturn: number;
}

export interface EstimateResult {
  rawReturn: number;
  correctedReturn: number;
  rawEstimatedNav: number;
  correctedEstimatedNav: number;
  premiumRate: number;
  discountRate: number;
  stockBasketReturn: number;
  fxReturn: number;
  feeDrag: number;
  manualBiasReturn: number;
  learnedBiasReturn: number;
  contributions: ContributionItem[];
}

export interface NavPoint {
  date: string;
  nav: number;
}

export interface RuntimeFxQuote {
  pair: string;
  currentRate: number;
  previousCloseRate: number;
  quoteDate: string;
  quoteTime: string;
  source: string;
}

export interface HoldingQuote {
  ticker: string;
  name: string;
  currentPrice: number;
  previousClose: number;
  quoteDate: string;
  quoteTime: string;
  currency: Currency;
}

export interface ProxyQuote {
  ticker: string;
  name: string;
  weight: number;
  currentPrice: number;
  previousClose: number;
  quoteDate: string;
  quoteTime: string;
  currency: Currency;
}

export interface DisclosedHolding {
  ticker: string;
  name: string;
  weight: number;
  shares?: number;
  marketValue?: number;
  currentPrice?: number;
  changeRate?: number;
}

export interface FundRuntimeData {
  code: string;
  priority: number;
  detailMode: DetailMode;
  pageCategory: PageCategory;
  estimateMode: EstimateMode;
  name: string;
  fundType: string;
  benchmark: string;
  officialNavT1: number;
  navDate: string;
  navHistory: NavPoint[];
  marketPrice: number;
  previousClose: number;
  marketDate: string;
  marketTime: string;
  marketSource: string;
  purchaseStatus?: string;
  purchaseLimit?: string;
  fx?: RuntimeFxQuote;
  holdingQuotes?: HoldingQuote[];
  holdingsQuoteDate?: string;
  holdingsQuoteTime?: string;
  disclosedHoldingsTitle?: string;
  disclosedHoldingsReportDate?: string;
  disclosedHoldings?: DisclosedHolding[];
  proxyBasketName?: string;
  proxyQuotes?: ProxyQuote[];
  proxyQuoteDate?: string;
  proxyQuoteTime?: string;
  goldContinuousReturn?: number | null;
  goldContinuousSymbol?: string;
  goldContinuousSource?: string;
  oilContinuousReturn?: number | null;
  oilContinuousSymbol?: string;
  oilContinuousSource?: string;
  cacheMode?: 'fresh' | 'daily-cache' | 'intraday-cache';
}

export interface RuntimePayload {
  syncedAt: string;
  funds: FundRuntimeData[];
  stateByCode?: Record<string, PersistedFundState>;
}

export interface GithubTrafficDay {
  date: string;
  viewCount: number;
  viewUniques: number;
  cloneCount: number;
  cloneUniques: number;
}

export interface GithubTrafficRecent7 {
  days: GithubTrafficDay[];
  viewCount: number;
  viewUniques: number;
  cloneCount: number;
  cloneUniques: number;
}

export interface GithubTrafficPayload {
  generatedAt: string;
  source: string;
  repo: string;
  available: boolean;
  reason?: string;
  snapshotConfig?: {
    timeZone: string;
    snapshotHourCst: number;
    windowMinutes: number;
  };
  snapshotSummary?: {
    totalDays: number;
    cumulativeViewUniques: number;
    cumulativeViewCount: number;
    latestCapturedDate: string;
  };
  recent7: GithubTrafficRecent7;
  totals: {
    viewCount: number;
    viewUniques: number;
    cloneCount: number;
    cloneUniques: number;
  };
  last14Days?: GithubTrafficDay[];
  snapshots?: GithubTrafficDay[];
}

export interface WatchlistModel {
  alpha: number;
  betaLead: number;
  betaGap: number;
  betaIntraday: number;
  learningRate: number;
  sampleCount: number;
  meanAbsError: number;
  lastUpdatedAt?: string;
}

export interface FundEstimateSnapshot {
  estimateDate: string;
  estimatedNav: number;
  marketPrice: number;
  premiumRate: number;
  marketPriceDate?: string;
  marketPriceTime?: string;
  marketPriceType?: 'intraday' | 'close';
  anchorNav: number;
  leadReturn: number;
  closeGapReturn: number;
  intradayReturn?: number;
  impliedReturn: number;
  adaptiveUsed?: boolean;
  adaptiveShockTriggered?: boolean;
  createdAt: string;
}

export interface FundErrorPoint {
  date: string;
  marketPrice?: number;
  estimatedNav: number;
  actualNav: number;
  premiumRate: number;
  actualPremiumRate?: number;
  premiumError?: number;
  absPremiumError?: number;
  error: number;
  absError: number;
}

export interface FundJournal {
  snapshots: FundEstimateSnapshot[];
  errors: FundErrorPoint[];
}

export interface WatchlistEstimateResult {
  anchorNav: number;
  leadReturn: number;
  closeGapReturn: number;
  learnedBiasReturn: number;
  impliedReturn: number;
  estimatedNav: number;
  premiumRate: number;
}

export interface FundViewModel {
  runtime: FundRuntimeData;
  model: WatchlistModel;
  journal: FundJournal;
  estimate: WatchlistEstimateResult;
}

export interface PersistedFundState {
  modelVersion?: number;
  model: WatchlistModel;
  journal: FundJournal;
}
