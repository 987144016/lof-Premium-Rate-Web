import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { load } from 'cheerio';
import { PDFParse } from 'pdf-parse';
import catalog from '../src/data/fundCatalog.json' with { type: 'json' };
import { parseNoticeHoldingsDisclosure } from './notice-parsers/registry.mjs';
import { computeAdaptiveImpliedReturn as computeAdaptiveImpliedReturnPublic } from './algorithms/watchlist-core.public.mjs';

const projectRoot = process.cwd();
const outputPath = path.join(projectRoot, 'public', 'generated', 'funds-runtime.json');
const dailyCacheDir = path.join(projectRoot, '.cache', 'fund-sync', 'daily');
const intradayCacheDir = path.join(projectRoot, '.cache', 'fund-sync', 'intraday');
const watchlistStatePath = path.join(projectRoot, '.cache', 'fund-sync', 'watchlist-state.json');
const holdingsDisclosurePath = path.join(projectRoot, '.cache', 'fund-sync', 'holdings-disclosures.json');
const syncSchedulePath = path.join(projectRoot, '.cache', 'fund-sync', 'sync-schedule.json');
const quoteHistoryDbPath = path.join(projectRoot, '.cache', 'fund-sync', 'quote-history-db.json');
const PUBLISHED_RUNTIME_URLS = [
  'https://987144016.github.io/lof-Premium-Rate-Web/generated/funds-runtime.json',
  'https://987144016.github.io/lof-Premium-Rate-Web/?state-probe=1',
];
const now = new Date();
const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
const WATCHLIST_STATE_VERSION = 17;
const DAILY_CACHE_VERSION = 40;
const INTRADAY_CACHE_TTL_MS = 5 * 60 * 1000;
const HOLDING_QUOTE_BATCH_SIZE = 180;
const MAX_MARKET_MOVE = 0.08;
const MAX_PROXY_MOVE = 0.15;
const MAX_CLOSE_GAP = 0.2;
const MAX_FX_MOVE = 0.05;
const STALE_LEAD_REPEAT_EPSILON = 1e-6;
const STALE_LEAD_SIGNAL_THRESHOLD = 0.015;
const STALE_LEAD_PROXY_BLEND = 0.65;
const STALE_LEAD_CLAMP = 0.02;
const JOURNAL_RETENTION_DAYS = 90;
const adaptiveAlgoPrivatePath = path.join(projectRoot, '.private', 'adaptive-holdings-algo.private.json');
const privateWatchlistCorePath = path.join(projectRoot, '.private', 'watchlist-core.private.mjs');
const ENABLE_PRIVATE_ALGO = process.env.ENABLE_PRIVATE_ALGO === '1';
const OFFLINE_MODEL_BOOTSTRAP_SAMPLE_COUNT = 30;
const ADAPTIVE_OFFLINE_PARAM_KEYS = new Set([
  'shockThreshold',
  'tradingShockThreshold',
  'offShockThreshold',
  'shockBaseBlend',
  'normalBaseBlend',
  'tradingBaseBlend',
  'offBaseBlend',
  'shockAmplify',
  'minReturn',
  'maxReturn',
  'kLearnRate',
  'biasLearnRate',
  'updateMinMove',
  'kMin',
  'kMax',
  'maxLeadMove',
  'sessionSplit',
  'tradingLeadScale',
  'offLeadScale',
  'upMoveScale',
  'downMoveScale',
  'gapBranch',
  'gapCoef',
  'gapAmplify',
  'gapSignalThreshold',
  'gapBiasLearnRate',
  'weekendThreshold',
  'weekendAmplify',
  'weekendFxCoef',
  'weekendMomentumCoef',
  'enableOilSessionGap',
  'primaryProxyTicker',
  'secondaryProxyTicker',
  'fxGapWeight',
  'proxySpreadThreshold',
]);
const PUBLIC_ADAPTIVE_HOLDINGS_ALGO_BY_CODE = {
  '160216': {
    shockThreshold: 0.024082436635498593,
    tradingShockThreshold: 0.024082436635498593,
    offShockThreshold: 0.04507091233634843,
    shockBaseBlend: 0.75,
    normalBaseBlend: 0.65,
    tradingBaseBlend: 0.59,
    offBaseBlend: 0.65,
    shockAmplify: 0.2,
    minReturn: -0.16,
    maxReturn: 0.16,
    kLearnRate: 0.12,
    biasLearnRate: 0.12,
    updateMinMove: 0.001,
    kMin: 0.25,
    kMax: 1.8,
    maxLeadMove: 0.18,
    sessionSplit: true,
    tradingLeadScale: 1.08,
    offLeadScale: 0.94,
    upMoveScale: 1.1,
    downMoveScale: 0.9,
    gapBranch: true,
    gapCoef: 0,
    gapAmplify: 0.35,
    gapSignalThreshold: 0.01273721098787995,
    gapBiasLearnRate: 0.08,
    weekendThreshold: 0.01,
    weekendAmplify: 0,
    weekendFxCoef: 0.4,
    weekendMomentumCoef: 0.25,
    enableOilSessionGap: true,
    primaryProxyTicker: 'GLD',
    secondaryProxyTicker: 'COPX',
    fxGapWeight: 0.38,
    proxySpreadThreshold: 0.018,
  },
  '160719': {
    shockThreshold: 0.011390810830058155,
    tradingShockThreshold: 0.011390810830058155,
    offShockThreshold: 0.02559300766555219,
    shockBaseBlend: 0.3,
    normalBaseBlend: 0.65,
    tradingBaseBlend: 0.59,
    offBaseBlend: 0.65,
    shockAmplify: 0.2,
    minReturn: -0.12,
    maxReturn: 0.12,
    kLearnRate: 0.05,
    biasLearnRate: 0.03,
    updateMinMove: 0.001,
    kMin: 0.25,
    kMax: 1.8,
    maxLeadMove: 0.12,
    sessionSplit: true,
    tradingLeadScale: 1.08,
    offLeadScale: 1.04,
    upMoveScale: 1.12,
    downMoveScale: 1,
    gapBranch: true,
    gapCoef: 0.35,
    gapAmplify: 0.35,
    gapSignalThreshold: 0.006,
    gapBiasLearnRate: 0.08,
    weekendThreshold: 0.01,
    weekendAmplify: 0,
    weekendFxCoef: 0.4,
    weekendMomentumCoef: 0.25,
    enableOilSessionGap: true,
    primaryProxyTicker: 'GLD',
    secondaryProxyTicker: 'IAU',
    fxGapWeight: 0.35,
    proxySpreadThreshold: 0.01,
  },
  '161116': {
    shockThreshold: 0.01358415893262123,
    tradingShockThreshold: 0.01358415893262123,
    offShockThreshold: 0.02964847192821901,
    shockBaseBlend: 0.3,
    normalBaseBlend: 0.65,
    tradingBaseBlend: 0.59,
    offBaseBlend: 0.65,
    shockAmplify: 0.35,
    minReturn: -0.14,
    maxReturn: 0.14,
    kLearnRate: 0.05,
    biasLearnRate: 0.03,
    updateMinMove: 0.001,
    kMin: 0.25,
    kMax: 1.8,
    maxLeadMove: 0.14,
    sessionSplit: true,
    tradingLeadScale: 1.08,
    offLeadScale: 1.14,
    upMoveScale: 1.1,
    downMoveScale: 1.12,
    gapBranch: true,
    gapCoef: 0.15,
    gapAmplify: 0.35,
    gapSignalThreshold: 0.007733201983035134,
    gapBiasLearnRate: 0.08,
    weekendThreshold: 0.03,
    weekendAmplify: 0.35,
    weekendFxCoef: 0.4,
    weekendMomentumCoef: 0,
    enableOilSessionGap: true,
    primaryProxyTicker: 'GLD',
    secondaryProxyTicker: 'UGL',
    fxGapWeight: 0.35,
    proxySpreadThreshold: 0.014,
  },
  '164701': {
    shockThreshold: 0.01480800898123592,
    tradingShockThreshold: 0.01480800898123592,
    offShockThreshold: 0.0318048206207611,
    shockBaseBlend: 0.45,
    normalBaseBlend: 0.65,
    tradingBaseBlend: 0.59,
    offBaseBlend: 0.65,
    shockAmplify: 0.35,
    minReturn: -0.16,
    maxReturn: 0.16,
    kLearnRate: 0.12,
    biasLearnRate: 0.12,
    updateMinMove: 0.001,
    kMin: 0.25,
    kMax: 1.8,
    maxLeadMove: 0.16,
    sessionSplit: true,
    tradingLeadScale: 1.08,
    offLeadScale: 1.04,
    upMoveScale: 0.9,
    downMoveScale: 1,
    gapBranch: true,
    gapCoef: 0,
    gapAmplify: 0.35,
    gapSignalThreshold: 0.006,
    gapBiasLearnRate: 0.08,
    weekendThreshold: 0.01,
    weekendAmplify: 0,
    weekendFxCoef: 0.4,
    weekendMomentumCoef: 0.25,
    enableOilSessionGap: true,
    primaryProxyTicker: 'GLD',
    secondaryProxyTicker: 'UGL',
    fxGapWeight: 0.35,
    proxySpreadThreshold: 0.016,
  },
  '160723': {
    shockThreshold: 0.02642017570755296,
    tradingShockThreshold: 0.02642017570755296,
    offShockThreshold: 0.03194233127341834,
    shockBaseBlend: 0.75,
    normalBaseBlend: 0.81,
    tradingBaseBlend: 0.59,
    offBaseBlend: 0.81,
    shockAmplify: 0.35,
    minReturn: -0.18,
    maxReturn: 0.18,
    kLearnRate: 0.05,
    biasLearnRate: 0.08,
    updateMinMove: 0.001,
    kMin: 0.25,
    kMax: 1.8,
    maxLeadMove: 0.18,
    sessionSplit: true,
    tradingLeadScale: 1.08,
    offLeadScale: 1.14,
    upMoveScale: 1.1,
    downMoveScale: 0.9,
    gapBranch: true,
    gapCoef: 0,
    gapAmplify: 0.35,
    gapSignalThreshold: 0.006,
    gapBiasLearnRate: 0.08,
    weekendThreshold: 0.03,
    weekendAmplify: 0.6,
    weekendFxCoef: 0.4,
    weekendMomentumCoef: 0.45,
    enableOilSessionGap: true,
  },
  '501018': {
    shockThreshold: 0.02604190526041894,
    tradingShockThreshold: 0.02604190526041894,
    offShockThreshold: 0.030657389538365106,
    shockBaseBlend: 0.45,
    normalBaseBlend: 0.95,
    tradingBaseBlend: 0.79,
    offBaseBlend: 0.95,
    shockAmplify: 0.2,
    minReturn: -0.18,
    maxReturn: 0.18,
    kLearnRate: 0.05,
    biasLearnRate: 0.03,
    updateMinMove: 0.001,
    kMin: 0.25,
    kMax: 1.8,
    maxLeadMove: 0.18,
    sessionSplit: true,
    tradingLeadScale: 1.08,
    offLeadScale: 0.94,
    upMoveScale: 1.12,
    downMoveScale: 1.15,
    gapBranch: true,
    gapCoef: 0.75,
    gapAmplify: 0.35,
    gapSignalThreshold: 0.006,
    gapBiasLearnRate: 0.08,
    weekendThreshold: 0.02,
    weekendAmplify: 0.35,
    weekendFxCoef: 0.4,
    weekendMomentumCoef: 0.7,
    enableOilSessionGap: true,
  },
  '501225': {
    shockThreshold: 0.023718380131120053,
    tradingShockThreshold: 0.023718380131120053,
    offShockThreshold: 0.0389128378948274,
    shockBaseBlend: 0.3,
    normalBaseBlend: 0.65,
    tradingBaseBlend: 0.59,
    offBaseBlend: 0.65,
    shockAmplify: 0.2,
    minReturn: -0.16,
    maxReturn: 0.16,
    kLearnRate: 0.05,
    biasLearnRate: 0.03,
    updateMinMove: 0.001,
    kMin: 0.25,
    kMax: 1.8,
    maxLeadMove: 0.16,
    sessionSplit: true,
    tradingLeadScale: 1.08,
    offLeadScale: 0.94,
    upMoveScale: 1.12,
    downMoveScale: 1.15,
    gapBranch: true,
    gapCoef: 0,
    gapAmplify: 0.35,
    gapSignalThreshold: 0.006,
    gapBiasLearnRate: 0.08,
    weekendThreshold: 0.01,
    weekendAmplify: 0,
    weekendFxCoef: 0.4,
    weekendMomentumCoef: 0,
    enableOilSessionGap: true,
    primaryProxyTicker: 'SOXX',
    secondaryProxyTicker: 'SMH',
    fxGapWeight: 0.32,
    proxySpreadThreshold: 0.018,
  },
  '513310': {
    shockThreshold: 0.03616173678146938,
    tradingShockThreshold: 0.03616173678146938,
    offShockThreshold: 0.05211419386147861,
    shockBaseBlend: 0.6,
    normalBaseBlend: 0.95,
    tradingBaseBlend: 0.79,
    offBaseBlend: 0.95,
    shockAmplify: 0,
    minReturn: -0.18,
    maxReturn: 0.18,
    kLearnRate: 0.18,
    biasLearnRate: 0.03,
    updateMinMove: 0.001,
    kMin: 0.25,
    kMax: 1.8,
    maxLeadMove: 0.18,
    sessionSplit: true,
    tradingLeadScale: 1.08,
    offLeadScale: 1.14,
    upMoveScale: 1.12,
    downMoveScale: 1,
    gapBranch: true,
    gapCoef: 0,
    gapAmplify: 0.35,
    gapSignalThreshold: 0.006,
    gapBiasLearnRate: 0.08,
    weekendThreshold: 0.03,
    weekendAmplify: 0.35,
    weekendFxCoef: 0.4,
    weekendMomentumCoef: 0,
    enableOilSessionGap: true,
    primaryProxyTicker: 'SOXX',
    secondaryProxyTicker: 'SMH',
    fxGapWeight: 0.28,
    proxySpreadThreshold: 0.02,
  },
  '160416': {
    shockThreshold: 0.016381349309043534,
    tradingShockThreshold: 0.016381349309043534,
    offShockThreshold: 0.01713163947362841,
    shockBaseBlend: 0.3,
    normalBaseBlend: 0.81,
    tradingBaseBlend: 0.59,
    offBaseBlend: 0.81,
    shockAmplify: 0,
    minReturn: -0.16,
    maxReturn: 0.16,
    kLearnRate: 0.08,
    biasLearnRate: 0.03,
    updateMinMove: 0.001,
    kMin: 0.25,
    kMax: 1.8,
    maxLeadMove: 0.16,
    sessionSplit: true,
    tradingLeadScale: 1.08,
    offLeadScale: 1.14,
    upMoveScale: 0.9,
    downMoveScale: 0.9,
    gapBranch: true,
    gapCoef: 0,
    gapAmplify: 0.35,
    gapSignalThreshold: 0.006,
    gapBiasLearnRate: 0.08,
    weekendThreshold: 0.01,
    weekendAmplify: 0,
    weekendFxCoef: 0.4,
    weekendMomentumCoef: 0.45,
    enableOilSessionGap: true,
    primaryProxyTicker: 'XOP',
    secondaryProxyTicker: 'XLE',
    fxGapWeight: 0.35,
    proxySpreadThreshold: 0.02,
  },
  '162719': {
    shockThreshold: 0.01742935879857148,
    tradingShockThreshold: 0.01742935879857148,
    offShockThreshold: 0.01961692535425588,
    shockBaseBlend: 0.3,
    normalBaseBlend: 0.65,
    tradingBaseBlend: 0.59,
    offBaseBlend: 0.65,
    shockAmplify: 0,
    minReturn: -0.16,
    maxReturn: 0.16,
    kLearnRate: 0.05,
    biasLearnRate: 0.03,
    updateMinMove: 0.001,
    kMin: 0.25,
    kMax: 1.8,
    maxLeadMove: 0.16,
    sessionSplit: true,
    tradingLeadScale: 1.08,
    offLeadScale: 1.14,
    upMoveScale: 1.12,
    downMoveScale: 0.9,
    gapBranch: true,
    gapCoef: 0,
    gapAmplify: 0.35,
    gapSignalThreshold: 0.006,
    gapBiasLearnRate: 0.08,
    weekendThreshold: 0.01,
    weekendAmplify: 0,
    weekendFxCoef: 0.4,
    weekendMomentumCoef: 0.25,
    enableOilSessionGap: true,
    primaryProxyTicker: 'XOP',
    secondaryProxyTicker: 'XLE',
    fxGapWeight: 0.35,
    proxySpreadThreshold: 0.02,
  },
  '162411': {
    shockThreshold: 0.0177483294713759,
    tradingShockThreshold: 0.0177483294713759,
    offShockThreshold: 0.019538923704923904,
    shockBaseBlend: 0.3,
    normalBaseBlend: 0.65,
    tradingBaseBlend: 0.59,
    offBaseBlend: 0.65,
    shockAmplify: 0.2,
    minReturn: -0.16,
    maxReturn: 0.16,
    kLearnRate: 0.05,
    biasLearnRate: 0.03,
    updateMinMove: 0.001,
    kMin: 0.25,
    kMax: 1.8,
    maxLeadMove: 0.16,
    sessionSplit: true,
    tradingLeadScale: 1.08,
    offLeadScale: 0.94,
    upMoveScale: 1.12,
    downMoveScale: 1,
    gapBranch: true,
    gapCoef: 0,
    gapAmplify: 0.35,
    gapSignalThreshold: 0.006,
    gapBiasLearnRate: 0.08,
    weekendThreshold: 0.01,
    weekendAmplify: 0.35,
    weekendFxCoef: 0.8,
    weekendMomentumCoef: 0,
    enableOilSessionGap: true,
    primaryProxyTicker: 'XOP',
    secondaryProxyTicker: 'XLE',
    fxGapWeight: 0.35,
    proxySpreadThreshold: 0.02,
  },
  '161125': {
    shockThreshold: 0.01618509919616769,
    tradingShockThreshold: 0.01618509919616769,
    offShockThreshold: 0.0228231731050641,
    shockBaseBlend: 0.3,
    normalBaseBlend: 0.81,
    tradingBaseBlend: 0.59,
    offBaseBlend: 0.81,
    shockAmplify: 0,
    minReturn: -0.14,
    maxReturn: 0.14,
    kLearnRate: 0.18,
    biasLearnRate: 0.05,
    updateMinMove: 0.001,
    kMin: 0.25,
    kMax: 1.8,
    maxLeadMove: 0.14,
    sessionSplit: true,
    tradingLeadScale: 1.08,
    offLeadScale: 0.94,
    upMoveScale: 1.12,
    downMoveScale: 1.12,
    gapBranch: true,
    gapCoef: 0,
    gapAmplify: 0.35,
    gapSignalThreshold: 0.007687819971946614,
    gapBiasLearnRate: 0.08,
    weekendThreshold: 0.01,
    weekendAmplify: 0.35,
    weekendFxCoef: 0.8,
    weekendMomentumCoef: 0,
    enableOilSessionGap: true,
    primaryProxyTicker: 'SPY',
    secondaryProxyTicker: 'QQQ',
    fxGapWeight: 0.28,
    proxySpreadThreshold: 0.016,
  },
  '159509': {
    shockThreshold: 0.016489473690217336,
    tradingShockThreshold: 0.016489473690217336,
    offShockThreshold: 0.02342453047833562,
    shockBaseBlend: 0.3,
    normalBaseBlend: 0.65,
    tradingBaseBlend: 0.59,
    offBaseBlend: 0.65,
    shockAmplify: 0.35,
    minReturn: -0.14,
    maxReturn: 0.14,
    kLearnRate: 0.08,
    biasLearnRate: 0.03,
    updateMinMove: 0.001,
    kMin: 0.25,
    kMax: 1.8,
    maxLeadMove: 0.14,
    sessionSplit: true,
    tradingLeadScale: 1.08,
    offLeadScale: 1.04,
    upMoveScale: 1.12,
    downMoveScale: 1.15,
    gapBranch: true,
    gapCoef: 0,
    gapAmplify: 0.35,
    gapSignalThreshold: 0.006,
    gapBiasLearnRate: 0.08,
    weekendThreshold: 0.01,
    weekendAmplify: 0,
    weekendFxCoef: 0.4,
    weekendMomentumCoef: 0,
    enableOilSessionGap: true,
    primaryProxyTicker: 'QQQ',
    secondaryProxyTicker: 'XLK',
    fxGapWeight: 0.28,
    proxySpreadThreshold: 0.016,
  },
  '501312': {
    shockThreshold: 0.020286659162121225,
    tradingShockThreshold: 0.020286659162121225,
    offShockThreshold: 0.027859430097122218,
    shockBaseBlend: 0.45,
    normalBaseBlend: 0.65,
    tradingBaseBlend: 0.59,
    offBaseBlend: 0.65,
    shockAmplify: 0.35,
    minReturn: -0.14,
    maxReturn: 0.14,
    kLearnRate: 0.05,
    biasLearnRate: 0.08,
    updateMinMove: 0.001,
    kMin: 0.25,
    kMax: 1.8,
    maxLeadMove: 0.14,
    sessionSplit: true,
    tradingLeadScale: 1.08,
    offLeadScale: 0.94,
    upMoveScale: 0.9,
    downMoveScale: 1.12,
    gapBranch: true,
    gapCoef: 0.75,
    gapAmplify: 0.35,
    gapSignalThreshold: 0.006848218833755136,
    gapBiasLearnRate: 0.08,
    weekendThreshold: 0.01,
    weekendAmplify: 0,
    weekendFxCoef: 0.4,
    weekendMomentumCoef: 0,
    enableOilSessionGap: true,
    primaryProxyTicker: 'ARKK',
    secondaryProxyTicker: 'QQQ',
    fxGapWeight: 0.28,
    proxySpreadThreshold: 0.018,
  },
  '501011': {
    shockThreshold: 0.011772358333040633,
    tradingShockThreshold: 0.011772358333040633,
    offShockThreshold: 0.013598689796318753,
    shockBaseBlend: 0.3,
    normalBaseBlend: 0.65,
    tradingBaseBlend: 0.59,
    offBaseBlend: 0.65,
    shockAmplify: 0.2,
    minReturn: -0.12,
    maxReturn: 0.12,
    kLearnRate: 0.12,
    biasLearnRate: 0.03,
    updateMinMove: 0.001,
    kMin: 0.25,
    kMax: 1.8,
    maxLeadMove: 0.12,
    sessionSplit: true,
    tradingLeadScale: 1.08,
    offLeadScale: 1.14,
    upMoveScale: 1.12,
    downMoveScale: 1.15,
    gapBranch: true,
    gapCoef: 0,
    gapAmplify: 0.35,
    gapSignalThreshold: 0.007810420600836062,
    gapBiasLearnRate: 0.08,
    weekendThreshold: 0.01,
    weekendAmplify: 0,
    weekendFxCoef: 0.4,
    weekendMomentumCoef: 0,
    enableOilSessionGap: true,
    primaryProxyTicker: '000538',
    secondaryProxyTicker: '600436',
    fxGapWeight: 0,
    proxySpreadThreshold: 0.016,
  },
  '501050': {
    shockThreshold: 0.010085543429446642,
    tradingShockThreshold: 0.010085543429446642,
    offShockThreshold: 0.008922406497970404,
    shockBaseBlend: 0.3,
    normalBaseBlend: 0.81,
    tradingBaseBlend: 0.59,
    offBaseBlend: 0.81,
    shockAmplify: 0.5,
    minReturn: -0.12,
    maxReturn: 0.12,
    kLearnRate: 0.05,
    biasLearnRate: 0.05,
    updateMinMove: 0.001,
    kMin: 0.25,
    kMax: 1.8,
    maxLeadMove: 0.12,
    sessionSplit: true,
    tradingLeadScale: 1.08,
    offLeadScale: 1.14,
    upMoveScale: 0.9,
    downMoveScale: 1.15,
    gapBranch: true,
    gapCoef: 0,
    gapAmplify: 0.35,
    gapSignalThreshold: 0.008088527595399244,
    gapBiasLearnRate: 0.08,
    weekendThreshold: 0.03,
    weekendAmplify: 0.35,
    weekendFxCoef: 0.4,
    weekendMomentumCoef: 0,
    enableOilSessionGap: true,
    primaryProxyTicker: '601318',
    secondaryProxyTicker: '600519',
    fxGapWeight: 0,
    proxySpreadThreshold: 0.016,
  },
  '160221': {
    shockThreshold: 0.020140746335505087,
    tradingShockThreshold: 0.020140746335505087,
    offShockThreshold: 0.027281558872725032,
    shockBaseBlend: 0.3,
    normalBaseBlend: 0.65,
    tradingBaseBlend: 0.59,
    offBaseBlend: 0.65,
    shockAmplify: 0.35,
    minReturn: -0.12,
    maxReturn: 0.12,
    kLearnRate: 0.18,
    biasLearnRate: 0.03,
    updateMinMove: 0.001,
    kMin: 0.25,
    kMax: 1.8,
    maxLeadMove: 0.12,
    sessionSplit: true,
    tradingLeadScale: 1.08,
    offLeadScale: 1.04,
    upMoveScale: 1.12,
    downMoveScale: 0.9,
    gapBranch: true,
    gapCoef: 0,
    gapAmplify: 0.35,
    gapSignalThreshold: 0.011139245603261108,
    gapBiasLearnRate: 0.08,
    weekendThreshold: 0.03,
    weekendAmplify: 0.35,
    weekendFxCoef: 0.4,
    weekendMomentumCoef: 0,
    enableOilSessionGap: true,
    primaryProxyTicker: '601899',
    secondaryProxyTicker: '603993',
    fxGapWeight: 0,
    proxySpreadThreshold: 0.018,
  },
  '165520': {
    shockThreshold: 0.020140746335505087,
    tradingShockThreshold: 0.020140746335505087,
    offShockThreshold: 0.027281558872725032,
    shockBaseBlend: 0.3,
    normalBaseBlend: 0.65,
    tradingBaseBlend: 0.59,
    offBaseBlend: 0.65,
    shockAmplify: 0.35,
    minReturn: -0.12,
    maxReturn: 0.12,
    kLearnRate: 0.18,
    biasLearnRate: 0.03,
    updateMinMove: 0.001,
    kMin: 0.25,
    kMax: 1.8,
    maxLeadMove: 0.12,
    sessionSplit: true,
    tradingLeadScale: 1.08,
    offLeadScale: 1.04,
    upMoveScale: 1.12,
    downMoveScale: 0.9,
    gapBranch: true,
    gapCoef: 0,
    gapAmplify: 0.35,
    gapSignalThreshold: 0.011139245603261108,
    gapBiasLearnRate: 0.08,
    weekendThreshold: 0.02,
    weekendAmplify: 0.35,
    weekendFxCoef: 0.4,
    weekendMomentumCoef: 0,
    enableOilSessionGap: true,
    primaryProxyTicker: '601899',
    secondaryProxyTicker: '603993',
    fxGapWeight: 0,
    proxySpreadThreshold: 0.018,
  },
  '167301': {
    shockThreshold: 0.01316618590962675,
    tradingShockThreshold: 0.01316618590962675,
    offShockThreshold: 0.01211747669176868,
    shockBaseBlend: 0.3,
    normalBaseBlend: 0.65,
    tradingBaseBlend: 0.59,
    offBaseBlend: 0.65,
    shockAmplify: 0,
    minReturn: -0.12,
    maxReturn: 0.12,
    kLearnRate: 0.05,
    biasLearnRate: 0.03,
    updateMinMove: 0.001,
    kMin: 0.25,
    kMax: 1.8,
    maxLeadMove: 0.12,
    sessionSplit: true,
    tradingLeadScale: 1.08,
    offLeadScale: 1.14,
    upMoveScale: 1.12,
    downMoveScale: 1.12,
    gapBranch: true,
    gapCoef: 0.75,
    gapAmplify: 0.35,
    gapSignalThreshold: 0.00819650631226993,
    gapBiasLearnRate: 0.08,
    weekendThreshold: 0.01,
    weekendAmplify: 0,
    weekendFxCoef: 0.4,
    weekendMomentumCoef: 0,
    enableOilSessionGap: true,
    primaryProxyTicker: '601318',
    secondaryProxyTicker: '601398',
    fxGapWeight: 0,
    proxySpreadThreshold: 0.016,
  },
  '161130': {
    shockThreshold: 0.016951855291243063,
    tradingShockThreshold: 0.016951855291243063,
    offShockThreshold: 0.02279163952711097,
    shockBaseBlend: 0.3,
    normalBaseBlend: 0.73,
    tradingBaseBlend: 0.59,
    offBaseBlend: 0.73,
    shockAmplify: 0.2,
    minReturn: -0.14,
    maxReturn: 0.14,
    kLearnRate: 0.18,
    biasLearnRate: 0.12,
    updateMinMove: 0.001,
    kMin: 0.25,
    kMax: 1.8,
    maxLeadMove: 0.14,
    sessionSplit: true,
    tradingLeadScale: 1.08,
    offLeadScale: 0.94,
    upMoveScale: 1.12,
    downMoveScale: 1.15,
    gapBranch: true,
    gapCoef: 0,
    gapAmplify: 0.35,
    gapSignalThreshold: 0.006,
    gapBiasLearnRate: 0.08,
    weekendThreshold: 0.03,
    weekendAmplify: 0.35,
    weekendFxCoef: 0.8,
    weekendMomentumCoef: 0,
    enableOilSessionGap: true,
    primaryProxyTicker: 'QQQ',
    secondaryProxyTicker: 'XLK',
    fxGapWeight: 0.3,
    proxySpreadThreshold: 0.016,
  },
  '161129': {
    shockThreshold: 0.03364875542811923,
    tradingShockThreshold: 0.03364875542811923,
    offShockThreshold: 0.03222369110356943,
    shockBaseBlend: 0.75,
    normalBaseBlend: 0.81,
    tradingBaseBlend: 0.59,
    offBaseBlend: 0.81,
    shockAmplify: 0.5,
    minReturn: -0.18,
    maxReturn: 0.18,
    kLearnRate: 0.18,
    biasLearnRate: 0.12,
    updateMinMove: 0.001,
    kMin: 0.25,
    kMax: 1.8,
    maxLeadMove: 0.18,
    sessionSplit: true,
    tradingLeadScale: 1.08,
    offLeadScale: 1.04,
    upMoveScale: 1.12,
    downMoveScale: 0.9,
    gapBranch: true,
    gapCoef: 0,
    gapAmplify: 0.35,
    gapSignalThreshold: 0.006,
    gapBiasLearnRate: 0.08,
    weekendThreshold: 0.03,
    weekendAmplify: 0.6,
    weekendFxCoef: 0.4,
    weekendMomentumCoef: 0.7,
    enableOilSessionGap: true,
  },
  '161128': {
    shockThreshold: 0.031667149196750864,
    tradingShockThreshold: 0.031667149196750864,
    offShockThreshold: 0.05158157312711261,
    shockBaseBlend: 0.75,
    normalBaseBlend: 0.65,
    tradingBaseBlend: 0.59,
    offBaseBlend: 0.65,
    shockAmplify: 0.2,
    minReturn: -0.18,
    maxReturn: 0.18,
    kLearnRate: 0.08,
    biasLearnRate: 0.08,
    updateMinMove: 0.001,
    kMin: 0.25,
    kMax: 1.8,
    maxLeadMove: 0.18,
    sessionSplit: true,
    tradingLeadScale: 1.08,
    offLeadScale: 0.94,
    upMoveScale: 0.9,
    downMoveScale: 0.9,
    gapBranch: true,
    gapCoef: 0.15,
    gapAmplify: 0.35,
    gapSignalThreshold: 0.016748868258520854,
    gapBiasLearnRate: 0.08,
    weekendThreshold: 0.01,
    weekendAmplify: 0,
    weekendFxCoef: 0.4,
    weekendMomentumCoef: 0,
    enableOilSessionGap: true,
    primaryProxyTicker: 'XLK',
    secondaryProxyTicker: 'IYW',
    fxGapWeight: 0.3,
    proxySpreadThreshold: 0.016,
  },
  '161725': {
    shockThreshold: 0.016159570545573765,
    shockBaseBlend: 0.35,
    normalBaseBlend: 0.72,
    shockAmplify: 0.45,
    minReturn: -0.18,
    maxReturn: 0.18,
    kLearnRate: 0.06,
    biasLearnRate: 0.05,
    updateMinMove: 0.001,
    kMin: 0.35,
    kMax: 1.55,
    maxLeadMove: 0.15,
  },
};
async function loadOfflineResearchBootstrap(codes) {
  const adaptiveOverrides = {};
  const modelBootstrapByCode = {};

  for (const code of codes) {
    const payload = await readJson(path.join(projectRoot, 'public', 'generated', `${code}-offline-research.json`), null);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      continue;
    }

    const adaptiveModel = payload.adaptiveModel;
    if (adaptiveModel && typeof adaptiveModel === 'object' && !Array.isArray(adaptiveModel)) {
      const mapped = {};
      for (const key of ADAPTIVE_OFFLINE_PARAM_KEYS) {
        const value = adaptiveModel[key];
        if (typeof value === 'number' && Number.isFinite(value)) {
          mapped[key] = value;
        } else if (typeof value === 'boolean' || typeof value === 'string') {
          mapped[key] = value;
        }
      }

      if (Object.keys(mapped).length) {
        adaptiveOverrides[code] = mapped;
      }
    }

    const robustMae = Number(payload?.segmented?.maeValidation30Robust);
    const fallbackMae = Number(payload?.segmented?.maeValidation30);
    const bootstrapMae = Number.isFinite(robustMae)
      ? robustMae
      : Number.isFinite(fallbackMae)
        ? fallbackMae
        : Number.NaN;

    if (Number.isFinite(bootstrapMae) && bootstrapMae >= 0 && bootstrapMae < 0.2) {
      modelBootstrapByCode[code] = {
        sampleCount: OFFLINE_MODEL_BOOTSTRAP_SAMPLE_COUNT,
        meanAbsError: bootstrapMae,
      };
    }
  }

  return {
    adaptiveOverrides,
    modelBootstrapByCode,
  };
}

async function listOfflineResearchCodes() {
  const generatedDir = path.join(projectRoot, 'public', 'generated');
  try {
    const entries = await fs.readdir(generatedDir, { withFileTypes: true });
    const codes = [];
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }

      const matched = entry.name.match(/^(\d{6})-offline-research\.json$/);
      if (matched) {
        codes.push(matched[1]);
      }
    }
    return codes;
  } catch {
    return [];
  }
}

const offlineResearchCodes = await listOfflineResearchCodes();
const { adaptiveOverrides: offlineAdaptiveOverrides, modelBootstrapByCode: OFFLINE_MODEL_BOOTSTRAP_BY_CODE } = await loadOfflineResearchBootstrap(
  offlineResearchCodes,
);
const privateAdaptiveOverridesRaw = ENABLE_PRIVATE_ALGO ? await readJson(adaptiveAlgoPrivatePath, {}) : {};
const privateAdaptiveOverrides = privateAdaptiveOverridesRaw && typeof privateAdaptiveOverridesRaw === 'object' && !Array.isArray(privateAdaptiveOverridesRaw)
  ? privateAdaptiveOverridesRaw
  : {};
const adaptiveConfigCodes = [...new Set([
  ...Object.keys(PUBLIC_ADAPTIVE_HOLDINGS_ALGO_BY_CODE),
  ...Object.keys(privateAdaptiveOverrides),
])];
const ADAPTIVE_HOLDINGS_ALGO_BY_CODE = Object.fromEntries(
  adaptiveConfigCodes.map((code) => [
    code,
    {
      ...(PUBLIC_ADAPTIVE_HOLDINGS_ALGO_BY_CODE[code] ?? {}),
      ...(offlineAdaptiveOverrides[code] ?? {}),
      ...(privateAdaptiveOverrides[code] ?? {}),
    },
  ]),
);
let computeAdaptiveImpliedReturn = computeAdaptiveImpliedReturnPublic;
if (ENABLE_PRIVATE_ALGO) {
  try {
    const privateModule = await import(pathToFileURL(privateWatchlistCorePath).href);
    if (typeof privateModule?.computeAdaptiveImpliedReturn === 'function') {
      computeAdaptiveImpliedReturn = privateModule.computeAdaptiveImpliedReturn;
    }
  } catch (error) {
    console.warn(`[adaptive] private core not loaded: ${error instanceof Error ? error.message : String(error)}`);
  }
}
const HOLDINGS_161128 = [
  { ticker: 'NVDA', name: '英伟达', currency: 'USD' },
  { ticker: 'AAPL', name: '苹果', currency: 'USD' },
  { ticker: 'MSFT', name: '微软', currency: 'USD' },
  { ticker: 'AVGO', name: '博通', currency: 'USD' },
  { ticker: 'PLTR', name: 'Palantir', currency: 'USD' },
  { ticker: 'AMD', name: '超威半导体', currency: 'USD' },
  { ticker: 'ORCL', name: '甲骨文', currency: 'USD' },
  { ticker: 'MU', name: '美光科技', currency: 'USD' },
  { ticker: 'CSCO', name: '思科', currency: 'USD' },
  { ticker: 'IBM', name: 'IBM', currency: 'USD' },
];
const PROXY_BASKETS = {
  'us-tech-large': {
    name: '美股科技篮子',
    components: [
      { ticker: 'QQQ', name: 'Invesco QQQ Trust', weight: 0.7 },
      { ticker: 'XLK', name: 'Technology Select Sector SPDR', weight: 0.3 },
    ],
  },
  'us-sp-info-tech': {
    name: '标普信息科技篮子',
    components: [
      { ticker: 'XLK', name: 'Technology Select Sector SPDR', weight: 0.45 },
      { ticker: 'VGT', name: 'Vanguard Information Technology ETF', weight: 0.35 },
      { ticker: 'IYW', name: 'iShares U.S. Technology ETF', weight: 0.2 },
    ],
  },
  'us-semiconductor': {
    name: '半导体篮子',
    components: [{ ticker: 'SOXX', name: 'iShares Semiconductor ETF', weight: 1 }],
  },
  'cn-kr-semiconductor': {
    name: '中韩半导体篮子',
    components: [
      { ticker: '159995', name: '华夏国证半导体芯片ETF', weight: 0.5 },
      { ticker: 'SOXX', name: 'iShares Semiconductor ETF', weight: 0.5 },
    ],
  },
  'us-commodities': {
    name: '大宗商品篮子',
    components: [{ ticker: 'DBC', name: 'Invesco DB Commodity Index Tracking Fund', weight: 1 }],
  },
  'us-agriculture': {
    name: '农业商品篮子',
    components: [
      { ticker: 'SOYB', name: 'Teucrium Soybean Fund', weight: 0.55 },
      { ticker: 'DBA', name: 'Invesco DB Agriculture Fund', weight: 0.3 },
      { ticker: 'CORN', name: 'Teucrium Corn Fund', weight: 0.15 },
    ],
  },
  'us-gold': {
    name: '黄金篮子',
    components: [
      { ticker: 'GLD', name: 'SPDR Gold Shares', weight: 0.35 },
      { ticker: '518880', name: '华安黄金ETF', weight: 0.65 },
    ],
  },
  'us-silver': {
    name: '白银篮子',
    components: [{ ticker: 'SLV', name: 'iShares Silver Trust', weight: 1 }],
  },
  'us-precious-metals': {
    name: '贵金属篮子',
    components: [
      { ticker: 'GLD', name: 'SPDR Gold Shares', weight: 0.45 },
      { ticker: '518880', name: '华安黄金ETF', weight: 0.30 },
      { ticker: 'SLV', name: 'iShares Silver Trust', weight: 0.25 },
    ],
  },
  'us-oil': {
    name: '原油篮子',
    components: [
      { ticker: 'USO', name: 'United States Oil Fund', weight: 0.75 },
      { ticker: 'XLE', name: 'Energy Select Sector SPDR', weight: 0.25 },
    ],
  },
  'us-oil-upstream': {
    name: '油气上游篮子',
    components: [
      { ticker: 'XOP', name: 'SPDR S&P Oil & Gas E&P ETF', weight: 0.7 },
      { ticker: 'XLE', name: 'Energy Select Sector SPDR', weight: 0.3 },
    ],
  },
  'us-sandp500': {
    name: '标普500篮子',
    components: [{ ticker: 'SPY', name: 'SPDR S&P 500 ETF Trust', weight: 1 }],
  },
  'us-overseas-tech': {
    name: '海外科技篮子',
    components: [
      { ticker: 'IXN', name: 'iShares Global Tech ETF', weight: 0.35 },
      { ticker: 'XLK', name: 'Technology Select Sector SPDR', weight: 0.65 },
    ],
  },
  'us-nasdaq100': {
    name: '纳指100篮子',
    components: [{ ticker: 'QQQ', name: 'Invesco QQQ Trust', weight: 1 }],
  },
  'japan-nikkei225': {
    name: '日经225篮子',
    components: [
      { ticker: 'EWJ', name: 'iShares MSCI Japan ETF', weight: 0.4 },
      { ticker: 'DXJ', name: 'WisdomTree Japan Hedged Equity Fund', weight: 0.3 },
      { ticker: 'HEWJ', name: 'iShares Currency Hedged MSCI Japan ETF', weight: 0.2 },
      { ticker: 'FLJP', name: 'Franklin FTSE Japan ETF', weight: 0.1 },
    ],
  },
  'cn-coal': {
    name: '煤炭篮子',
    components: [{ ticker: '515220', name: '煤炭ETF', weight: 1 }],
  },
  'cn-csi500': {
    name: '中证500篮子',
    components: [{ ticker: '510500', name: '中证500ETF', weight: 1 }],
  },
  'cn-hs300': {
    name: '沪深300篮子',
    components: [{ ticker: '510300', name: '沪深300ETF', weight: 1 }],
  },
  'cn-giant100': {
    name: '巨潮100篮子',
    components: [{ ticker: '159901', name: '深100ETF', weight: 1 }],
  },
  'cn-csi1000': {
    name: '中证1000篮子',
    components: [{ ticker: '159845', name: '中证1000ETF', weight: 1 }],
  },
};
const GOLD_REALTIME_PROXY_CODES = new Set(['160719', '161116', '164701']);
const GOLD_US_PROXY_TICKERS = new Set(['GLD', 'IAU', 'UGL']);
const GOLD_DOMESTIC_PROXY_TICKERS = new Set(['518880']);
const GOLD_REALTIME_CARRY_MAX_MOVE = 0.03;
const GOLD_REALTIME_CARRY_ANOMALY_MOVE = 0.06;
const GOLD_CONTINUOUS_FACTOR_WEIGHT_BY_CODE = {
  '160719': 0.7,
  '161116': 0.65,
  '164701': 0.65,
};
const GOLD_CONTINUOUS_FACTOR_MAX_MOVE = 0.08;
const GOLD_CONTINUOUS_FACTOR_ANOMALY_MOVE = 0.12;
const GOLD_CLOSE_FORCE_TIME = '15:00:00';
const GOLD_CLOSE_FORCE_MIN_DROP = -0.08;
const GOLD_CLOSE_FORCE_MARKET_WEIGHT = 0.96;

// FUTURES_CONTINUOUS_BY_BASKET is disabled for now - Tencent API doesn't provide these symbols
// TODO: Find alternative CN futures API (SHFE/DCE direct APIs, Eastmoney, Sina real-time futures)
// Fallback: Using domestic fund anchors in REALTIME_PROXY_CARRY_CONFIG_BY_BASKET instead
const FUTURES_CONTINUOUS_BY_BASKET = {};

const SINA_FUTURES_CARRY_BY_BASKET = {
  'us-gold': { symbol: 'hf_XAU', name: '伦敦金现货' },
  'us-precious-metals': { symbol: 'hf_XAU', name: '伦敦金现货' },
};

const REALTIME_PROXY_CARRY_CONFIG_BY_BASKET = {
  'us-silver': {
    anchorCodes: ['161226'],
    maxMove: 0.04,
    anomalyMove: 0.08,
  },
  'us-oil': {
    anchorCodes: ['160723', '501018', '161129'],
    maxMove: 0.06,
    anomalyMove: 0.12,
  },
  'us-oil-upstream': {
    anchorCodes: ['159518', '162719', '162411', '160416'],
    maxMove: 0.06,
    anomalyMove: 0.12,
  },
  'us-nasdaq100': {
    anchorCodes: ['513100', '159509', '513300', '161130'],
    maxMove: 0.04,
    anomalyMove: 0.08,
  },
  'us-sandp500': {
    anchorCodes: ['513500', '162415', '161125'],
    maxMove: 0.035,
    anomalyMove: 0.07,
  },
};

function getFundIntradayReturn(fundQuote) {
  const currentPrice = Number(fundQuote?.marketPrice);
  const previousClose = Number(fundQuote?.previousClose);
  if (!(currentPrice > 0) || !(previousClose > 0)) {
    return null;
  }

  const raw = currentPrice / previousClose - 1;
  return Number.isFinite(raw) ? raw : null;
}

function isQuoteStaleAgainstMarket(quoteItem, marketDate, marketTime) {
  if (!marketDate) {
    return false;
  }

  const qDate = String(quoteItem?.quoteDate || '');
  const qTime = String(quoteItem?.quoteTime || '');
  const mDate = String(marketDate || '');
  const mTime = String(marketTime || '');

  if (qDate !== mDate) {
    return true;
  }

  if (!mTime) {
    return false;
  }

  if (!qTime) {
    return true;
  }

  return qTime < mTime;
}

function applyAnchorCarryToProxyQuotes(proxyQuotes, marketDate, marketTime, carryReturnRaw, maxMove, anomalyMove) {
  if (!Array.isArray(proxyQuotes) || proxyQuotes.length === 0) {
    return proxyQuotes;
  }

  if (!Number.isFinite(carryReturnRaw)) {
    return proxyQuotes;
  }

  if (Number.isFinite(anomalyMove) && Math.abs(carryReturnRaw) > anomalyMove) {
    return proxyQuotes;
  }

  const hasStaleUsdProxy = proxyQuotes.some((item) => item?.currency === 'USD' && isQuoteStaleAgainstMarket(item, marketDate, marketTime));
  if (!hasStaleUsdProxy) {
    return proxyQuotes;
  }

  const maxCarry = Number.isFinite(maxMove) ? maxMove : MAX_PROXY_MOVE;
  const carryReturn = clamp(carryReturnRaw, -maxCarry, maxCarry);

  return proxyQuotes.map((item) => {
    const hasValidBase = Number.isFinite(item?.previousClose) && item.previousClose > 0;
    const needsCarry = item?.currency === 'USD' && hasValidBase && isQuoteStaleAgainstMarket(item, marketDate, marketTime);
    if (!needsCarry) {
      return item;
    }

    const carriedCurrent = item.currentPrice * (1 + carryReturn);
    if (!Number.isFinite(carriedCurrent) || carriedCurrent <= 0) {
      return item;
    }

    return {
      ...item,
      currentPrice: carriedCurrent,
      quoteDate: String(marketDate || item.quoteDate || ''),
      quoteTime: String(marketTime || item.quoteTime || ''),
    };
  });
}

function applyGoldRealtimeCarryToProxyQuotes(proxyQuotes, marketDate, marketTime) {
  if (!Array.isArray(proxyQuotes) || proxyQuotes.length === 0) {
    return proxyQuotes;
  }

  const hasStaleUsdGold = proxyQuotes.some((item) => {
    const ticker = String(item?.ticker || '').toUpperCase();
    return GOLD_US_PROXY_TICKERS.has(ticker) && isQuoteStaleAgainstMarket(item, marketDate, marketTime);
  });

  const domesticAnchor = proxyQuotes.find((item) => {
    const ticker = String(item?.ticker || '').toUpperCase();
    return GOLD_DOMESTIC_PROXY_TICKERS.has(ticker)
      && Number.isFinite(item?.currentPrice)
      && item.currentPrice > 0
      && Number.isFinite(item?.previousClose)
      && item.previousClose > 0;
  });
  if (!domesticAnchor) {
    return proxyQuotes;
  }

  const domesticReturnRaw = domesticAnchor.currentPrice / domesticAnchor.previousClose - 1;
  if (!Number.isFinite(domesticReturnRaw)) {
    return proxyQuotes;
  }
  const isDomesticReturnAnomaly = Math.abs(domesticReturnRaw) > GOLD_REALTIME_CARRY_ANOMALY_MOVE;
  const domesticReturn = isDomesticReturnAnomaly
    ? 0
    : clamp(domesticReturnRaw, -GOLD_REALTIME_CARRY_MAX_MOVE, GOLD_REALTIME_CARRY_MAX_MOVE);

  const carriedQuotes = proxyQuotes.map((item) => {
    const ticker = String(item?.ticker || '').toUpperCase();
    const isUsdGoldProxy = GOLD_US_PROXY_TICKERS.has(ticker);
    const hasValidBase = Number.isFinite(item?.previousClose) && item.previousClose > 0;
    const needsCarry = isUsdGoldProxy && hasValidBase && isQuoteStaleAgainstMarket(item, marketDate, marketTime);
    if (!needsCarry) {
      return item;
    }

    // Anchor at latest US close and extend by domestic intraday move.
    const carriedCurrent = item.currentPrice * (1 + domesticReturn);
    if (!Number.isFinite(carriedCurrent) || carriedCurrent <= 0) {
      return item;
    }

    return {
      ...item,
      currentPrice: carriedCurrent,
      quoteDate: String(marketDate || item.quoteDate || ''),
      quoteTime: String(marketTime || item.quoteTime || ''),
    };
  });

  const stabilizedQuotes = isDomesticReturnAnomaly
    ? carriedQuotes.map((item) => {
        const ticker = String(item?.ticker || '').toUpperCase();
        const isDomesticGold = GOLD_DOMESTIC_PROXY_TICKERS.has(ticker);
        const hasValidBase = Number.isFinite(item?.previousClose) && item.previousClose > 0;
        if (!isDomesticGold || !hasValidBase) {
          return item;
        }

        return {
          ...item,
          currentPrice: item.previousClose,
          quoteDate: String(marketDate || item.quoteDate || ''),
          quoteTime: String(marketTime || item.quoteTime || ''),
        };
      })
    : carriedQuotes;

  if (!hasStaleUsdGold || isDomesticReturnAnomaly) {
    return stabilizedQuotes;
  }

  const domesticWeightTarget = 0.8;
  const domesticIndex = stabilizedQuotes.findIndex((item) => GOLD_DOMESTIC_PROXY_TICKERS.has(String(item?.ticker || '').toUpperCase()));
  if (domesticIndex < 0) {
    return stabilizedQuotes;
  }

  const nonDomesticTotalWeight = stabilizedQuotes.reduce((sum, item, index) => {
    if (index === domesticIndex) {
      return sum;
    }

    return sum + Math.max(0, Number(item?.weight) || 0);
  }, 0);
  if (!(nonDomesticTotalWeight > 0)) {
    return stabilizedQuotes;
  }

  return stabilizedQuotes.map((item, index) => {
    if (index === domesticIndex) {
      return {
        ...item,
        weight: domesticWeightTarget,
      };
    }

    const baseWeight = Math.max(0, Number(item?.weight) || 0);
    return {
      ...item,
      weight: (1 - domesticWeightTarget) * (baseWeight / nonDomesticTotalWeight),
    };
  });
}

const RELATED_ETF_FALLBACKS = {
  '501011': '560080',
  '161130': '159696',
};
const DISPLAY_NAME_OVERRIDES = {
  '513880': '华安日经225ETF',
  '513520': '华夏日经225ETF',
  '159985': '豆粕ETF',
};
const ARCHIVE_HOLDING_TICKER_MAP = {
  'BRK_B': { ticker: 'BRK.B' },
  'BP.': { ticker: 'BP' },
  'TTEFP': { ticker: 'TTE' },
  'ENBCN': { ticker: 'ENB' },
  'CNQCN': { ticker: 'CNQ' },
};
const SPECIAL_QUOTE_SYMBOL_MAP = {
  '7203.JP': 'usTM',
  '6758.JP': 'usSONY',
  '9983.JP': 'usSFTBY',
  '9984.JP': 'usSFTBY',
  '9432.JP': 'usNTTYY',
  '9433.JP': 'usSFTBY',
  '8035.JP': 'usTOELY',
  '6861.JP': 'usKYCCF',
  '6501.JP': 'usHTHIY',
  '4063.JP': 'usSHECY',
  '8306.JP': 'usMUFG',
  '8316.JP': 'usSMFG',
  '6098.JP': 'usRKUNY',
  '4519.JP': 'usCHGCY',
  '7974.JP': 'usNTDOY',
  '4661.JP': 'usOLCLY',
  '8766.JP': 'usTKOMY',
  '8001.JP': 'usMITUY',
  '8031.JP': 'usMITSY',
  '7267.JP': 'usHMC',
  '7269.JP': 'usSZKMY',
  '9020.JP': 'usJAPSY',
  '9022.JP': 'usCHCJY',
  '4502.JP': 'usTAK',
  RIGD: 'ukRIGD',
};
const HOLDINGS_SIGNAL_MIN_COVERAGE_BY_CODE = {
  '513310': 0.55,
  '161128': 0.65,
};
const SUPPLEMENTAL_NOTICE_HOLDINGS = {
  '160216': [
    { ticker: 'CPER', aliases: ['United States Copper Index Fund'] },
    { ticker: 'GLD', aliases: ['SPDR Gold Shares ETF', 'SPDR Gold ETF'] },
    { ticker: 'GLDM', aliases: ['SPDR Gold MiniShares Trust', 'MiniShares Trust'] },
    { ticker: 'SGOL', aliases: ['abrdn Physical Gold Shares ETF', 'abrdn Physical Gold ETF'] },
    { ticker: 'UGL', aliases: ['ProShares Ultra Gold ETF'] },
    { ticker: 'COPX', aliases: ['Global X Copper Miners ETF'] },
    { ticker: 'DBB', aliases: ['Invesco DB Base Metals Fund'] },
    { ticker: 'GDXU', aliases: ['MicroSectors Gold Miners 3X Leveraged ETN', 'Gold Miners 3X Leveraged ETN'] },
  ],
  '161116': [
    { ticker: 'GLD', aliases: ['SPDR Gold Shares ETF'] },
    { ticker: 'SGOL', aliases: ['abrdn Physical Gold Shares ETF'] },
    { ticker: 'GLDM', aliases: ['SPDR Gold MiniShares ETF Trust', 'SPDR Gold MiniShares Trust'] },
    { ticker: 'IAU', aliases: ['iShares Gold Trust ETF', 'iShares Gold Trust'] },
    { ticker: 'UBS_GOLD', quoteTicker: 'GLD', aliases: ['UBS Gold ETF'] },
    { ticker: 'UGL', aliases: ['ProShares Ultra Gold ETF'] },
  ],
  '164701': [
    { ticker: 'UGL', aliases: ['ProShares Ultra Gold ETF'] },
    { ticker: 'GLDM', aliases: ['SPDR Gold MiniShares Trust'] },
    { ticker: 'GLD', aliases: ['SPDR Gold Shares ETF'] },
    { ticker: 'AAAU', aliases: ['Goldman Sachs Physical Gold ETF'] },
    { ticker: 'SIVR', aliases: ['abrdn Physical Silver Shares ETF'] },
  ],
  '160719': [
    { ticker: 'GLD', aliases: ['SPDR Gold Shares ETF'] },
    { ticker: 'SGOL', aliases: ['abrdn Physical Gold Shares ETF', 'Physical Gold Shares ETF'] },
    { ticker: 'IAU', aliases: ['iShares Gold Trust ETF', 'iShares Gold Trust'] },
    { ticker: 'SWISSCANTO_GOLD', quoteTicker: 'GLD', aliases: ['Swisscanto CH Gold ETF'] },
    { ticker: 'ETF_SECURITIES_GOLD', quoteTicker: 'GLD', aliases: ['ETF Securities Gold ETF'] },
    { ticker: 'ISHARES_GOLD_CH', quoteTicker: 'GLD', aliases: ['iShares Gold ETF CH'] },
  ],
  '513310': [
    { ticker: '005930', quoteTicker: 'SOXX', aliases: ['SamsungElectronics', 'Samsung Electronics'] },
  ],
  '513730': [
    { ticker: 'EEMA', aliases: ['CSOP IEDGE SEA+ TECH ETF USD', 'CSOP IEDGE SEA TECH ETF USD', 'CSOP IEDGE SEA+TECH ETF USD'] },
    { ticker: 'EWT', aliases: ['iShares MSCI Taiwan ETF', 'MSCI Taiwan ETF'] },
    { ticker: 'EWY', aliases: ['iShares MSCI South Korea ETF', 'MSCI South Korea ETF'] },
    { ticker: 'EWS', aliases: ['iShares MSCI Singapore ETF', 'MSCI Singapore ETF'] },
    { ticker: 'FXSG', aliases: ['First Trust Singapore AlphaDEX Fund', 'Singapore AlphaDEX Fund'] },
    { ticker: 'FLKR', aliases: ['Franklin FTSE South Korea ETF'] },
    { ticker: 'VPL', aliases: ['Vanguard FTSE Pacific ETF'] },
    { ticker: 'SOXX', aliases: ['iShares Semiconductor ETF'] },
    { ticker: 'EEMA', aliases: ['iShares MSCI Emerging Markets Asia ETF', 'MSCI EM Asia ETF'] },
  ],
  '501312': [
    { ticker: 'ARKK', aliases: ['ARK Innovation ETF'] },
    { ticker: 'ARKG', aliases: ['ARK Genomic Revolution ETF'] },
    { ticker: 'ARKQ', aliases: ['ARK Autonomous Technology & Robotics ETF'] },
    { ticker: 'SOXX', aliases: ['iShares Semiconductor ETF'] },
    { ticker: 'AIQ', aliases: ['Global X Artificial Intelligence & Technology ETF', 'Artificial Intelligence & Technology ETF'] },
    { ticker: 'BOTZ', aliases: ['Global X Robotics & Artificial Intelligence ETF'] },
    { ticker: 'QQQ', aliases: ['Invesco QQQ Trust Series 1'] },
    { ticker: 'XLK', aliases: ['Technology Select Sector SPDR ETF'] },
    { ticker: 'SMH', aliases: ['VanEck Semiconductor ETF'] },
    { ticker: 'FINX', aliases: ['Global X FinTech ETF', 'FinTech ETF'] },
  ],
  '501018': [
    { ticker: 'USO', aliases: ['United States Oil Fund LP', 'United States Oil ETF', 'United States Oil'] },
    { ticker: 'BNO', aliases: ['United States Brent Oil Fund LP', 'Brent Oil Fund LP'] },
    { ticker: 'DBO', aliases: ['Invesco DB Oil Fund', 'Invesco DB Oil'] },
    { ticker: 'WTI_ETC', quoteTicker: 'USO', aliases: ['WisdomTree WTI Crude Oil ETF', 'WisdomTree WTI Crude Oil ETC'] },
    { ticker: 'BRENT_ETC', quoteTicker: 'BNO', aliases: ['WisdomTree Brent Crude Oil ETF', 'WisdomTree Brent Crude Oil ETC'] },
    { ticker: 'SIMPLEX_WTI', quoteTicker: 'USO', aliases: ['Simplex WTI ETF'] },
    { ticker: '1699', quoteTicker: 'USO', aliases: ['NEXT FUNDS NOMURA Crude Oil Long Index Linked ETF'] },
    { ticker: 'UBS_CMCI_OIL', quoteTicker: 'DBO', aliases: ['UBS CMCI Oil SF ETF'] },
  ],
  '501225': [
    { ticker: 'SMH', aliases: ['VanEck Semiconductor ETF'] },
    { ticker: 'SOXQ', aliases: ['Invesco PHLX Semiconductor ETF', 'PHLX Semiconductor ETF'] },
    { ticker: 'SOXX', aliases: ['iShares Semiconductor ETF'] },
    { ticker: 'PSI', aliases: ['Invesco Dynamic Semiconductors ETF', 'Dynamic Semiconductors ETF'] },
    { ticker: '159995', aliases: ['华夏国证半导体芯片ETF', '国证半导体芯片 ETF'] },
    { ticker: '512760', aliases: ['国泰CES半导体芯片行业ETF', 'CES 半导体芯片行业 ETF'] },
    { ticker: '159560', aliases: ['景顺长城中证芯片产业ETF', '中证芯片产业 ETF'] },
    { ticker: '2644', quoteTicker: 'SOXX', aliases: ['Global X Semiconductor ETF/Jap'] },
  ],
  '161129': [
    { ticker: 'WTI_ETC', quoteTicker: 'USO', aliases: ['WisdomTree WTI Crude Oil ETC'] },
    { ticker: 'BRENT_ETC', quoteTicker: 'BNO', aliases: ['WisdomTree Brent Crude Oil ETC'] },
    { ticker: 'DBO', aliases: ['Invesco DB Oil Fund', 'Invesco DB Oil'] },
    { ticker: 'SIMPLEX_WTI', quoteTicker: 'USO', aliases: ['Simplex WTI ETF'] },
    { ticker: '1699', quoteTicker: 'USO', aliases: ['NEXT FUNDS NOMURA Crude Oil Long Index Linked ETF'] },
    { ticker: '03175', aliases: ['Samsung S&P GSCI Crude Oil ER Futures ETF', 'F SAMSUNG OIL'] },
  ],
  '160723': [
    { ticker: 'USO', aliases: ['United States Oil Fund LP', 'United States Oil ETF'] },
    { ticker: 'WTI_ETC', quoteTicker: 'USO', aliases: ['WisdomTree WTI Crude Oil', 'WisdomTree WTI Crude Oil ETC'] },
    { ticker: 'SIMPLEX_WTI', quoteTicker: 'USO', aliases: ['Simplex WTI ETF'] },
    { ticker: 'BRENT_ETC', quoteTicker: 'BNO', aliases: ['WisdomTree Brent Crude Oil', 'WisdomTree Brent Crude Oil ETC'] },
    { ticker: 'BNO', aliases: ['United States Brent Oil Fund LP', 'Brent Oil Fund LP'] },
    { ticker: '1699', quoteTicker: 'USO', aliases: ['NEXT FUNDS NOMURA Crude Oil Long Index Linked Exchange Traded', 'NEXT FUNDS NOMURA Crude Oil Long Index Linked ETF'] },
    { ticker: 'BRENT_BBG_ETC', quoteTicker: 'BNO', aliases: ['WisdomTree Bloomberg Brent Crude Oil'] },
  ],
};
let intradayPromise = null;

function clamp(value, limit) {
  return Math.max(-limit, Math.min(limit, value));
}

function clampRange(value, minValue, maxValue) {
  return Math.max(minValue, Math.min(maxValue, value));
}

function getWeightedProxyReturn(runtime) {
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

function getHoldingLineReturn(item) {
  if (item.previousClose <= 0) {
    return 0;
  }

  return item.currentPrice / item.previousClose - 1;
}

function getWeightedHoldingReturn(runtime) {
  const disclosedByTicker = new Map((runtime.disclosedHoldings ?? []).map((item) => [item.ticker.toUpperCase(), item]));
  const weightedQuotes = (runtime.holdingQuotes ?? [])
    .map((item) => {
      const disclosed = disclosedByTicker.get(item.ticker.toUpperCase());
      if (!disclosed?.weight || item.previousClose <= 0) {
        return null;
      }

      return {
        weight: disclosed.weight,
        lineReturn: getHoldingLineReturn(item),
      };
    })
    .filter(Boolean);
  const totalWeight = weightedQuotes.reduce((sum, item) => sum + item.weight, 0);

  if (totalWeight <= 0) {
    return 0;
  }

  return weightedQuotes.reduce((sum, item) => sum + item.lineReturn * (item.weight / totalWeight), 0);
}

function getAnnouncedHoldingsCoverageWeight(runtime) {
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

function hasHoldingsSignal(runtime) {
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

  const coverageWeight = getAnnouncedHoldingsCoverageWeight(runtime);
  return coveredCount >= Math.min(3, requiredCount) && coverageWeight >= minCoverage;
}

function getBlendedHoldingLeadReturn(runtime) {
  const holdingsCoverage = getAnnouncedHoldingsCoverageWeight(runtime);
  const holdingsReturn = getWeightedHoldingReturn(runtime);
  const proxyReturn = getWeightedProxyReturn(runtime);
  const proxyWeight = runtime.estimateMode === 'proxy' ? 1 - holdingsCoverage : 0;

  return holdingsReturn * (1 - proxyWeight) + proxyReturn * proxyWeight;
}

function blendGoldContinuousLeadReturn(runtime, baseLeadReturn, useProxyEstimate) {
  if (!useProxyEstimate || !GOLD_REALTIME_PROXY_CODES.has(runtime.code)) {
    return {
      leadReturn: baseLeadReturn,
      goldContinuousApplied: false,
      goldContinuousReturn: null,
      goldContinuousWeight: 0,
    };
  }

  const rawContinuousReturn = toFiniteNumber(runtime.goldContinuousReturn);
  if (!Number.isFinite(rawContinuousReturn) || Math.abs(rawContinuousReturn) > GOLD_CONTINUOUS_FACTOR_ANOMALY_MOVE) {
    return {
      leadReturn: baseLeadReturn,
      goldContinuousApplied: false,
      goldContinuousReturn: Number.isFinite(rawContinuousReturn) ? rawContinuousReturn : null,
      goldContinuousWeight: 0,
    };
  }

  const blendedWeightRaw = Number(GOLD_CONTINUOUS_FACTOR_WEIGHT_BY_CODE[runtime.code]);
  const blendedWeight = Number.isFinite(blendedWeightRaw) ? clampRange(blendedWeightRaw, 0, 0.9) : 0;
  if (!(blendedWeight > 0)) {
    return {
      leadReturn: baseLeadReturn,
      goldContinuousApplied: false,
      goldContinuousReturn: rawContinuousReturn,
      goldContinuousWeight: 0,
    };
  }

  const continuousReturn = clamp(rawContinuousReturn, GOLD_CONTINUOUS_FACTOR_MAX_MOVE);
  const leadReturn = baseLeadReturn * (1 - blendedWeight) + continuousReturn * blendedWeight;

  return {
    leadReturn,
    goldContinuousApplied: true,
    goldContinuousReturn: continuousReturn,
    goldContinuousWeight: blendedWeight,
  };
}

function applyGoldCloseForceImpliedReturn(runtime, impliedReturn) {
  if (!GOLD_REALTIME_PROXY_CODES.has(runtime.code)) {
    return {
      impliedReturn,
      forced: false,
      forcedBy: null,
    };
  }

  const marketTime = String(runtime.marketTime || '');
  if (!marketTime || marketTime < GOLD_CLOSE_FORCE_TIME) {
    return {
      impliedReturn,
      forced: false,
      forcedBy: null,
    };
  }

  const marketPrice = Number(runtime.marketPrice);
  const previousClose = Number(runtime.previousClose);
  if (!(marketPrice > 0) || !(previousClose > 0)) {
    return {
      impliedReturn,
      forced: false,
      forcedBy: null,
    };
  }

  const marketReturn = marketPrice / previousClose - 1;
  if (!Number.isFinite(marketReturn) || marketReturn >= 0) {
    return {
      impliedReturn,
      forced: false,
      forcedBy: null,
    };
  }

  const floorByMarket = Math.min(-0.0001, marketReturn * GOLD_CLOSE_FORCE_MARKET_WEIGHT);
  const forcedFloor = Math.min(floorByMarket, GOLD_CLOSE_FORCE_MIN_DROP);
  const forcedImplied = Math.min(impliedReturn, forcedFloor);

  if (forcedImplied === impliedReturn) {
    return {
      impliedReturn,
      forced: false,
      forcedBy: null,
    };
  }

  return {
    impliedReturn: forcedImplied,
    forced: true,
    forcedBy: {
      marketReturn,
      forcedFloor,
    },
  };
}

function hasUsdHoldingSignal(runtime) {
  return (runtime.holdingQuotes ?? []).some((item) => item.currency === 'USD');
}

function getFxReturn(runtime) {
  const currentRate = runtime.fx?.currentRate ?? 0;
  const previousCloseRate = runtime.fx?.previousCloseRate ?? 0;
  return currentRate > 0 && previousCloseRate > 0 ? currentRate / previousCloseRate - 1 : 0;
}

function getHoldingReturnByTicker(runtime, ticker) {
  const upper = String(ticker || '').toUpperCase();
  const quote = (runtime.holdingQuotes ?? []).find((item) => String(item?.ticker || '').toUpperCase() === upper);
  if (!quote || !(quote.previousClose > 0) || !(quote.currentPrice > 0)) {
    return null;
  }

  return quote.currentPrice / quote.previousClose - 1;
}

function getNavDayGap(runtime) {
  const navDate = runtime.navDate;
  if (!navDate || !Array.isArray(runtime.navHistory) || runtime.navHistory.length < 2) {
    return 1;
  }

  const dates = [...new Set(runtime.navHistory.map((item) => item?.date).filter(Boolean))].sort();
  const index = dates.indexOf(navDate);
  if (index <= 0) {
    return 1;
  }

  const prevDate = new Date(`${dates[index - 1]}T00:00:00Z`);
  const currDate = new Date(`${dates[index]}T00:00:00Z`);
  if (Number.isNaN(prevDate.getTime()) || Number.isNaN(currDate.getTime())) {
    return 1;
  }

  return Math.max(1, Math.round((currDate.getTime() - prevDate.getTime()) / 86400000));
}

function getOilGapSignal(runtime, adaptiveConfig, leadReturn, closeGapReturn, dayGapDays) {
  const primaryTicker = adaptiveConfig?.primaryProxyTicker ?? 'USO';
  const secondaryTicker = adaptiveConfig?.secondaryProxyTicker ?? 'BNO';
  const primaryReturn = getHoldingReturnByTicker(runtime, primaryTicker);
  const secondaryReturn = getHoldingReturnByTicker(runtime, secondaryTicker);
  const hasPrimary = Number.isFinite(primaryReturn);
  const hasSecondary = Number.isFinite(secondaryReturn);
  const proxyWeight = hasPrimary && hasSecondary ? 0.7 : 1;
  const blendedProxyReturn = hasPrimary && hasSecondary
    ? primaryReturn * proxyWeight + secondaryReturn * (1 - proxyWeight)
    : hasPrimary
      ? primaryReturn
      : hasSecondary
        ? secondaryReturn
        : leadReturn;
  const proxySpread = hasPrimary && hasSecondary ? primaryReturn - secondaryReturn : 0;
  const gapSignal = 0.7 * (leadReturn - blendedProxyReturn) + 0.3 * proxySpread + (adaptiveConfig?.fxGapWeight ?? 0.45) * closeGapReturn;
  const isGapDayHint = dayGapDays > 1 || Math.abs(proxySpread) >= (adaptiveConfig?.proxySpreadThreshold ?? 0.018) || Math.abs(gapSignal) >= 0.02;

  return {
    oilProxyReturn: blendedProxyReturn,
    oilSpread: proxySpread,
    gapSignal,
    isGapDayHint,
  };
}

function toIsoDateWithOffset(days) {
  const value = new Date();
  value.setDate(value.getDate() + days);
  return value.toISOString().slice(0, 10);
}

function getSnapshotPriceType(runtime) {
  return runtime.pageCategory === 'domestic-lof' && runtime.marketTime >= '15:00:00' ? 'close' : 'intraday';
}

function finalizeSnapshotWithClose(snapshot, runtime) {
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

function pruneJournal(journal) {
  const cutoffDate = toIsoDateWithOffset(-JOURNAL_RETENTION_DAYS);

  return {
    snapshots: (journal.snapshots ?? []).filter((item) => item.estimateDate >= cutoffDate),
    errors: (journal.errors ?? []).filter((item) => item.date >= cutoffDate),
  };
}

function getDefaultWatchlistModel() {
  return {
    alpha: 0,
    betaLead: 0.38,
    betaGap: 0,
    adaptiveK: 1,
    adaptiveBias: 0,
    lastTargetReturn: 0,
    learningRate: 0.24,
    sampleCount: 0,
    meanAbsError: 0,
  };
}

function getDefaultJournal() {
  return {
    snapshots: [],
    errors: [],
  };
}

function normalizePersistedState(code, entry) {
  if (!entry) {
    const model = applyOfflineModelBootstrap(code, getDefaultWatchlistModel());
    return {
      modelVersion: WATCHLIST_STATE_VERSION,
      model,
      journal: getDefaultJournal(),
    };
  }

  const baseModel = entry.modelVersion === WATCHLIST_STATE_VERSION
    ? { ...getDefaultWatchlistModel(), ...(entry.model ?? {}) }
    : getDefaultWatchlistModel();

  return {
    modelVersion: WATCHLIST_STATE_VERSION,
    model: applyOfflineModelBootstrap(code, baseModel),
    journal: pruneJournal({
      snapshots: entry.journal?.snapshots ?? [],
      errors: entry.journal?.errors ?? [],
    }),
  };
}

function applyOfflineModelBootstrap(code, model) {
  const bootstrap = OFFLINE_MODEL_BOOTSTRAP_BY_CODE[code];
  if (!bootstrap) {
    return model;
  }

  const sampleCount = Number.isFinite(model.sampleCount) ? model.sampleCount : 0;
  const meanAbsError = Number.isFinite(model.meanAbsError) ? model.meanAbsError : Number.NaN;
  if (sampleCount >= bootstrap.sampleCount && Number.isFinite(meanAbsError) && meanAbsError > 0) {
    return model;
  }

  const validSampleCount = Math.max(0, sampleCount);
  const validMeanAbsError = Number.isFinite(meanAbsError) && meanAbsError >= 0 ? meanAbsError : bootstrap.meanAbsError;
  const mergedMeanAbsError = (validMeanAbsError * validSampleCount + bootstrap.meanAbsError * bootstrap.sampleCount)
    / Math.max(1, validSampleCount + bootstrap.sampleCount);

  return {
    ...model,
    sampleCount: Math.max(validSampleCount, bootstrap.sampleCount),
    meanAbsError: mergedMeanAbsError,
    lastUpdatedAt: model.lastUpdatedAt || new Date().toISOString(),
  };
}

function getAdaptiveAlgoConfig(runtime) {
  return ADAPTIVE_HOLDINGS_ALGO_BY_CODE[runtime.code] ?? null;
}

function protectStaleLeadSignal(runtime, rawLeadReturn, useHoldingsEstimate, useProxyEstimate, journal) {
  if (!useHoldingsEstimate || useProxyEstimate) {
    return {
      leadReturn: rawLeadReturn,
      staleLeadGuarded: false,
    };
  }

  if (Math.abs(rawLeadReturn) < STALE_LEAD_SIGNAL_THRESHOLD) {
    return {
      leadReturn: rawLeadReturn,
      staleLeadGuarded: false,
    };
  }

  const snapshots = Array.isArray(journal?.snapshots) ? journal.snapshots : [];
  const recent = snapshots.slice(-2).filter((item) => Number.isFinite(item?.leadReturn));
  if (recent.length < 2) {
    return {
      leadReturn: rawLeadReturn,
      staleLeadGuarded: false,
    };
  }

  const lastLead = recent[recent.length - 1].leadReturn;
  const prevLead = recent[recent.length - 2].leadReturn;
  const repeated = Math.abs(lastLead - prevLead) <= STALE_LEAD_REPEAT_EPSILON
    && Math.abs(rawLeadReturn - lastLead) <= STALE_LEAD_REPEAT_EPSILON;
  if (!repeated) {
    return {
      leadReturn: rawLeadReturn,
      staleLeadGuarded: false,
    };
  }

  const proxyReturn = getWeightedProxyReturn(runtime);
  const blended = rawLeadReturn * (1 - STALE_LEAD_PROXY_BLEND) + proxyReturn * STALE_LEAD_PROXY_BLEND;

  return {
    leadReturn: clamp(blended, STALE_LEAD_CLAMP),
    staleLeadGuarded: true,
  };
}

function estimateWatchlistFund(runtime, model, journal = null) {
  const anchorNav = runtime.officialNavT1;
  const useHoldingsEstimate = hasHoldingsSignal(runtime);
  const useProxyEstimate = runtime.estimateMode === 'proxy' && !useHoldingsEstimate;
  const adaptiveConfig = getAdaptiveAlgoConfig(runtime);
  const modeLeadReturn = useProxyEstimate
    ? getWeightedProxyReturn(runtime)
    : useHoldingsEstimate
      ? getBlendedHoldingLeadReturn(runtime)
      : runtime.previousClose > 0
        ? runtime.marketPrice / runtime.previousClose - 1
        : 0;
  const goldContinuousBlend = blendGoldContinuousLeadReturn(runtime, modeLeadReturn, useProxyEstimate);
  const rawLeadReturn = goldContinuousBlend.leadReturn;
  const { leadReturn: stabilizedLeadReturn } = protectStaleLeadSignal(runtime, rawLeadReturn, useHoldingsEstimate, useProxyEstimate, journal);
  const leadMoveCap = useProxyEstimate ? MAX_PROXY_MOVE : (adaptiveConfig?.maxLeadMove ?? MAX_MARKET_MOVE);
  const leadReturn = clamp(stabilizedLeadReturn, leadMoveCap);
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
  const baseImpliedReturn = learnedBiasReturn + model.betaLead * leadReturn + model.betaGap * closeGapReturn;
  let impliedReturn = baseImpliedReturn;
  let adaptiveUsed = false;
  let adaptiveShockTriggered = false;

  if (adaptiveConfig && useHoldingsEstimate && !useProxyEstimate) {
    const dayGapDays = getNavDayGap(runtime);
    const gapInfo = adaptiveConfig.enableOilSessionGap
      ? getOilGapSignal(runtime, adaptiveConfig, leadReturn, closeGapReturn, dayGapDays)
      : { gapSignal: 0, isGapDayHint: false };
    const adaptiveResult = computeAdaptiveImpliedReturn({
      adaptiveConfig,
      model,
      leadReturn,
      closeGapReturn,
      baseImpliedReturn,
      dayGapDays,
      gapInfo,
    });
    impliedReturn = adaptiveResult.impliedReturn;
    adaptiveUsed = Boolean(adaptiveResult.adaptiveUsed);
    adaptiveShockTriggered = Boolean(adaptiveResult.adaptiveShockTriggered);
  }

  const goldCloseForced = applyGoldCloseForceImpliedReturn(runtime, impliedReturn);
  impliedReturn = goldCloseForced.impliedReturn;

  const estimatedNav = anchorNav * (1 + impliedReturn);
  const premiumRate = estimatedNav > 0 ? runtime.marketPrice / estimatedNav - 1 : 0;

  return {
    anchorNav,
    leadReturn,
    modeLeadReturn,
    closeGapReturn,
    learnedBiasReturn,
    impliedReturn,
    estimatedNav,
    premiumRate,
    adaptiveUsed,
    adaptiveShockTriggered,
    goldContinuousApplied: goldContinuousBlend.goldContinuousApplied,
    goldContinuousReturn: goldContinuousBlend.goldContinuousReturn,
    goldContinuousWeight: goldContinuousBlend.goldContinuousWeight,
    goldCloseForceApplied: goldCloseForced.forced,
    goldCloseForceFloor: Number.isFinite(goldCloseForced.forcedBy?.forcedFloor) ? goldCloseForced.forcedBy.forcedFloor : null,
  };
}

function reconcileJournal(runtime, currentModel, currentJournal) {
  const adaptiveConfig = getAdaptiveAlgoConfig(runtime);
  const actualNavByDate = new Map(runtime.navHistory.map((item) => [item.date, item.nav]));
  const normalizedJournal = pruneJournal({
    ...currentJournal,
    snapshots: (currentJournal.snapshots ?? []).map((item) => finalizeSnapshotWithClose(item, runtime)),
  });
  const baseJournal = normalizedJournal;
  const trainedDates = new Set(baseJournal.errors.map((item) => item.date));
  const errorByDate = new Map(baseJournal.errors.map((item) => [item.date, item]));
  let model = { ...getDefaultWatchlistModel(), ...currentModel };
  let latestTargetReturn = Number.isFinite(model.lastTargetReturn) ? model.lastTargetReturn : 0;

  for (const snapshot of baseJournal.snapshots) {
    const actualNav = actualNavByDate.get(snapshot.estimateDate);
    if (!actualNav) {
      continue;
    }

    const targetReturn = snapshot.anchorNav > 0 ? actualNav / snapshot.anchorNav - 1 : 0;
    latestTargetReturn = targetReturn;
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
        adaptiveBias: adaptiveConfig && snapshot.adaptiveUsed
          ? (Number.isFinite(model.adaptiveBias) ? model.adaptiveBias : 0) + adaptiveConfig.biasLearnRate * residualError
          : (Number.isFinite(model.adaptiveBias) ? model.adaptiveBias : 0),
        adaptiveK: (() => {
          const currentAdaptiveK = Number.isFinite(model.adaptiveK) ? model.adaptiveK : 1;
          if (!adaptiveConfig || !snapshot.adaptiveUsed || Math.abs(snapshot.leadReturn) < adaptiveConfig.updateMinMove) {
            return currentAdaptiveK;
          }

          const ratio = clampRange(targetReturn / snapshot.leadReturn, adaptiveConfig.kMin, adaptiveConfig.kMax);
          return (1 - adaptiveConfig.kLearnRate) * currentAdaptiveK + adaptiveConfig.kLearnRate * ratio;
        })(),
        sampleCount: nextSampleCount,
        meanAbsError: nextMae,
        lastUpdatedAt: new Date().toISOString(),
      };
      trainedDates.add(snapshot.estimateDate);
    }

    errorByDate.set(snapshot.estimateDate, {
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
    });
  }

  const nextErrors = [...errorByDate.values()].sort((left, right) => left.date.localeCompare(right.date));
  model = {
    ...model,
    lastTargetReturn: latestTargetReturn,
  };

  return {
    model,
    journal: pruneJournal({
      snapshots: baseJournal.snapshots,
      errors: nextErrors,
    }),
  };
}

function recordEstimateSnapshot(journal, runtime, estimate) {
  const estimateDate = runtime.marketDate || new Date().toISOString().slice(0, 10);
  const snapshots = journal.snapshots ?? [];
  const nextSnapshot = {
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
    adaptiveUsed: Boolean(estimate.adaptiveUsed),
    adaptiveShockTriggered: Boolean(estimate.adaptiveShockTriggered),
    createdAt: new Date().toISOString(),
  };

  return pruneJournal({
    ...journal,
    snapshots: [...snapshots.filter((item) => item.estimateDate !== estimateDate), nextSnapshot].sort((left, right) => left.estimateDate.localeCompare(right.estimateDate)),
  });
}

function getQuoteSymbol(code) {
  return `${code.startsWith('5') ? 'sh' : 'sz'}${code}`;
}

async function fetchText(url, headers = {}, encoding = 'utf-8') {
  const response = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0',
      referer: 'https://fund.eastmoney.com/',
      ...headers,
    },
  });

  if (!response.ok) {
    throw new Error(`Request failed: ${url} (${response.status})`);
  }

  const buffer = await response.arrayBuffer();
  return new TextDecoder(encoding).decode(buffer);
}

async function readJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, payload) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
}

let quoteHistoryDbPromise = null;

async function getQuoteHistoryDb() {
  if (!quoteHistoryDbPromise) {
    quoteHistoryDbPromise = readJson(quoteHistoryDbPath, { updatedAt: '', byTicker: {} });
  }

  const payload = await quoteHistoryDbPromise;
  if (!payload || typeof payload !== 'object') {
    return { updatedAt: '', byTicker: {} };
  }

  if (!payload.byTicker || typeof payload.byTicker !== 'object') {
    payload.byTicker = {};
  }

  return payload;
}

function normalizeQuoteHistoryTicker(value) {
  return String(value || '').trim().toUpperCase();
}

function getQuoteHistoryFallback(db, ticker, maxAgeHours = 72) {
  const normalizedTicker = normalizeQuoteHistoryTicker(ticker);
  const row = db?.byTicker?.[normalizedTicker];
  if (!row) {
    return null;
  }

  const currentPrice = Number(row.currentPrice);
  const previousClose = Number(row.previousClose);
  if (!(currentPrice > 0) || !(previousClose > 0)) {
    return null;
  }

  const fetchedAt = row.fetchedAt ? new Date(row.fetchedAt) : null;
  if (!fetchedAt || Number.isNaN(fetchedAt.getTime())) {
    return null;
  }

  const ageHours = (Date.now() - fetchedAt.getTime()) / 3600000;
  if (ageHours > maxAgeHours) {
    return null;
  }

  return {
    currentPrice,
    previousClose,
    quoteDate: String(row.quoteDate || ''),
    quoteTime: String(row.quoteTime || ''),
    name: String(row.name || ''),
    source: 'shared-quote-history',
  };
}

function upsertQuoteHistoryRow(db, ticker, payload) {
  const normalizedTicker = normalizeQuoteHistoryTicker(ticker);
  if (!normalizedTicker) {
    return;
  }

  const currentPrice = Number(payload?.currentPrice);
  const previousClose = Number(payload?.previousClose);
  if (!(currentPrice > 0) || !(previousClose > 0)) {
    return;
  }

  db.byTicker[normalizedTicker] = {
    ticker: normalizedTicker,
    name: String(payload?.name || ''),
    currentPrice,
    previousClose,
    quoteDate: String(payload?.quoteDate || ''),
    quoteTime: String(payload?.quoteTime || ''),
    fetchedAt: new Date().toISOString(),
  };
  db.updatedAt = new Date().toISOString();
}

async function flushQuoteHistoryDb(db) {
  await writeJson(quoteHistoryDbPath, db);
}

function parseIsoDate(value) {
  if (!value) {
    return null;
  }

  const parsed = new Date(`${value}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function getAgeInDays(value) {
  const parsed = parseIsoDate(value);
  if (!parsed) {
    return Number.POSITIVE_INFINITY;
  }

  return Math.floor((Date.now() - parsed.getTime()) / (24 * 60 * 60 * 1000));
}

function isHoldingsDisclosureWindow(referenceDate = now) {
  const month = referenceDate.getMonth() + 1;

  return month === 1 || month === 2 || month === 3 || month === 4 || month === 7 || month === 8 || month === 10;
}

function shouldRefreshHoldingsDisclosure(cached) {
  const ageInDays = getAgeInDays(cached?.holdingsFetchedDate ?? cached?.fetchedDate ?? '');
  if (!cached?.disclosedHoldingsReportDate) {
    return ageInDays >= 7;
  }

  return ageInDays >= (isHoldingsDisclosureWindow() ? 2 : 21);
}

async function readPublishedRuntimeState() {
  const localRuntime = await readJson(outputPath, null);
  let mergedState = localRuntime?.stateByCode && typeof localRuntime.stateByCode === 'object' ? { ...localRuntime.stateByCode } : {};

  for (const url of PUBLISHED_RUNTIME_URLS) {
    try {
      const response = await fetch(`${url}${url.includes('?') ? '&' : '?'}ts=${Date.now()}`, {
        headers: {
          'user-agent': 'Mozilla/5.0',
        },
      });

      if (!response.ok) {
        continue;
      }

      const payload = await response.json();
      if (payload?.stateByCode && typeof payload.stateByCode === 'object') {
        mergedState = mergePersistedState(payload.stateByCode, mergedState);
      }
    } catch {
      continue;
    }
  }

  return mergedState;
}

function mergePersistedState(primaryState, fallbackState) {
  const merged = { ...fallbackState };

  for (const [code, entry] of Object.entries(primaryState ?? {})) {
    if (!entry || code === '__meta') {
      continue;
    }

    const previousEntry = merged[code] ?? {};
    const previousJournal = previousEntry.journal ?? getDefaultJournal();
    const nextJournal = entry.journal ?? getDefaultJournal();
    const snapshotByDate = new Map();
    const errorByDate = new Map();

    for (const snapshot of previousJournal.snapshots ?? []) {
      if (snapshot?.estimateDate) {
        snapshotByDate.set(snapshot.estimateDate, snapshot);
      }
    }

    for (const snapshot of nextJournal.snapshots ?? []) {
      if (snapshot?.estimateDate) {
        snapshotByDate.set(snapshot.estimateDate, {
          ...(snapshotByDate.get(snapshot.estimateDate) ?? {}),
          ...snapshot,
        });
      }
    }

    for (const error of previousJournal.errors ?? []) {
      if (error?.date) {
        errorByDate.set(error.date, error);
      }
    }

    for (const error of nextJournal.errors ?? []) {
      if (error?.date) {
        errorByDate.set(error.date, {
          ...(errorByDate.get(error.date) ?? {}),
          ...error,
        });
      }
    }

    merged[code] = {
      ...previousEntry,
      ...entry,
      model: entry.model ?? previousEntry.model,
      journal: pruneJournal({
        snapshots: [...snapshotByDate.values()].sort((left, right) => left.estimateDate.localeCompare(right.estimateDate)),
        errors: [...errorByDate.values()].sort((left, right) => left.date.localeCompare(right.date)),
      }),
    };
  }

  return merged;
}

function stripHtml(value) {
  return value.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function extractField(html, label) {
  const pattern = new RegExp(String.raw`${label}<\/th><td[^>]*>([\s\S]{0,500}?)<\/td>`, 'i');
  const match = html.match(pattern);
  return match ? stripHtml(match[1]) : '';
}

function extractRelatedEtfCode(html) {
  const linkMatch = html.match(/href=['"]https?:\/\/fund\.eastmoney\.com\/(\d{6})\.html['"][^>]*>查看\s*相关ETF/i);
  return linkMatch?.[1] ?? '';
}

function parsePurchaseStatusFromHtml(html) {
  const compact = html.replace(/\s+/g, ' ');
  const match = compact.match(
    /交易状态：<\/span><span class="staticCell">([^<]+?)(?:\s*\(<span>([^<]+)<\/span>\))?<\/span><span class="staticCell">([^<]+)<\/span>/i,
  );

  if (!match) {
    return {
      buyStatus: '',
      redeemStatus: '',
      purchaseStatus: '',
      purchaseLimit: '',
    };
  }

  const baseStatus = stripHtml(match[1]);
  const limitText = stripHtml(match[2] ?? '');
  const redeemStatus = stripHtml(match[3]);
  const purchaseStatus = [baseStatus, redeemStatus].filter(Boolean).join(' / ');

  return {
    buyStatus: baseStatus,
    redeemStatus,
    purchaseStatus,
    purchaseLimit: limitText,
  };
}

function mapIsBuyToStatus(value) {
  const code = String(value ?? '').trim();
  if (!code) {
    return '';
  }

  if (code === '4') {
    // Eastmoney returns 4 for both pause and large-order-limit in some cases.
    // Treat it as limited instead of hard pause to avoid false 0-limit.
    return '限大额';
  }

  return ['1', '2', '3', '8', '9'].includes(code) ? '开放申购' : '';
}

function mapIsSalesToStatus(value) {
  const code = String(value ?? '').trim();
  if (!code) {
    return '';
  }

  return code === '1' ? '开放赎回' : '暂停赎回';
}

async function fetchPurchaseStatusFromApi(code) {
  try {
    const response = await fetchText(
      `https://api.fund.eastmoney.com/Fund/GetSingleFundInfo?callback=x&fcode=${code}&fileds=FCODE,ISBUY,ISSALES,MINDT,DTZT,SHORTNAME`,
      { referer: `https://fund.eastmoney.com/${code}.html` },
      'utf-8',
    );
    const payload = parseJsonpPayload(response);
    const data = payload?.Data;

    return {
      buyStatus: mapIsBuyToStatus(data?.ISBUY),
      redeemStatus: mapIsSalesToStatus(data?.ISSALES),
    };
  } catch {
    return {
      buyStatus: '',
      redeemStatus: '',
    };
  }
}

function mapPortalBuyStatus(value) {
  const normalized = String(value ?? '').trim();
  if (!normalized) {
    return '';
  }

  if (normalized.includes('暂停')) {
    return '暂停申购';
  }

  if (normalized.includes('限')) {
    return '限大额';
  }

  if (normalized.includes('开放')) {
    return '开放申购';
  }

  return '';
}

function mapPortalRedeemStatus(value) {
  const normalized = String(value ?? '').trim();
  if (!normalized) {
    return '';
  }

  if (normalized.includes('暂停')) {
    return '暂停赎回';
  }

  if (normalized.includes('开放')) {
    return '开放赎回';
  }

  return '';
}

async function fetchPurchaseStatusFromPortal(code) {
  try {
    const html = await fetchText(`https://fund.10jqka.com.cn/${code}/`, {}, 'utf-8');
    const plainText = stripHtml(html);
    const buyMatch = plainText.match(/申购状态[:：]\s*([^\s，。；、]{1,12})/);
    const redeemMatch = plainText.match(/赎回状态[:：]\s*([^\s，。；、]{1,12})/);

    return {
      buyStatus: mapPortalBuyStatus(buyMatch?.[1] ?? ''),
      redeemStatus: mapPortalRedeemStatus(redeemMatch?.[1] ?? ''),
    };
  } catch {
    return {
      buyStatus: '',
      redeemStatus: '',
    };
  }
}

function mapNoticeBuyStatus(title) {
  const normalized = String(title ?? '');
  if (!normalized) {
    return '';
  }

  if (/暂停申购/.test(normalized)) {
    return '暂停申购';
  }

  if (/调整大额申购|限制大额申购|大额申购/.test(normalized)) {
    return '限大额';
  }

  if (/恢复申购|开放申购/.test(normalized)) {
    return '开放申购';
  }

  return '';
}

function normalizeChineseDateToken(token) {
  const matched = String(token ?? '').match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (!matched) {
    return '';
  }

  const year = matched[1];
  const month = String(Number(matched[2])).padStart(2, '0');
  const day = String(Number(matched[3])).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function buildNoticeBuyEvents(text) {
  const normalized = String(text ?? '');
  if (!normalized) {
    return [];
  }

  const events = [];
  const dateThenStatus = /(\d{4}年\d{1,2}月\d{1,2}日)[^。；\n]{0,36}(恢复申购|开放申购|暂停申购|限制大额申购|调整大额申购|大额申购)/g;
  const statusThenDate = /(恢复申购|开放申购|暂停申购|限制大额申购|调整大额申购|大额申购)[^。；\n]{0,36}(\d{4}年\d{1,2}月\d{1,2}日)/g;

  let matched;
  while ((matched = dateThenStatus.exec(normalized)) !== null) {
    const date = normalizeChineseDateToken(matched[1]);
    const status = mapNoticeBuyStatus(matched[2]);
    if (date && status) {
      events.push({ date, status });
    }
  }

  while ((matched = statusThenDate.exec(normalized)) !== null) {
    const date = normalizeChineseDateToken(matched[2]);
    const status = mapNoticeBuyStatus(matched[1]);
    if (date && status) {
      events.push({ date, status });
    }
  }

  return events.sort((left, right) => left.date.localeCompare(right.date));
}

function resolveNoticeBuyStatusWithContent(title, content, publishDate) {
  const titleStatus = mapNoticeBuyStatus(title);
  const events = buildNoticeBuyEvents(content).filter((item) => item.date <= today);

  // If there are valid events dated through today, use the latest one
  if (events.length) {
    return events[events.length - 1].status;
  }

  // For "暂停申购" notices, require positive evidence of current impact
  if (titleStatus === '暂停申购') {
    const combined = `${String(title ?? '')}${String(content ?? '')}`;
    
    // Skip holiday-only or temporary pauses
    if (/节假日|非交易日|境外主要投资市场/.test(combined)) {
      return '';
    }
    
    // No events found and notice doesn't have current evidence — skip this notice
    return '';
  }

  // For other statuses (like "开放申购"), use the title status if present
  return titleStatus;
}

function mapNoticeRedeemStatus(title) {
  const normalized = String(title ?? '');
  if (!normalized) {
    return '';
  }

  if (/暂停赎回/.test(normalized)) {
    return '暂停赎回';
  }

  if (/恢复赎回|开放赎回/.test(normalized)) {
    return '开放赎回';
  }

  return '';
}

function isTemporaryHolidayNotice(title) {
  const normalized = String(title ?? '');
  if (!normalized) {
    return false;
  }

  if (!/暂停申购|暂停赎回|暂停申购、赎回|暂停申购和定投|暂停申购及定投/.test(normalized)) {
    return false;
  }

  // 单日节假日：如 "2026年1月19日暂停申购"
  if (/\d{4}年\d{1,2}月\d{1,2}日/.test(normalized)) {
    return true;
  }

  // 年度境外市场节假日安排公告：如 "2026年境外主要投资市场节假日暂停申购"
  if (/境外主要投资市场节假日/.test(normalized)) {
    return true;
  }

  // 因节假日暂停：如 "因节假日暂停申购"
  if (/因.*节假日/.test(normalized)) {
    return true;
  }

  return false;
}

async function fetchPurchaseStatusFromNotices(code) {
  try {
    const response = await fetchText(
      `https://api.fund.eastmoney.com/f10/JJGG?callback=x&fundcode=${code}&pageIndex=1&pageSize=20&type=5`,
      { referer: `https://fundf10.eastmoney.com/jjgg_${code}_5.html` },
      'utf-8',
    );
    const payload = parseJsonpPayload(response);
    const notices = (payload?.Data ?? [])
      .filter((item) => {
        const title = String(item?.TITLE ?? '');
        if (!title) {
          return false;
        }

        if (!/申购|定投|赎回|大额|暂停|恢复|开放/.test(title)) {
          return false;
        }

        if (/费率优惠|销售业务|终止.*销售业务/.test(title)) {
          return false;
        }

        return !isTemporaryHolidayNotice(title);
      });

    for (const notice of notices.slice(0, 6)) {
      const title = String(notice?.TITLE ?? '');
      const buyFromTitle = mapNoticeBuyStatus(title);
      const redeemFromTitle = mapNoticeRedeemStatus(title);
      if (!buyFromTitle && !redeemFromTitle) {
        continue;
      }

      let content = '';
      const artCode = String(notice?.ID ?? '');
      if (artCode) {
        try {
          const contentResponse = await fetchText(
            `https://np-cnotice-fund.eastmoney.com/api/content/ann?client_source=web_fund&show_all=1&art_code=${artCode}`,
            { referer: `https://fund.eastmoney.com/gonggao/${code},${artCode}.html` },
            'utf-8',
          );
          const contentPayload = JSON.parse(contentResponse);
          content = String(contentPayload?.data?.notice_content ?? '');
        } catch {
          content = '';
        }
      }

      const buyStatus = resolveNoticeBuyStatusWithContent(title, content, notice?.PUBLISHDATEDesc ?? notice?.PUBLISHDATE ?? '');
      const redeemStatus = redeemFromTitle;
      if (buyStatus || redeemStatus) {
        return {
          buyStatus,
          redeemStatus,
        };
      }
    }

    return {
      buyStatus: '',
      redeemStatus: '',
    };
  } catch {
    return {
      buyStatus: '',
      redeemStatus: '',
    };
  }
}

function pickBuyStatus(statuses) {
  if (statuses.includes('暂停申购')) {
    return '暂停申购';
  }

  if (statuses.includes('限大额')) {
    return '限大额';
  }

  return statuses.includes('开放申购') ? '开放申购' : '';
}

function pickRedeemStatus(statuses) {
  if (statuses.includes('暂停赎回')) {
    return '暂停赎回';
  }

  return statuses.includes('开放赎回') ? '开放赎回' : '';
}

function normalizeLimitNumber(raw) {
  const numeric = Number(String(raw ?? '').replace(/,/g, ''));
  if (!Number.isFinite(numeric)) {
    return '';
  }

  return Number.isInteger(numeric) ? String(numeric) : String(numeric).replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1');
}

function extractLimitAmount(limitText) {
  const normalized = String(limitText ?? '').replace(/\s+/g, '');
  const match = normalized.match(/上限([0-9]+(?:\.[0-9]+)?)(万?元)/);
  if (!match) {
    return '';
  }

  const amount = normalizeLimitNumber(match[1]);
  return amount ? `${amount}${match[2]}` : '';
}

function formatPurchaseLimit(buyStatus, limitText) {
  const normalizedBuyStatus = String(buyStatus ?? '').trim();

  // 暂停申购优先：HTML里的残留限额是历史数据，不应覆盖当前暂停状态
  if (normalizedBuyStatus === '暂停申购') {
    return '0元';
  }

  const amount = extractLimitAmount(limitText);

  if (amount) {
    return amount;
  }

  if (normalizedBuyStatus === '开放申购') {
    return '不限购';
  }

  if (normalizedBuyStatus === '限大额') {
    return '限购';
  }

  return '';
}

function mergePurchaseStatus(htmlStatus, apiStatus, portalStatus, noticeStatus) {
  const noticeBS = noticeStatus?.buyStatus ?? '';
  const htmlBS = htmlStatus?.buyStatus ?? '';
  const apiBS = apiStatus?.buyStatus ?? '';
  const portalBS = portalStatus?.buyStatus ?? '';

  // Source priority: html page > notice/content parsing > portal > api.
  // Do not mix multiple sources in a single pick list, otherwise a stale "暂停" from a weaker source may override html "开放".
  const buyStatus =
    pickBuyStatus([htmlBS].filter(Boolean))
    || pickBuyStatus([noticeBS].filter(Boolean))
    || pickBuyStatus([portalBS].filter(Boolean))
    || pickBuyStatus([apiBS].filter(Boolean));

  const redeemStatus =
    pickRedeemStatus([htmlStatus?.redeemStatus ?? ''].filter(Boolean))
    || pickRedeemStatus([noticeStatus?.redeemStatus ?? ''].filter(Boolean))
    || pickRedeemStatus([portalStatus?.redeemStatus ?? ''].filter(Boolean))
    || pickRedeemStatus([apiStatus?.redeemStatus ?? ''].filter(Boolean));

  return {
    purchaseStatus: [buyStatus, redeemStatus].filter(Boolean).join(' / '),
    purchaseLimit: formatPurchaseLimit(buyStatus, htmlStatus?.purchaseLimit ?? ''),
  };
}

function parseBasicInfo(html, fallbackName) {
  const titleMatch = html.match(/<title>(.*?)<\/title>/i);
  const titleName = titleMatch
    ? stripHtml(titleMatch[1]).replace(/基金基本概况.*$/u, '').replace(/ _ 基金档案.*$/u, '').trim()
    : '';

  return {
    name: titleName || fallbackName,
    fundType: extractField(html, '基金类型'),
    benchmark: extractField(html, '业绩比较基准'),
  };
}

function parseNumber(value) {
  const normalized = value.replace(/,/g, '').replace(/--/g, '').trim();
  const parsed = Number(normalized.replace(/%$/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeUsQuoteTicker(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/_/g, '.')
    .replace(/\.$/, '')
    .trim();
}

function normalizeArchiveHoldingTicker(value) {
  const rawTicker = String(value || '').toUpperCase().trim();
  if (!rawTicker) {
    return '';
  }

  return ARCHIVE_HOLDING_TICKER_MAP[rawTicker]?.ticker ?? rawTicker;
}

function isHoldingTicker(value) {
  return /^[0-9A-Z._-]{1,12}$/.test(String(value || '').toUpperCase().trim());
}

function isUsHoldingTicker(value) {
  return /^[A-Z]{1,5}(?:\.[A-Z])?$/.test(normalizeUsQuoteTicker(value));
}

function parseHoldingsDisclosure(html, quoteByTicker = new Map()) {
  const $ = load(html);
  const reportText = $('h4').first().text().replace(/\s+/g, ' ').trim() || $.root().text().replace(/\s+/g, ' ').trim();
  const reportMatch = reportText.match(/(\d{4}年[1-4]季度股票投资明细).*?截止至：\s*(\d{4}-\d{2}-\d{2})/);
  const table = $('table').filter((_, element) => {
    const rows = $(element).find('tr');
    if (!rows.length) {
      return false;
    }

    return rows
      .toArray()
      .some((row) => {
        const cells = $(row)
          .find('td')
          .map((__, cell) => $(cell).text().replace(/\s+/g, ' ').trim())
          .get()
          .filter(Boolean);

        return cells.length >= 6 && /^\d+$/.test(cells[0]) && isHoldingTicker(cells[1]);
      });
  }).first();

  if (!table.length) {
    return {
      disclosedHoldingsTitle: '',
      disclosedHoldingsReportDate: '',
      disclosedHoldings: [],
    };
  }

  const disclosedHoldings = table
    .find('tr')
    .map((_, row) => {
      const cells = $(row)
        .find('td')
        .map((__, cell) => $(cell).text().replace(/\s+/g, ' ').trim())
        .get()
        .filter(Boolean);

      if (cells.length < 6 || !/^\d+$/.test(cells[0])) {
        return null;
      }

      const rawTicker = String(cells[1] || '').toUpperCase();
      const ticker = normalizeArchiveHoldingTicker(rawTicker);
      const quote = quoteByTicker.get(ticker) ?? quoteByTicker.get(rawTicker);

      return {
        ticker,
        name: cells[2],
        currentPrice: quote?.currentPrice,
        changeRate: quote?.changeRate,
        weight: parseNumber(cells[cells.length - 3]),
        shares: parseNumber(cells[cells.length - 2]),
        marketValue: parseNumber(cells[cells.length - 1]),
      };
    })
    .get()
    .filter(Boolean)
    .slice(0, 10);

  return {
    disclosedHoldingsTitle: reportMatch?.[1] ?? '',
    disclosedHoldingsReportDate: reportMatch?.[2] ?? '',
    disclosedHoldings,
  };
}

function parseFundArchivesPayload(content) {
  try {
    return Function(`${content}; return typeof apidata !== 'undefined' ? apidata : null;`)();
  } catch {
    return null;
  }
}

function parseJsonpPayload(content) {
  const normalized = content.trim();
  const jsonText = normalized.startsWith('{')
    ? normalized
    : normalized.replace(/^[^(]+\(/, '').replace(/\);?\s*$/, '');

  try {
    return JSON.parse(jsonText);
  } catch {
    return null;
  }
}

function resolveNoticeAttachmentPdfUrl(contentPayload) {
  const data = contentPayload?.data ?? {};
  const candidates = [
    data?.attach_url,
    data?.attach_url_web,
    ...(Array.isArray(data?.attach_list) ? data.attach_list : []),
    ...(Array.isArray(data?.attach_list_ch) ? data.attach_list_ch : []),
  ]
    .map((item) => String(item || '').trim())
    .filter(Boolean);

  const matched = candidates.find((item) => /\.pdf(?:$|\?)/i.test(item));
  return matched || '';
}

async function extractPdfText(pdfUrl) {
  if (!pdfUrl) {
    return '';
  }

  try {
    const response = await fetch(pdfUrl, {
      headers: {
        referer: 'https://fundf10.eastmoney.com/',
        'user-agent': 'Mozilla/5.0',
      },
    });
    if (!response.ok) {
      return '';
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const parser = new PDFParse({ data: buffer });
    const parsed = await parser.getText();
    await parser.destroy();
    return String(parsed?.text || '').trim();
  } catch {
    return '';
  }
}

async function fetchNoticeHoldingsDisclosure(code) {
  const aliases = SUPPLEMENTAL_NOTICE_HOLDINGS[code];
  if (!aliases?.length) {
    return null;
  }

  const listResponse = await fetchText(
    `https://api.fund.eastmoney.com/f10/JJGG?callback=x&fundcode=${code}&pageIndex=1&pageSize=20&type=3`,
    { referer: `https://fundf10.eastmoney.com/jjgg_${code}_3.html` },
    'utf-8',
  );
  const listPayload = parseJsonpPayload(listResponse);
  const reports = (listPayload?.Data ?? []).filter((item) => /季度报告/.test(item?.TITLE ?? ''));
  if (!reports.length) {
    return null;
  }

  let quoteByTicker = new Map();
  try {
    quoteByTicker = await fetchSupplementalHoldingQuoteMap(aliases);
  } catch {
    quoteByTicker = new Map();
  }

  for (const report of reports) {
    const artCode = report?.ID;
    if (!artCode) {
      continue;
    }

    try {
      const contentResponse = await fetchText(
        `https://np-cnotice-fund.eastmoney.com/api/content/ann?client_source=web_fund&show_all=1&art_code=${artCode}`,
        { referer: `https://fund.eastmoney.com/gonggao/${code},${artCode}.html` },
        'utf-8',
      );
      const contentPayload = JSON.parse(contentResponse);
      const parsed = parseNoticeHoldingsDisclosure(code, {
        noticeTitle: report.TITLE,
        noticeContent: contentPayload?.data?.notice_content ?? '',
        aliases,
        quoteByTicker,
      });
      if (parsed.disclosedHoldings.length) {
        return parsed;
      }

      const attachmentPdfUrl = resolveNoticeAttachmentPdfUrl(contentPayload);
      const pdfText = await extractPdfText(attachmentPdfUrl);
      if (pdfText) {
        const parsedFromPdf = parseNoticeHoldingsDisclosure(code, {
          noticeTitle: report.TITLE,
          noticeContent: pdfText,
          aliases,
          quoteByTicker,
        });
        if (parsedFromPdf.disclosedHoldings.length) {
          return parsedFromPdf;
        }
      }
    } catch {
      continue;
    }
  }

  return null;
}

async function fetchOverseasHoldingQuoteMap(tickers) {
  const usTickers = [...new Set(tickers.map((item) => item.toUpperCase()).filter(isUsHoldingTicker))];
  if (!usTickers.length) {
    return new Map();
  }

  const response = await fetchText(`https://qt.gtimg.cn/q=${usTickers.map((ticker) => `us${ticker}`).join(',')}`, { referer: 'https://gu.qq.com/' }, 'gb18030');
  return new Map(
    parseUsQuotes(response)
      .filter((item) => item?.ticker)
      .map((item) => [
        item.ticker.toUpperCase(),
        {
          currentPrice: item.currentPrice,
          changeRate: item.previousClose > 0 ? item.currentPrice / item.previousClose - 1 : 0,
        },
      ]),
  );
}

function extractHoldingSecids(html) {
  const $ = load(html);
  const table = $('table').filter((_, element) => {
    const rows = $(element).find('tr');
    if (!rows.length) {
      return false;
    }

    return rows
      .toArray()
      .some((row) => {
        const cells = $(row)
          .find('td')
          .map((__, cell) => $(cell).text().replace(/\s+/g, ' ').trim())
          .get()
          .filter(Boolean);

        return cells.length >= 6 && /^\d+$/.test(cells[0]) && Boolean(cells[1]);
      });
  }).first();

  return table
    .find('tbody tr')
    .map((_, row) => {
      const cells = $(row)
        .find('td')
        .map((__, cell) => $(cell).text().replace(/\s+/g, ' ').trim())
        .get()
        .filter(Boolean);

      if (cells.length < 7 || !/^\d+$/.test(cells[0]) || !cells[1]) {
        return null;
      }

      const rawTicker = String(cells[1] || '').toUpperCase();
      const ticker = normalizeArchiveHoldingTicker(rawTicker);
      const href = $(row).find('td').eq(1).find('a').attr('href') ?? '';
      const secidMatch = href.match(/unify\/r\/([0-9.]+)/i);
      if (!secidMatch) {
        return null;
      }

      return {
        ticker,
        rawTicker,
        secid: secidMatch[1],
      };
    })
    .get()
    .filter(Boolean)
    .slice(0, 10);
}

async function fetchHoldingQuoteMap(secidEntries) {
  if (!secidEntries.length) {
    return new Map();
  }

  const secids = [...new Set(secidEntries.map((item) => item.secid))].join(',');
  const response = await fetchText(
    `https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&fields=f2,f3,f12,f13,f14,f9&ut=267f9ad526dbe6b0262ab19316f5a25b&secids=${secids}`,
    { referer: 'https://fundf10.eastmoney.com/' },
    'utf-8',
  );
  const payload = JSON.parse(response);
  const tickersBySecid = new Map(
    secidEntries.map((item) => [item.secid, item]),
  );

  const quoteByTicker = new Map();
  for (const item of payload.data?.diff ?? []) {
    if (!item?.f12 || !item?.f13) {
      continue;
    }

    const quote = {
      currentPrice: Number(item.f2) || 0,
      changeRate: Number(item.f3) / 100 || 0,
    };
    const secid = `${item.f13}.${item.f12}`;
    const matched = tickersBySecid.get(secid);
    if (matched?.rawTicker) {
      quoteByTicker.set(String(matched.rawTicker).toUpperCase(), quote);
    }
    if (matched?.ticker) {
      quoteByTicker.set(String(matched.ticker).toUpperCase(), quote);
    }
    quoteByTicker.set(String(item.f12).toUpperCase(), quote);
  }

  return quoteByTicker;
}

async function fetchHoldingsDisclosure(code) {
  const supplementalDisclosure = await fetchNoticeHoldingsDisclosure(code).catch(() => null);
  if (supplementalDisclosure?.disclosedHoldings.length) {
    return supplementalDisclosure;
  }

  const yearsToTry = Array.from({ length: 4 }, (_, index) => now.getFullYear() - index);

  for (const year of yearsToTry) {
    try {
      const response = await fetchText(
        `https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc&code=${code}&topline=10&year=${year}&month=&rt=${Date.now()}`,
        { referer: `https://fundf10.eastmoney.com/ccmx_${code}.html` },
        'utf-8',
      );
      const payload = parseFundArchivesPayload(response);
      if (!payload?.content) {
        continue;
      }

      const secidEntries = extractHoldingSecids(payload.content);
      const quoteByTicker = await fetchHoldingQuoteMap(secidEntries);
      const parsed = parseHoldingsDisclosure(payload.content, quoteByTicker);
      const missingTickers = parsed.disclosedHoldings
        .filter((item) => item?.ticker && (!Number.isFinite(item.currentPrice) || item.currentPrice <= 0))
        .map((item) => item.ticker);
      const overseasQuoteByTicker = missingTickers.length ? await fetchOverseasHoldingQuoteMap(missingTickers) : new Map();
      const patched = overseasQuoteByTicker.size
        ? {
            ...parsed,
            disclosedHoldings: parsed.disclosedHoldings.map((item) => {
              const quote = overseasQuoteByTicker.get(item.ticker.toUpperCase());
              return quote
                ? {
                    ...item,
                    currentPrice: quote.currentPrice,
                    changeRate: quote.changeRate,
                  }
                : item;
            }),
          }
        : parsed;
      if (patched.disclosedHoldings.length) {
        return patched;
      }
    } catch {
      continue;
    }
  }

  return {
    disclosedHoldingsTitle: '',
    disclosedHoldingsReportDate: '',
    disclosedHoldings: [],
  };
}

function getHoldingCurrency(ticker) {
  if (isUsHoldingTicker(ticker)) {
    return 'USD';
  }

  return /^0\d{4}$/.test(ticker) ? 'HKD' : 'CNY';
}

function buildHoldingQuotes(runtime) {
  if (runtime.code === '161128') {
    return {
      holdingQuotes: runtime.holdingQuotes ?? [],
      holdingsQuoteDate: runtime.holdingsQuoteDate || '',
      holdingsQuoteTime: runtime.holdingsQuoteTime || '',
    };
  }

  const holdingQuotes = (runtime.disclosedHoldings ?? [])
    .map((item) => {
      if (!item.ticker || !Number.isFinite(item.currentPrice) || item.currentPrice <= 0 || !Number.isFinite(item.changeRate)) {
        return null;
      }

      const previousClose = item.currentPrice / (1 + item.changeRate);
      if (!Number.isFinite(previousClose) || previousClose <= 0) {
        return null;
      }

      return {
        ticker: item.ticker,
        name: item.name,
        currentPrice: item.currentPrice,
        previousClose,
        quoteDate: runtime.marketDate || today,
        quoteTime: runtime.marketTime || '',
        currency: getHoldingCurrency(item.ticker),
      };
    })
    .filter(Boolean);

  return {
    holdingQuotes,
    holdingsQuoteDate: holdingQuotes.length ? runtime.marketDate || today : '',
    holdingsQuoteTime: holdingQuotes.length ? runtime.marketTime || '' : '',
  };
}

function updateDisclosureHistory(historyByCode, runtime) {
  const sanitizedRuntimeDisclosure = sanitizeDisclosureForFund(runtime.code, {
    disclosedHoldingsTitle: runtime.disclosedHoldingsTitle,
    disclosedHoldingsReportDate: runtime.disclosedHoldingsReportDate,
    disclosedHoldings: runtime.disclosedHoldings,
  });

  if (!sanitizedRuntimeDisclosure.disclosedHoldings.length || !sanitizedRuntimeDisclosure.disclosedHoldingsReportDate) {
    return historyByCode;
  }

  const current = historyByCode[runtime.code] ?? [];
  const nextEntry = {
    reportDate: sanitizedRuntimeDisclosure.disclosedHoldingsReportDate,
    title: sanitizedRuntimeDisclosure.disclosedHoldingsTitle,
    holdings: sanitizedRuntimeDisclosure.disclosedHoldings,
    capturedAt: new Date().toISOString(),
  };

  return {
    ...historyByCode,
    [runtime.code]: [
      ...current.filter(
        (item) => item.reportDate !== sanitizedRuntimeDisclosure.disclosedHoldingsReportDate || item.title !== sanitizedRuntimeDisclosure.disclosedHoldingsTitle,
      ),
      nextEntry,
    ].sort((left, right) => left.reportDate.localeCompare(right.reportDate)).slice(-8),
  };
}

function normalizeDisclosureEntry(disclosure) {
  return {
    disclosedHoldingsTitle: disclosure?.disclosedHoldingsTitle ?? disclosure?.title ?? '',
    disclosedHoldingsReportDate: disclosure?.disclosedHoldingsReportDate ?? disclosure?.reportDate ?? '',
    disclosedHoldings: disclosure?.disclosedHoldings ?? disclosure?.holdings ?? [],
  };
}

function sanitizeDisclosureForFund(code, disclosure) {
  const normalized = normalizeDisclosureEntry(disclosure);

  if (code === '161129') {
    const invalidTickers = new Set(['159995', '512760', '159560']);
    const disclosedTickers = normalized.disclosedHoldings
      .map((item) => String(item?.ticker ?? '').toUpperCase())
      .filter(Boolean);

    if (disclosedTickers.length && disclosedTickers.every((ticker) => invalidTickers.has(ticker))) {
      return normalizeDisclosureEntry(null);
    }
  }

  return normalized;
}

function sanitizeDisclosureHistory(historyByCode) {
  return Object.fromEntries(
    Object.entries(historyByCode ?? {}).map(([code, entries]) => [
      code,
      (entries ?? [])
        .map((entry) => {
          const sanitized = sanitizeDisclosureForFund(code, entry);
          if (!sanitized.disclosedHoldings.length || !sanitized.disclosedHoldingsReportDate) {
            return null;
          }

          return {
            ...entry,
            reportDate: sanitized.disclosedHoldingsReportDate,
            title: sanitized.disclosedHoldingsTitle,
            holdings: sanitized.disclosedHoldings,
          };
        })
        .filter(Boolean),
    ]).filter(([, entries]) => entries.length),
  );
}

function patchKnownDisclosureGaps(code, disclosure) {
  const normalized = sanitizeDisclosureForFund(code, disclosure);

  if (
    code === '160723'
    && normalized.disclosedHoldingsReportDate === '2025-12-31'
    && !normalized.disclosedHoldings.some((item) => item?.ticker === '1699')
  ) {
    return {
      ...normalized,
      disclosedHoldings: [
        ...normalized.disclosedHoldings,
        {
          ticker: '1699',
          name: 'NEXT FUNDS NOMURA Crude Oil Long Index Linked ETF',
          weight: 14.29,
          marketValue: 65062509.79,
        },
      ].sort((left, right) => (right.weight ?? 0) - (left.weight ?? 0)),
    };
  }

  if (
    code === '160216'
    && normalized.disclosedHoldingsReportDate === '2025-12-31'
    && normalized.disclosedHoldings.some((item) => String(item?.ticker ?? '').startsWith('UNMAPPED_'))
  ) {
    const replacements = [
      { ticker: 'GLD', name: 'SPDR Gold Shares ETF' },
      { ticker: 'UGL', name: 'ProShares Ultra Gold ETF' },
      { ticker: 'COPX', name: 'Global X Copper Miners ETF' },
      { ticker: 'DBB', name: 'Invesco DB Base Metals Fund' },
      { ticker: 'GDXU', name: 'MicroSectors Gold Miners 3X Leveraged ETN' },
    ];

    let unmappedIndex = 0;
    return {
      ...normalized,
      disclosedHoldings: normalized.disclosedHoldings.map((item) => {
        if (!String(item?.ticker ?? '').startsWith('UNMAPPED_')) {
          return item;
        }

        const replacement = replacements[unmappedIndex];
        unmappedIndex += 1;
        return replacement
          ? {
              ...item,
              ticker: replacement.ticker,
              name: replacement.name,
            }
          : item;
      }),
    };
  }

  if (
    code === '161116'
    && normalized.disclosedHoldingsReportDate === '2025-12-31'
    && normalized.disclosedHoldings.some((item) => String(item?.ticker ?? '').startsWith('UNMAPPED_'))
  ) {
    const replacements = [
      { ticker: 'GLD', name: 'SPDR Gold Shares ETF' },
      { ticker: 'GLDM', name: 'SPDR Gold MiniShares Trust' },
      { ticker: 'IAU', name: 'iShares Gold Trust ETF' },
      { ticker: 'SGOL', name: 'abrdn Physical Gold Shares ETF' },
      { ticker: 'UBS_GOLD', name: 'UBS Gold ETF' },
      { ticker: 'UGL', name: 'ProShares Ultra Gold ETF' },
    ];

    return {
      ...normalized,
      disclosedHoldings: normalized.disclosedHoldings.map((item, index) => ({
        ...item,
        ticker: replacements[index]?.ticker ?? item.ticker,
        name: replacements[index]?.name ?? item.name,
      })),
    };
  }

  return normalized;
}

async function hydrateSupplementalDisclosureQuotes(code, disclosure) {
  const normalized = normalizeDisclosureEntry(disclosure);
  const aliases = SUPPLEMENTAL_NOTICE_HOLDINGS[code] ?? [];
  if (!aliases.length || !normalized.disclosedHoldings.length) {
    return normalized;
  }

  const quoteByTicker = await fetchSupplementalHoldingQuoteMap(aliases).catch(() => new Map());
  if (!quoteByTicker.size) {
    return normalized;
  }

  return {
    ...normalized,
    disclosedHoldings: normalized.disclosedHoldings.map((item) => {
      const quote = quoteByTicker.get(String(item?.ticker ?? '').toUpperCase());
      return quote
        ? {
            ...item,
            currentPrice: quote.currentPrice,
            changeRate: quote.changeRate,
          }
        : item;
    }),
  };
}

async function hydrateDirectDisclosureQuotes(disclosure) {
  const normalized = normalizeDisclosureEntry(disclosure);
  if (!normalized.disclosedHoldings.length) {
    return normalized;
  }

  const aliasEntries = normalized.disclosedHoldings
    .map((item) => ({ ticker: String(item?.ticker ?? '').toUpperCase() }))
    .filter((item) => item.ticker);
  if (!aliasEntries.length) {
    return normalized;
  }

  const quoteByTicker = await fetchSupplementalHoldingQuoteMap(aliasEntries).catch(() => new Map());
  if (!quoteByTicker.size) {
    return normalized;
  }

  return {
    ...normalized,
    disclosedHoldings: normalized.disclosedHoldings.map((item) => {
      const quote = quoteByTicker.get(String(item?.ticker ?? '').toUpperCase());
      return quote
        ? {
            ...item,
            currentPrice: quote.currentPrice,
            changeRate: quote.changeRate,
          }
        : item;
    }),
  };
}

function compareDisclosureFreshness(left, right) {
  const leftDate = left?.disclosedHoldingsReportDate ?? '';
  const rightDate = right?.disclosedHoldingsReportDate ?? '';
  if (leftDate !== rightDate) {
    return leftDate.localeCompare(rightDate);
  }

  const leftQuotedCount = (left?.disclosedHoldings ?? []).filter((item) => Number.isFinite(item?.currentPrice) && item.currentPrice > 0).length;
  const rightQuotedCount = (right?.disclosedHoldings ?? []).filter((item) => Number.isFinite(item?.currentPrice) && item.currentPrice > 0).length;
  if (leftQuotedCount !== rightQuotedCount) {
    return leftQuotedCount - rightQuotedCount;
  }

  return (left?.disclosedHoldings?.length ?? 0) - (right?.disclosedHoldings?.length ?? 0);
}

function pickPreferredDisclosure(primary, fallback) {
  const normalizedPrimary = normalizeDisclosureEntry(primary);
  const normalizedFallback = normalizeDisclosureEntry(fallback);

  if (!(normalizedFallback.disclosedHoldings?.length ?? 0)) {
    return normalizedPrimary;
  }

  if (!(normalizedPrimary.disclosedHoldings?.length ?? 0)) {
    return normalizedFallback;
  }

  return compareDisclosureFreshness(normalizedPrimary, normalizedFallback) >= 0 ? normalizedPrimary : normalizedFallback;
}

function formatLocalDate(timestamp) {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parsePingzhongData(content) {
  const nameMatch = content.match(/var\s+fS_name\s*=\s*"([^"]+)"/);
  const netWorthMatch = content.match(/var\s+Data_netWorthTrend\s*=\s*(\[[\s\S]*?\]);/);
  const name = nameMatch ? nameMatch[1].trim() : '';

  if (!netWorthMatch) {
    return { name, navHistory: [] };
  }

  const series = JSON.parse(netWorthMatch[1]);
  const navHistory = series
    .map((item) => ({
      date: formatLocalDate(item.x),
      nav: Number(item.y) || 0,
    }))
    .filter((item) => item.date && item.nav > 0)
    .slice(-420)
    .reverse();

  return { name, navHistory };
}

async function fetchExtendedNavHistory(code) {
  const pageSize = 20;
  const startDate = '2025-01-01';
  const endDate = today;
  const rows = [];
  let pageIndex = 1;
  let totalPages = 1;

  while (pageIndex <= totalPages && pageIndex <= 40) {
    const response = await fetchText(
      `https://api.fund.eastmoney.com/f10/lsjz?callback=x&fundCode=${code}&pageIndex=${pageIndex}&pageSize=${pageSize}&startDate=${startDate}&endDate=${endDate}`,
      { referer: 'https://fundf10.eastmoney.com/' },
      'utf-8',
    );
    const payload = parseJsonpPayload(response);
    const list = payload?.Data?.LSJZList ?? [];
    rows.push(...list);

    const totalCount = Number(payload?.TotalCount) || rows.length;
    totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
    if (!list.length) {
      break;
    }

    pageIndex += 1;
  }

  const byDate = new Map();
  for (const item of rows) {
    const date = String(item?.FSRQ ?? '').slice(0, 10);
    const nav = Number(item?.DWJZ) || 0;
    if (!date || nav <= 0) {
      continue;
    }

    byDate.set(date, nav);
  }

  return [...byDate.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([date, nav]) => ({ date, nav }))
    .slice(-420)
    .reverse();
}

function parseQuote(raw) {
  const match = raw.match(/="([^"]+)"/);
  if (!match) {
    return {
      marketPrice: 0,
      previousClose: 0,
      marketDate: '',
      marketTime: '',
      marketSource: '腾讯行情',
    };
  }

  const fields = match[1].split('~');
  const dateTimeRaw = fields.find((field) => /^\d{14}$/.test(field)) || '';

  return {
    marketPrice: Number(fields[3]) || 0,
    previousClose: Number(fields[4]) || 0,
    marketDate: dateTimeRaw.length >= 8 ? `${dateTimeRaw.slice(0, 4)}-${dateTimeRaw.slice(4, 6)}-${dateTimeRaw.slice(6, 8)}` : '',
    marketTime: dateTimeRaw.length >= 14 ? `${dateTimeRaw.slice(8, 10)}:${dateTimeRaw.slice(10, 12)}:${dateTimeRaw.slice(12, 14)}` : '',
    marketSource: '腾讯行情',
  };
}

function chunkList(list, size) {
  if (!Array.isArray(list) || !list.length) {
    return [];
  }

  const chunkSize = Math.max(1, Number(size) || 1);
  const chunks = [];
  for (let index = 0; index < list.length; index += chunkSize) {
    chunks.push(list.slice(index, index + chunkSize));
  }

  return chunks;
}

function toSecidByTicker(ticker) {
  const normalized = String(ticker || '').trim();
  if (!/^\d{6}$/.test(normalized)) {
    return '';
  }

  if (normalized.startsWith('6')) {
    return `1.${normalized}`;
  }

  return `0.${normalized}`;
}

async function fetchAshareHoldingQuoteMapByTickers(tickers) {
  const uniqueTickers = [...new Set((tickers ?? []).map((item) => String(item || '').trim()).filter((item) => /^\d{6}$/.test(item)))];
  if (!uniqueTickers.length) {
    return new Map();
  }

  const secids = uniqueTickers.map(toSecidByTicker).filter(Boolean);
  const quoteMap = new Map();

  for (const secidGroup of chunkList(secids, HOLDING_QUOTE_BATCH_SIZE)) {
    if (!secidGroup.length) {
      continue;
    }

    try {
      const response = await fetchText(
        `https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&fields=f2,f3,f12,f13,f14&ut=267f9ad526dbe6b0262ab19316f5a25b&secids=${secidGroup.join(',')}`,
        { referer: 'https://fundf10.eastmoney.com/' },
        'utf-8',
      );
      const payload = JSON.parse(response);
      for (const item of payload?.data?.diff ?? []) {
        const ticker = String(item?.f12 ?? '').trim();
        const currentPrice = Number(item?.f2);
        const changeRate = Number(item?.f3) / 100;
        if (!/^\d{6}$/.test(ticker) || !Number.isFinite(currentPrice) || currentPrice <= 0 || !Number.isFinite(changeRate)) {
          continue;
        }

        quoteMap.set(ticker, { currentPrice, changeRate });
      }
    } catch {
      continue;
    }
  }

  return quoteMap;
}

function overlayRealtimeFundQuotes(funds, intradayData) {
  return (funds ?? []).map((fund) => {
    const quote = intradayData?.funds?.[fund.code];
    if (!quote) {
      return fund;
    }

    return {
      ...fund,
      marketPrice: Number.isFinite(quote.marketPrice) ? quote.marketPrice : fund.marketPrice,
      previousClose: Number.isFinite(quote.previousClose) ? quote.previousClose : fund.previousClose,
      marketDate: quote.marketDate || fund.marketDate,
      marketTime: quote.marketTime || fund.marketTime,
      marketSource: quote.marketSource || fund.marketSource,
    };
  });
}

async function refreshRealtimeDisclosedHoldingsQuotes(funds) {
  const stockTickers = [...new Set(
    (funds ?? [])
      .flatMap((fund) => (fund?.disclosedHoldings ?? []).map((item) => String(item?.ticker ?? '').trim()))
      .filter((ticker) => /^\d{6}$/.test(ticker)),
  )];
  if (!stockTickers.length) {
    return funds;
  }

  const quoteMap = await fetchAshareHoldingQuoteMapByTickers(stockTickers);
  if (!quoteMap.size) {
    return funds;
  }

  const quoteDate = today;
  const quoteTime = new Date().toTimeString().slice(0, 8);

  return (funds ?? []).map((fund) => {
    const disclosedHoldings = Array.isArray(fund?.disclosedHoldings) ? fund.disclosedHoldings : [];
    if (!disclosedHoldings.length) {
      return fund;
    }

    let touched = false;
    const refreshedDisclosedHoldings = disclosedHoldings.map((item) => {
      const ticker = String(item?.ticker ?? '').trim();
      const quote = quoteMap.get(ticker);
      if (!quote) {
        return item;
      }

      touched = true;
      return {
        ...item,
        currentPrice: quote.currentPrice,
        changeRate: quote.changeRate,
      };
    });

    if (!touched) {
      return fund;
    }

    const refreshedHoldingQuotes = refreshedDisclosedHoldings
      .map((item) => {
        if (!item?.ticker || !Number.isFinite(item.currentPrice) || item.currentPrice <= 0 || !Number.isFinite(item.changeRate)) {
          return null;
        }

        const previousClose = item.currentPrice / (1 + item.changeRate);
        if (!Number.isFinite(previousClose) || previousClose <= 0) {
          return null;
        }

        return {
          ticker: item.ticker,
          name: item.name,
          currentPrice: item.currentPrice,
          previousClose,
          quoteDate,
          quoteTime,
          currency: getHoldingCurrency(item.ticker),
        };
      })
      .filter(Boolean);

    return {
      ...fund,
      disclosedHoldings: refreshedDisclosedHoldings,
      holdingQuotes: fund.code === '161128' && (fund.holdingQuotes ?? []).length ? fund.holdingQuotes : refreshedHoldingQuotes,
      holdingsQuoteDate: quoteDate,
      holdingsQuoteTime: quoteTime,
    };
  });
}

function parseFxQuote(raw) {
  const currentMatch = raw.match(/var hq_str_fx_susdcny="([^"]+)"/);
  const backupMatch = raw.match(/var hq_str_USDCNY="([^"]+)"/);
  const fields = (currentMatch?.[1] || backupMatch?.[1] || '').split(',');

  if (fields.length < 9) {
    return {
      pair: 'USD/CNY',
      currentRate: 0,
      previousCloseRate: 0,
      quoteDate: '',
      quoteTime: '',
      source: '新浪外汇',
    };
  }

  return {
    pair: 'USD/CNY',
    currentRate: Number(fields[1]) || 0,
    previousCloseRate: Number(fields[2]) || 0,
    quoteDate: fields[fields.length - 1] || '',
    quoteTime: fields[0] || '',
    source: '新浪外汇',
  };
}

function parseUsQuoteRow(rawRow) {
  const fields = rawRow.split('~');
  const dateTime = fields[30] || '';

  return {
    name: fields[1] || '',
    ticker: fields[2]?.replace(/\.[A-Z]+$/, '') || '',
    currentPrice: Number(fields[3]) || 0,
    previousClose: Number(fields[4]) || 0,
    quoteDate: dateTime.split(' ')[0] || '',
    quoteTime: dateTime.split(' ')[1] || '',
  };
}

function parseUsQuotes(raw) {
  return raw
    .split(';')
    .map((row) => row.trim())
    .filter(Boolean)
    .map((row) => {
      const match = row.match(/="([^"]+)"/);
      return match ? parseUsQuoteRow(match[1]) : null;
    })
    .filter(Boolean);
}

function getProxyQuoteSymbol(ticker) {
  const normalized = String(ticker || '').toUpperCase();
  if (!normalized) {
    return '';
  }

  if (SPECIAL_QUOTE_SYMBOL_MAP[normalized]) {
    return SPECIAL_QUOTE_SYMBOL_MAP[normalized];
  }

  if (/^\d{6}$/.test(normalized)) {
    return getQuoteSymbol(normalized);
  }

  const jpMatched = normalized.match(/^(\d{4})\.JP$/);
  if (jpMatched) {
    const remapped = SPECIAL_QUOTE_SYMBOL_MAP[normalized] || SPECIAL_QUOTE_SYMBOL_MAP[`${jpMatched[1]}.JP`];
    if (remapped) {
      return remapped;
    }
    return 'usEWJ';
  }

  if (/^0\d{4}$/.test(normalized)) {
    return `hk${normalized}`;
  }

  return `us${normalized}`;
}

function parseMixedProxyQuotes(raw, proxySymbolMap) {
  const rows = raw
    .split(';')
    .map((row) => row.trim())
    .filter(Boolean);

  const result = [];
  for (const row of rows) {
    const symbolMatch = row.match(/^v_([^=]+)=/);
    if (!symbolMatch) {
      continue;
    }

    const sourceSymbol = symbolMatch[1].toLowerCase();
    const ticker = proxySymbolMap.get(sourceSymbol);
    if (!ticker) {
      continue;
    }

    if (sourceSymbol.startsWith('us')) {
      const contentMatch = row.match(/="([^"]+)"/);
      if (!contentMatch) {
        continue;
      }

      const us = parseUsQuoteRow(contentMatch[1]);
      result.push({
        ticker,
        name: us.name,
        currentPrice: us.currentPrice,
        previousClose: us.previousClose,
        quoteDate: us.quoteDate,
        quoteTime: us.quoteTime,
        currency: 'USD',
      });
      continue;
    }

    const cnOrHk = parseQuote(row);
    result.push({
      ticker,
      name: '',
      currentPrice: cnOrHk.marketPrice,
      previousClose: cnOrHk.previousClose,
      quoteDate: cnOrHk.marketDate,
      quoteTime: cnOrHk.marketTime,
      currency: sourceSymbol.startsWith('hk') ? 'HKD' : 'CNY',
    });
  }

  return result;
}

function getSupplementalQuoteSymbol(ticker) {
  const normalized = String(ticker || '').toUpperCase();
  if (!normalized) {
    return '';
  }

  if (SPECIAL_QUOTE_SYMBOL_MAP[normalized]) {
    return SPECIAL_QUOTE_SYMBOL_MAP[normalized];
  }

  if (isUsHoldingTicker(normalized)) {
    return `us${normalizeUsQuoteTicker(normalized)}`;
  }

  if (/^0\d{4}$/.test(normalized)) {
    return `hk${normalized}`;
  }

  if (/^\d{6}$/.test(normalized)) {
    return `${normalized.startsWith('5') || normalized.startsWith('6') ? 'sh' : 'sz'}${normalized}`;
  }

  return '';
}

function parseSupplementalStandardQuoteRow(rawRow) {
  const fields = rawRow.split('~');
  const dateTimeRaw = fields.find((field) => /^\d{14}$/.test(field)) || '';

  return {
    name: fields[1] || '',
    ticker: fields[2] || '',
    currentPrice: Number(fields[3]) || 0,
    previousClose: Number(fields[4]) || 0,
    quoteDate: dateTimeRaw.length >= 8 ? `${dateTimeRaw.slice(0, 4)}-${dateTimeRaw.slice(4, 6)}-${dateTimeRaw.slice(6, 8)}` : '',
    quoteTime: dateTimeRaw.length >= 14 ? `${dateTimeRaw.slice(8, 10)}:${dateTimeRaw.slice(10, 12)}:${dateTimeRaw.slice(12, 14)}` : '',
  };
}

async function fetchSupplementalHoldingQuoteMap(aliasEntries) {
  const normalizedEntries = [...new Map(
    (aliasEntries ?? [])
      .map((item) => {
        const ticker = String(item?.ticker ?? '').toUpperCase();
        const quoteTicker = String(item?.quoteTicker ?? ticker).toUpperCase();
        return ticker ? [ticker, { ticker, quoteTicker }] : null;
      })
      .filter(Boolean),
  ).values()];
  const quoteTickers = [...new Set(normalizedEntries.map((item) => item.quoteTicker).filter(Boolean))];
  const usTickers = quoteTickers.filter(isUsHoldingTicker);
  const nonUsSymbols = [...new Set(quoteTickers.map((item) => getSupplementalQuoteSymbol(item)).filter((item) => item && !item.startsWith('us')))];

  const quoteByTicker = await fetchOverseasHoldingQuoteMap(usTickers);
  const quoteHistoryDb = await getQuoteHistoryDb();
  if (!nonUsSymbols.length) {
    for (const quoteTicker of quoteTickers) {
      if (quoteByTicker.has(quoteTicker)) {
        continue;
      }

      const historyRow = getQuoteHistoryFallback(quoteHistoryDb, quoteTicker);
      if (!historyRow) {
        continue;
      }

      quoteByTicker.set(quoteTicker, {
        currentPrice: historyRow.currentPrice,
        changeRate: historyRow.previousClose > 0 ? historyRow.currentPrice / historyRow.previousClose - 1 : 0,
      });
    }

    for (const entry of normalizedEntries) {
      if (entry.quoteTicker !== entry.ticker && quoteByTicker.has(entry.quoteTicker) && !quoteByTicker.has(entry.ticker)) {
        quoteByTicker.set(entry.ticker, quoteByTicker.get(entry.quoteTicker));
      }
    }

    return quoteByTicker;
  }

  const response = await fetchText(`https://qt.gtimg.cn/q=${nonUsSymbols.join(',')}`, { referer: 'https://gu.qq.com/' }, 'gb18030');
  const localQuotes = response
    .split(';')
    .map((row) => row.trim())
    .filter(Boolean)
    .map((row) => {
      const match = row.match(/^v_([a-z]+)([^=]+)="([^"]+)"$/i);
      if (!match) {
        return null;
      }

      const [, , rawTicker, rawPayload] = match;
      const parsed = parseSupplementalStandardQuoteRow(rawPayload);
      return {
        ticker: String(parsed.ticker || rawTicker).toUpperCase(),
        currentPrice: parsed.currentPrice,
        previousClose: parsed.previousClose,
      };
    })
    .filter(Boolean)
    .filter((item) => item.currentPrice > 0 && item.previousClose > 0);

  for (const item of localQuotes) {
    quoteByTicker.set(item.ticker, {
      currentPrice: item.currentPrice,
      changeRate: item.previousClose > 0 ? item.currentPrice / item.previousClose - 1 : 0,
    });
  }

  for (const quoteTicker of quoteTickers) {
    if (quoteByTicker.has(quoteTicker)) {
      continue;
    }

    const historyRow = getQuoteHistoryFallback(quoteHistoryDb, quoteTicker);
    if (!historyRow) {
      continue;
    }

    quoteByTicker.set(quoteTicker, {
      currentPrice: historyRow.currentPrice,
      changeRate: historyRow.previousClose > 0 ? historyRow.currentPrice / historyRow.previousClose - 1 : 0,
    });
  }

  for (const entry of normalizedEntries) {
    if (entry.quoteTicker !== entry.ticker && quoteByTicker.has(entry.quoteTicker) && !quoteByTicker.has(entry.ticker)) {
      quoteByTicker.set(entry.ticker, quoteByTicker.get(entry.quoteTicker));
    }
  }

  return quoteByTicker;
}

async function pruneIntradayCache() {
  await fs.mkdir(intradayCacheDir, { recursive: true });
  const entries = await fs.readdir(intradayCacheDir);
  const cutoff = Date.now() - 3 * 24 * 60 * 60 * 1000;

  for (const entry of entries) {
    const fullPath = path.join(intradayCacheDir, entry);
    const stat = await fs.stat(fullPath);
    if (stat.mtimeMs < cutoff) {
      await fs.rm(fullPath, { force: true });
    }
  }
}

async function getDailyFundData(entry, holdingsHistoryByCode = {}) {
  const cachePath = path.join(dailyCacheDir, `${entry.code}.json`);
  const cached = await readJson(cachePath, null);
  if (cached?.fetchedDate === today && cached?.cacheVersion === DAILY_CACHE_VERSION) {
    const refreshedFromCache = await hydrateSupplementalDisclosureQuotes(
      entry.code,
      await hydrateDirectDisclosureQuotes({
        disclosedHoldingsTitle: cached?.disclosedHoldingsTitle ?? '',
        disclosedHoldingsReportDate: cached?.disclosedHoldingsReportDate ?? '',
        disclosedHoldings: cached?.disclosedHoldings ?? [],
      }),
    );

    return {
      ...cached,
      disclosedHoldingsTitle: refreshedFromCache.disclosedHoldingsTitle,
      disclosedHoldingsReportDate: refreshedFromCache.disclosedHoldingsReportDate,
      disclosedHoldings: refreshedFromCache.disclosedHoldings,
      cacheMode: 'daily-cache-quote-refresh',
    };
  }

  const cachedHoldingsDisclosure = cached?.cacheVersion === DAILY_CACHE_VERSION && !shouldRefreshHoldingsDisclosure(cached)
    ? {
        disclosedHoldingsTitle: cached?.disclosedHoldingsTitle ?? '',
        disclosedHoldingsReportDate: cached?.disclosedHoldingsReportDate ?? '',
        disclosedHoldings: cached?.disclosedHoldings ?? [],
      }
    : null;

  const [basicHtml, pingzhongData, fundHtml, holdingsDisclosure, apiPurchaseStatus, portalPurchaseStatus, noticePurchaseStatus] = await Promise.all([
    fetchText(`https://fundf10.eastmoney.com/jbgk_${entry.code}.html`, {}, 'utf-8'),
    fetchText(`https://fund.eastmoney.com/pingzhongdata/${entry.code}.js?v=${Date.now()}`, {
      referer: `https://fund.eastmoney.com/${entry.code}.html`,
    }, 'gb18030'),
    fetchText(`https://fund.eastmoney.com/${entry.code}.html`, {}, 'utf-8'),
    cachedHoldingsDisclosure ? Promise.resolve(cachedHoldingsDisclosure) : fetchHoldingsDisclosure(entry.code),
    fetchPurchaseStatusFromApi(entry.code),
    fetchPurchaseStatusFromPortal(entry.code),
    fetchPurchaseStatusFromNotices(entry.code),
  ]);

  const pingzhong = parsePingzhongData(pingzhongData);
  const extendedNavHistory = await fetchExtendedNavHistory(entry.code).catch(() => []);
  const resolvedNavHistory = extendedNavHistory.length >= pingzhong.navHistory.length ? extendedNavHistory : pingzhong.navHistory;
  const basic = parseBasicInfo(basicHtml, pingzhong.name);
  const purchase = mergePurchaseStatus(parsePurchaseStatusFromHtml(fundHtml), apiPurchaseStatus, portalPurchaseStatus, noticePurchaseStatus);
  const normalizedPurchase = entry.pageCategory === 'etf'
    ? {
        purchaseStatus: '场内交易 / 开放赎回',
        purchaseLimit: '不限购',
      }
    : purchase;
  const relatedEtfCode = extractRelatedEtfCode(fundHtml) || RELATED_ETF_FALLBACKS[entry.code] || '';
  const finalHoldingsDisclosure =
    holdingsDisclosure.disclosedHoldings.length || !relatedEtfCode || relatedEtfCode === entry.code
      ? holdingsDisclosure
      : await fetchHoldingsDisclosure(relatedEtfCode);
  const historicalHoldingsDisclosure = (holdingsHistoryByCode[entry.code] ?? []).reduce(
    (best, item) => pickPreferredDisclosure(best, sanitizeDisclosureForFund(entry.code, item)),
    normalizeDisclosureEntry(null),
  );
  const resolvedHoldingsDisclosure = patchKnownDisclosureGaps(
    entry.code,
    pickPreferredDisclosure(finalHoldingsDisclosure, historicalHoldingsDisclosure),
  );
  const directlyHydratedHoldingsDisclosure = await hydrateDirectDisclosureQuotes(resolvedHoldingsDisclosure);
  const hydratedHoldingsDisclosure = await hydrateSupplementalDisclosureQuotes(entry.code, directlyHydratedHoldingsDisclosure);
  const latestNav = resolvedNavHistory[0] ?? { date: '', nav: 0 };
  const payload = {
    cacheVersion: DAILY_CACHE_VERSION,
    fetchedDate: today,
    holdingsFetchedDate: cachedHoldingsDisclosure ? cached?.holdingsFetchedDate ?? cached?.fetchedDate ?? today : today,
    name: basic.name || entry.code,
    fundType: basic.fundType,
    benchmark: basic.benchmark,
    officialNavT1: latestNav.nav,
    navDate: latestNav.date,
    navHistory: resolvedNavHistory,
    purchaseStatus: normalizedPurchase.purchaseStatus,
    purchaseLimit: normalizedPurchase.purchaseLimit,
    disclosedHoldingsTitle: hydratedHoldingsDisclosure.disclosedHoldingsTitle,
    disclosedHoldingsReportDate: hydratedHoldingsDisclosure.disclosedHoldingsReportDate,
    disclosedHoldings: hydratedHoldingsDisclosure.disclosedHoldings,
  };

  await writeJson(cachePath, payload);
  return { ...payload, cacheMode: 'fresh' };
}

async function loadIntradayData() {
  const cachePath = path.join(intradayCacheDir, `${today}.json`);
  const cached = await readJson(cachePath, { funds: {}, fx: null, holdings161128: [], proxyQuotes: [] });
  const cachedFetchedAtMs = new Date(String(cached?.fetchedAt || '')).getTime();
  const hasFreshIntradayCache = Number.isFinite(cachedFetchedAtMs)
    && cachedFetchedAtMs > 0
    && (Date.now() - cachedFetchedAtMs) <= INTRADAY_CACHE_TTL_MS
    && Object.keys(cached?.funds ?? {}).length > 0;
  if (hasFreshIntradayCache) {
    return { ...cached, cacheMode: 'intraday-cache-ttl' };
  }

  try {
    const fundSymbols = catalog.map((item) => getQuoteSymbol(item.code)).join(',');
    const holdingSymbols = HOLDINGS_161128.map((item) => `us${item.ticker}`).join(',');
    const proxySymbolEntries = [...new Set(Object.values(PROXY_BASKETS).flatMap((item) => item.components.map((component) => component.ticker.toUpperCase())))].map((ticker) => ({
      ticker,
      symbol: getProxyQuoteSymbol(ticker),
    })).filter((item) => item.symbol);
    const proxySymbolMap = new Map(proxySymbolEntries.map((item) => [item.symbol.toLowerCase(), item.ticker]));
    const proxySymbols = proxySymbolEntries.map((item) => item.symbol).join(',');

    const futuresSymbols = [...new Set(Object.values(FUTURES_CONTINUOUS_BY_BASKET).map((item) => item.symbol))].join(',');
    const sinaFuturesSymbols = [...new Set(Object.values(SINA_FUTURES_CARRY_BY_BASKET).map((item) => item.symbol))].join(',');

    const [fundQuotesRaw, fxRaw, holdingsRaw, proxyRaw, futuresRaw, sinaFuturesRaw] = await Promise.all([
      fetchText(`https://qt.gtimg.cn/q=${fundSymbols}`, { referer: 'https://gu.qq.com/' }, 'gb18030'),
      fetchText('https://hq.sinajs.cn/list=USDCNY,fx_susdcny', { referer: 'https://finance.sina.com.cn/' }, 'gb18030'),
      fetchText(`https://qt.gtimg.cn/q=${holdingSymbols}`, { referer: 'https://gu.qq.com/' }, 'gb18030'),
      fetchText(`https://qt.gtimg.cn/q=${proxySymbols}`, { referer: 'https://gu.qq.com/' }, 'gb18030'),
      futuresSymbols ? fetchText(`https://qt.gtimg.cn/q=${futuresSymbols}`, { referer: 'https://gu.qq.com/' }, 'gb18030') : Promise.resolve(''),
      sinaFuturesSymbols ? fetchText(`https://hq.sinajs.cn/list=${sinaFuturesSymbols}`, { referer: 'https://finance.sina.com.cn/' }, 'gb18030') : Promise.resolve(''),
    ]);

    const funds = {};
    for (const row of fundQuotesRaw.split(';')) {
      const trimmed = row.trim();
      if (!trimmed) {
        continue;
      }

      const codeMatch = trimmed.match(/^v_(?:sz|sh)(\d+)="/);
      if (!codeMatch) {
        continue;
      }

      funds[codeMatch[1]] = parseQuote(trimmed);
    }

    const quoteHistoryDb = await getQuoteHistoryDb();
    const proxyQuotes = parseMixedProxyQuotes(proxyRaw, proxySymbolMap);
    const proxyQuoteByTicker = new Map(proxyQuotes.map((item) => [String(item.ticker || '').toUpperCase(), item]));

    for (const entry of proxySymbolEntries) {
      const key = String(entry.ticker || '').toUpperCase();
      if (proxyQuoteByTicker.has(key)) {
        continue;
      }

      const fallbackRow = getQuoteHistoryFallback(quoteHistoryDb, key, 168);
      if (!fallbackRow) {
        continue;
      }

      proxyQuotes.push({
        ticker: key,
        name: fallbackRow.name,
        currentPrice: fallbackRow.currentPrice,
        previousClose: fallbackRow.previousClose,
        quoteDate: fallbackRow.quoteDate,
        quoteTime: fallbackRow.quoteTime,
        currency: 'USD',
      });
    }

    const payload = {
      fetchedAt: new Date().toISOString(),
      funds,
      fx: parseFxQuote(fxRaw),
      holdings161128: parseUsQuotes(holdingsRaw).map((item) => ({
        ...item,
        currency: 'USD',
      })),
      proxyQuotes,
      futuresQuotes: futuresRaw
        ? Object.fromEntries(
            futuresRaw
              .split(';')
              .map((row) => row.trim())
              .filter(Boolean)
              .map((row) => {
                const symbolMatch = row.match(/^v_([^=]+)="([^"]+)"/);
                if (!symbolMatch) {
                  return null;
                }

                const symbol = `sh${symbolMatch[1].replace(/^sh/, '')}`;
                return [symbol, symbolMatch[2]];
              })
              .filter(Boolean),
          )
        : {},
      sinaFuturesQuotes: sinaFuturesRaw
        ? Object.fromEntries(
            sinaFuturesRaw
              .split(';')
              .map((row) => row.trim())
              .filter(Boolean)
              .map((row) => {
                const symbolMatch = row.match(/^var hq_str_([^=]+)="([\s\S]*)"$/);
                if (!symbolMatch) {
                  return null;
                }

                return [symbolMatch[1], symbolMatch[2]];
              })
              .filter(Boolean),
          )
        : {},
    };

    for (const [code, row] of Object.entries(payload.funds || {})) {
      upsertQuoteHistoryRow(quoteHistoryDb, code, {
        name: '',
        currentPrice: row?.marketPrice,
        previousClose: row?.previousClose,
        quoteDate: row?.marketDate,
        quoteTime: row?.marketTime,
      });
    }

    for (const row of payload.holdings161128 || []) {
      upsertQuoteHistoryRow(quoteHistoryDb, row?.ticker, row);
    }

    for (const row of payload.proxyQuotes || []) {
      upsertQuoteHistoryRow(quoteHistoryDb, row?.ticker, row);
    }

    await flushQuoteHistoryDb(quoteHistoryDb);

    await writeJson(cachePath, payload);
    await pruneIntradayCache();
    return { ...payload, cacheMode: 'fresh' };
  } catch {
    return { ...cached, cacheMode: 'intraday-cache' };
  }
}

async function getIntradayData() {
  if (!intradayPromise) {
    intradayPromise = loadIntradayData().finally(() => {
      intradayPromise = null;
    });
  }

  return intradayPromise;
}

function normalizeBatchSize(rawValue, totalCount) {
  const parsed = Number.parseInt(String(rawValue ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return totalCount;
  }

  return Math.max(1, Math.min(totalCount, parsed));
}

async function selectSyncBatch(entries, previousFunds) {
  const total = entries.length;
  const batchSize = normalizeBatchSize(process.env.SYNC_BATCH_SIZE, total);

  if (batchSize >= total) {
    return {
      batchEntries: entries,
      mode: 'full',
      batchSize,
      cursor: 0,
      nextCursor: 0,
    };
  }

  // 首轮没有完整历史快照时仍走全量，避免输出缺基金。
  if ((previousFunds?.length ?? 0) < total) {
    return {
      batchEntries: entries,
      mode: 'warmup-full',
      batchSize: total,
      cursor: 0,
      nextCursor: 0,
    };
  }

  const schedule = await readJson(syncSchedulePath, { cursor: 0 });
  const cursorRaw = Number(schedule?.cursor ?? 0);
  const cursor = ((cursorRaw % total) + total) % total;
  const rotated = [...entries.slice(cursor), ...entries.slice(0, cursor)];
  const batchEntries = rotated.slice(0, batchSize);
  const nextCursor = (cursor + batchEntries.length) % total;

  await writeJson(syncSchedulePath, {
    cursor: nextCursor,
    batchSize,
    updatedAt: new Date().toISOString(),
  });

  return {
    batchEntries,
    mode: 'batched',
    batchSize,
    cursor,
    nextCursor,
  };
}

async function syncFund(entry, holdingsHistoryByCode = {}) {
  const [dailyData, intradayData] = await Promise.all([getDailyFundData(entry, holdingsHistoryByCode), getIntradayData()]);
  const quote = intradayData.funds?.[entry.code] ?? {
    marketPrice: 0,
    previousClose: 0,
    marketDate: '',
    marketTime: '',
    marketSource: '腾讯行情',
  };

  function parseFuturesQuote(raw) {
    const fields = raw.split('~');
    const currentPrice = Number(fields[3]) || 0;
    const previousClose = Number(fields[4]) || 0;
    return {
      currentPrice,
      previousClose,
      marketDate: fields[0] || '',
      marketTime: fields[1] || '',
    };
  }

  function parseSinaFuturesQuote(raw) {
    const fields = String(raw || '').split(',').map((item) => item.trim());
    const currentPrice = Number(fields[0]) || 0;
    const previousCloseCandidates = [Number(fields[1]), Number(fields[7]), Number(fields[8]), Number(fields[2])].filter((v) => Number.isFinite(v) && v > 0);
    const previousClose = previousCloseCandidates[0] || 0;
    const dateMatch = String(raw || '').match(/\d{4}-\d{2}-\d{2}/);
    const timeMatch = String(raw || '').match(/\d{2}:\d{2}:\d{2}/);

    return {
      currentPrice,
      previousClose,
      marketDate: dateMatch ? dateMatch[0] : '',
      marketTime: timeMatch ? timeMatch[0] : '',
    };
  }

  const futuresConfig = entry.proxyBasketKey ? FUTURES_CONTINUOUS_BY_BASKET[entry.proxyBasketKey] : null;
  const futuresQuote = futuresConfig && intradayData.futuresQuotes?.[futuresConfig.symbol]
    ? { ...parseFuturesQuote(intradayData.futuresQuotes[futuresConfig.symbol]), symbol: futuresConfig.symbol, source: 'tencent-futures' }
    : null;
  const sinaFuturesConfig = entry.proxyBasketKey ? SINA_FUTURES_CARRY_BY_BASKET[entry.proxyBasketKey] : null;
  const sinaFuturesQuote = sinaFuturesConfig && intradayData.sinaFuturesQuotes?.[sinaFuturesConfig.symbol]
    ? { ...parseSinaFuturesQuote(intradayData.sinaFuturesQuotes[sinaFuturesConfig.symbol]), symbol: sinaFuturesConfig.symbol, source: 'sina-futures' }
    : null;
  const proxyConfig = entry.proxyBasketKey ? PROXY_BASKETS[entry.proxyBasketKey] : null;
  const dynamicProxyWeights = new Map();
  if (entry.code === '513310') {
    const disclosed = dailyData.disclosedHoldings ?? [];
    const koreaWeight = disclosed
      .filter((item) => ['005930', '000660'].includes(String(item?.ticker ?? '').toUpperCase()))
      .reduce((sum, item) => sum + Math.max(0, Number(item.weight) || 0), 0);
    const chinaWeight = disclosed
      .filter((item) => /^\d{6}$/.test(String(item?.ticker ?? '')) && !['005930', '000660'].includes(String(item?.ticker ?? '').toUpperCase()))
      .reduce((sum, item) => sum + Math.max(0, Number(item.weight) || 0), 0);

    if (koreaWeight > 0 || chinaWeight > 0) {
      const total = koreaWeight + chinaWeight;
      dynamicProxyWeights.set('SOXX', koreaWeight / total);
      dynamicProxyWeights.set('159995', chinaWeight / total);
    }
  }

  const rawProxyQuotes = proxyConfig
    ? proxyConfig.components
        .map((component) => {
          const matched = (intradayData.proxyQuotes ?? []).find((item) => item.ticker.toUpperCase() === component.ticker.toUpperCase());
          if (!matched) {
            return null;
          }

          return {
            ...matched,
            name: component.name,
            weight: dynamicProxyWeights.get(component.ticker.toUpperCase()) ?? component.weight,
          };
        })
        .filter(Boolean)
    : [];
  let proxyQuotes = GOLD_REALTIME_PROXY_CODES.has(entry.code)
    ? applyGoldRealtimeCarryToProxyQuotes(rawProxyQuotes, quote.marketDate, quote.marketTime)
    : rawProxyQuotes;

  let carryReturnRaw = null;
  const carryQuote = futuresQuote && futuresQuote.previousClose > 0
    ? futuresQuote
    : sinaFuturesQuote && sinaFuturesQuote.previousClose > 0
      ? sinaFuturesQuote
      : null;

  if (carryQuote && quote.marketDate) {
    carryReturnRaw = carryQuote.currentPrice / carryQuote.previousClose - 1;
    proxyQuotes = applyAnchorCarryToProxyQuotes(
      proxyQuotes,
      quote.marketDate,
      quote.marketTime,
      carryReturnRaw,
      0.06,
      0.12,
    );
  } else {
    const carryConfig = entry.proxyBasketKey ? REALTIME_PROXY_CARRY_CONFIG_BY_BASKET[entry.proxyBasketKey] : null;
    if (carryConfig && quote.marketDate) {
      const anchorCodes = Array.isArray(carryConfig.anchorCodes) ? carryConfig.anchorCodes : [];
      const selectedAnchorCode = anchorCodes.find((code) => code !== entry.code && intradayData.funds?.[code]);
      if (selectedAnchorCode) {
        const anchorReturnRaw = getFundIntradayReturn(intradayData.funds[selectedAnchorCode]);
        proxyQuotes = applyAnchorCarryToProxyQuotes(
          proxyQuotes,
          quote.marketDate,
          quote.marketTime,
          anchorReturnRaw,
          carryConfig.maxMove,
          carryConfig.anomalyMove,
        );
      }
    }
  }
  const proxyMeta = proxyQuotes[0] ?? null;
  const holdingQuotePayload = buildHoldingQuotes({
    code: entry.code,
    disclosedHoldings: dailyData.disclosedHoldings,
    marketDate: quote.marketDate,
    marketTime: quote.marketTime,
    holdingQuotes: entry.code === '161128' ? intradayData.holdings161128 ?? [] : [],
    holdingsQuoteDate: (intradayData.holdings161128 ?? [])[0]?.quoteDate || '',
    holdingsQuoteTime: (intradayData.holdings161128 ?? [])[0]?.quoteTime || '',
  });

  const runtimeDraft = {
    code: entry.code,
    disclosedHoldings: dailyData.disclosedHoldings,
    holdingQuotes: holdingQuotePayload.holdingQuotes,
  };
  const isGoldRealtimeProxyReady = GOLD_REALTIME_PROXY_CODES.has(entry.code) && proxyQuotes.length > 0;
  const fallbackEstimateMode = isGoldRealtimeProxyReady ? 'proxy' : entry.estimateMode;
  const effectiveEstimateMode = isGoldRealtimeProxyReady
    ? 'proxy'
    : hasHoldingsSignal(runtimeDraft)
      ? 'holdings'
      : fallbackEstimateMode;

  return {
    code: entry.code,
    priority: entry.priority,
    detailMode: entry.detailMode,
    pageCategory: entry.pageCategory,
    estimateMode: effectiveEstimateMode,
    name: DISPLAY_NAME_OVERRIDES[entry.code] || dailyData.name || entry.code,
    fundType: dailyData.fundType,
    benchmark: dailyData.benchmark,
    officialNavT1: dailyData.officialNavT1,
    navDate: dailyData.navDate,
    navHistory: dailyData.navHistory,
    marketPrice: quote.marketPrice,
    previousClose: quote.previousClose,
    marketDate: quote.marketDate,
    marketTime: quote.marketTime,
    marketSource: quote.marketSource,
    purchaseStatus: dailyData.purchaseStatus,
    purchaseLimit: dailyData.purchaseLimit,
    disclosedHoldingsTitle: dailyData.disclosedHoldingsTitle,
    disclosedHoldingsReportDate: dailyData.disclosedHoldingsReportDate,
    disclosedHoldings: dailyData.disclosedHoldings,
    fx: intradayData.fx,
    holdingQuotes: holdingQuotePayload.holdingQuotes,
    holdingsQuoteDate: holdingQuotePayload.holdingsQuoteDate,
    holdingsQuoteTime: holdingQuotePayload.holdingsQuoteTime,
    proxyBasketName: proxyConfig?.name || '',
    proxyQuotes,
    proxyQuoteDate: proxyMeta?.quoteDate || '',
    proxyQuoteTime: proxyMeta?.quoteTime || '',
    goldContinuousReturn: Number.isFinite(carryReturnRaw) ? carryReturnRaw : null,
    goldContinuousSymbol: String(carryQuote?.symbol || ''),
    goldContinuousSource: String(carryQuote?.source || ''),
    cacheMode: intradayData.cacheMode === 'intraday-cache' ? 'intraday-cache' : dailyData.cacheMode,
  };
}

async function main() {
  await fs.mkdir(dailyCacheDir, { recursive: true });
  await fs.mkdir(intradayCacheDir, { recursive: true });

  const funds = [];
  const previousRuntime = await readJson(outputPath, { funds: [] });
  const previousFunds = Array.isArray(previousRuntime?.funds) ? previousRuntime.funds : [];
  const previousFundByCode = new Map(previousFunds.map((item) => [item.code, item]));
  const rawStateCache = await readJson(watchlistStatePath, {});
  const publishedStateCache = await readPublishedRuntimeState();
  let holdingsHistoryByCode = sanitizeDisclosureHistory(await readJson(holdingsDisclosurePath, {}));
  const persistedStateByCode = mergePersistedState(rawStateCache, publishedStateCache);
  const stateByCode = {};

  const batchPlan = await selectSyncBatch(catalog, previousFunds);
  const batchCodeSet = new Set(batchPlan.batchEntries.map((item) => item.code));
  if (batchPlan.mode === 'batched') {
    console.log(`[sync:data] batched mode enabled: ${batchPlan.batchEntries.length}/${catalog.length} funds this run (cursor ${batchPlan.cursor} -> ${batchPlan.nextCursor}).`);
  }

  for (const entry of catalog) {
    if (!batchCodeSet.has(entry.code)) {
      const reusedRuntime = previousFundByCode.get(entry.code);
      if (reusedRuntime) {
        funds.push({
          ...reusedRuntime,
          cacheMode: 'reused-from-previous-runtime',
        });
        stateByCode[entry.code] = normalizePersistedState(entry.code, persistedStateByCode[entry.code]);
        continue;
      }
    }

    try {
      const runtime = await syncFund(entry, holdingsHistoryByCode);
      const currentState = normalizePersistedState(entry.code, persistedStateByCode[entry.code]);
      const reconciled = reconcileJournal(runtime, currentState.model, currentState.journal);
      const estimate = estimateWatchlistFund(runtime, reconciled.model, reconciled.journal);
      const journal = recordEstimateSnapshot(reconciled.journal, runtime, estimate);

      funds.push(runtime);
      holdingsHistoryByCode = updateDisclosureHistory(holdingsHistoryByCode, runtime);
      stateByCode[entry.code] = {
        modelVersion: WATCHLIST_STATE_VERSION,
        model: reconciled.model,
        journal,
      };
    } catch (error) {
      console.error(`Sync failed for ${entry.code}:`, error instanceof Error ? error.message : error);
    }
  }

  funds.sort((left, right) => left.priority - right.priority);

  // Always overlay grouped intraday quotes so batched runs still refresh realtime fields for all funds.
  const intradayData = await getIntradayData();
  const fundsWithRealtimeQuotes = overlayRealtimeFundQuotes(funds, intradayData);
  const fundsWithRealtimeHoldings = await refreshRealtimeDisclosedHoldingsQuotes(fundsWithRealtimeQuotes);

  const normalizedFunds = fundsWithRealtimeHoldings.map((item) => ({
    ...item,
    name: DISPLAY_NAME_OVERRIDES[item.code] || item.name,
    cacheMode: String(intradayData?.cacheMode || '').startsWith('intraday-cache') ? intradayData.cacheMode : item.cacheMode,
  }));

  if (normalizedFunds.length === 0) {
    throw new Error('Sync produced 0 funds. Aborting publish to avoid overwriting the site with an empty runtime payload.');
  }

  await writeJson(watchlistStatePath, {
    __meta: {
      version: WATCHLIST_STATE_VERSION,
      updatedAt: new Date().toISOString(),
    },
    ...stateByCode,
  });

  await writeJson(holdingsDisclosurePath, holdingsHistoryByCode);

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(
    outputPath,
    JSON.stringify(
      {
        syncedAt: new Date().toISOString(),
        funds: normalizedFunds,
        stateByCode,
      },
      null,
      2,
    ),
    'utf8',
  );

  console.log(`Synced ${normalizedFunds.length} funds to ${path.relative(projectRoot, outputPath)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
