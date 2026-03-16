import fs from 'node:fs/promises';
import path from 'node:path';
import { parseNoticeHoldingsDisclosure } from './notice-parsers/registry.mjs';

const TARGET_CODE = String(process.argv[2] || '160723').trim();
const RUNTIME_PATH = path.resolve('public/generated/funds-runtime.json');
const OUT_SVG_PATH = path.resolve(`public/generated/${TARGET_CODE}-offline-research.svg`);
const OUT_JSON_PATH = path.resolve(`public/generated/${TARGET_CODE}-offline-research.json`);
const HOLDINGS_HISTORY_PATH = path.resolve('.cache/fund-sync/holdings-disclosures.json');

const RESEARCH_CONFIG_BY_CODE = {
  '160723': {
    theme: 'oil',
    aliases: [
      { ticker: 'USO', aliases: ['United States Oil Fund LP', 'United States Oil ETF', 'United States Oil'] },
      { ticker: 'WTI_ETC', quoteTicker: 'USO', aliases: ['WisdomTree WTI Crude Oil', 'WisdomTree WTI Crude Oil ETC', 'WisdomTree WTI Crude Oil ETF'] },
      { ticker: 'SIMPLEX_WTI', quoteTicker: 'USO', aliases: ['Simplex WTI ETF'] },
      { ticker: 'BRENT_ETC', quoteTicker: 'BNO', aliases: ['WisdomTree Brent Crude Oil', 'WisdomTree Brent Crude Oil ETC', 'WisdomTree Brent Crude Oil ETF'] },
      { ticker: 'BNO', aliases: ['United States Brent Oil Fund LP', 'Brent Oil Fund LP'] },
      { ticker: '1699', quoteTicker: 'USO', aliases: ['NEXT FUNDS NOMURA Crude Oil Long Index Linked Exchange Traded', 'NEXT FUNDS NOMURA Crude Oil Long Index Linked ETF'] },
      { ticker: 'BRENT_BBG_ETC', quoteTicker: 'BNO', aliases: ['WisdomTree Bloomberg Brent Crude Oil'] },
    ],
    seedHoldings: ['USO', 'WTI_ETC', 'SIMPLEX_WTI', 'BRENT_ETC', 'BNO', '1699', 'BRENT_BBG_ETC'],
    proxyComponents: [
      { ticker: 'USO', weight: 0.7 },
      { ticker: 'BNO', weight: 0.3 },
    ],
    gapSpreadThreshold: 0.018,
    gapSignalThresholdHint: 0.02,
    fxGapWeight: 0.45,
    noteLabel: '油价交易时段/非交易时段',
  },
  '501018': {
    theme: 'oil',
    aliases: [
      { ticker: 'USO', aliases: ['United States Oil Fund LP', 'United States Oil ETF', 'United States Oil'] },
      { ticker: 'BNO', aliases: ['United States Brent Oil Fund LP', 'Brent Oil Fund LP'] },
      { ticker: 'DBO', aliases: ['Invesco DB Oil Fund', 'Invesco DB Oil'] },
      { ticker: 'WTI_ETC', quoteTicker: 'USO', aliases: ['WisdomTree WTI Crude Oil ETF', 'WisdomTree WTI Crude Oil ETC'] },
      { ticker: 'BRENT_ETC', quoteTicker: 'BNO', aliases: ['WisdomTree Brent Crude Oil ETF', 'WisdomTree Brent Crude Oil ETC'] },
      { ticker: 'SIMPLEX_WTI', quoteTicker: 'USO', aliases: ['Simplex WTI ETF'] },
      { ticker: '1699', quoteTicker: 'USO', aliases: ['NEXT FUNDS NOMURA Crude Oil Long Index Linked ETF'] },
      { ticker: 'UBS_CMCI_OIL', quoteTicker: 'DBO', aliases: ['UBS CMCI Oil SF ETF'] },
    ],
    seedHoldings: ['USO', 'BNO', 'DBO', 'WTI_ETC', 'BRENT_ETC', 'SIMPLEX_WTI', '1699'],
    proxyComponents: [
      { ticker: 'USO', weight: 0.45 },
      { ticker: 'BNO', weight: 0.35 },
      { ticker: 'DBO', weight: 0.2 },
    ],
    gapSpreadThreshold: 0.018,
    gapSignalThresholdHint: 0.02,
    fxGapWeight: 0.45,
    noteLabel: '油价交易时段/非交易时段',
  },
  '161129': {
    theme: 'oil',
    aliases: [
      { ticker: 'WTI_ETC', quoteTicker: 'USO', aliases: ['WisdomTree WTI Crude Oil ETC'] },
      { ticker: 'BRENT_ETC', quoteTicker: 'BNO', aliases: ['WisdomTree Brent Crude Oil ETC'] },
      { ticker: 'DBO', aliases: ['Invesco DB Oil Fund', 'Invesco DB Oil'] },
      { ticker: 'SIMPLEX_WTI', quoteTicker: 'USO', aliases: ['Simplex WTI ETF'] },
      { ticker: '1699', quoteTicker: 'USO', aliases: ['NEXT FUNDS NOMURA Crude Oil Long Index Linked ETF'] },
      { ticker: '03175', aliases: ['Samsung S&P GSCI Crude Oil ER Futures ETF', 'F SAMSUNG OIL'] },
      { ticker: 'USO', aliases: ['United States Oil Fund LP', 'United States Oil ETF', 'United States Oil'] },
      { ticker: 'BNO', aliases: ['United States Brent Oil Fund LP', 'Brent Oil Fund LP'] },
    ],
    seedHoldings: ['WTI_ETC', 'BRENT_ETC', 'DBO', 'SIMPLEX_WTI', '1699', '03175', 'USO'],
    proxyComponents: [
      { ticker: 'USO', weight: 0.7 },
      { ticker: 'BNO', weight: 0.3 },
    ],
    gapSpreadThreshold: 0.018,
    gapSignalThresholdHint: 0.02,
    fxGapWeight: 0.45,
    noteLabel: '油价交易时段/非交易时段',
  },
  '160719': {
    theme: 'gold',
    aliases: [
      { ticker: 'GLD', aliases: ['SPDR Gold Shares ETF'] },
      { ticker: 'SGOL', aliases: ['abrdn Physical Gold Shares ETF', 'Physical Gold Shares ETF'] },
      { ticker: 'IAU', aliases: ['iShares Gold Trust ETF', 'iShares Gold Trust'] },
      { ticker: 'SWISSCANTO_GOLD', quoteTicker: 'GLD', aliases: ['Swisscanto CH Gold ETF'] },
      { ticker: 'ETF_SECURITIES_GOLD', quoteTicker: 'GLD', aliases: ['ETF Securities Gold ETF'] },
      { ticker: 'ISHARES_GOLD_CH', quoteTicker: 'GLD', aliases: ['iShares Gold ETF CH'] },
    ],
    seedHoldings: ['GLD', 'SGOL', 'IAU', 'SWISSCANTO_GOLD', 'ETF_SECURITIES_GOLD', 'ISHARES_GOLD_CH'],
    proxyComponents: [
      { ticker: 'GLD', weight: 0.7 },
      { ticker: 'IAU', weight: 0.3 },
    ],
    gapSpreadThreshold: 0.01,
    gapSignalThresholdHint: 0.012,
    fxGapWeight: 0.35,
    noteLabel: '黄金交易时段/非交易时段',
  },
  '161116': {
    theme: 'gold',
    aliases: [
      { ticker: 'GLD', aliases: ['SPDR Gold Shares ETF'] },
      { ticker: 'SGOL', aliases: ['abrdn Physical Gold Shares ETF'] },
      { ticker: 'GLDM', aliases: ['SPDR Gold MiniShares ETF Trust', 'SPDR Gold MiniShares Trust'] },
      { ticker: 'IAU', aliases: ['iShares Gold Trust ETF', 'iShares Gold Trust'] },
      { ticker: 'UBS_GOLD', quoteTicker: 'GLD', aliases: ['UBS Gold ETF'] },
      { ticker: 'UGL', aliases: ['ProShares Ultra Gold ETF'] },
    ],
    seedHoldings: ['GLD', 'SGOL', 'GLDM', 'IAU', 'UBS_GOLD', 'UGL'],
    proxyComponents: [
      { ticker: 'GLD', weight: 0.65 },
      { ticker: 'UGL', weight: 0.35 },
    ],
    gapSpreadThreshold: 0.014,
    gapSignalThresholdHint: 0.014,
    fxGapWeight: 0.35,
    noteLabel: '黄金交易时段/非交易时段',
  },
  '164701': {
    theme: 'gold',
    aliases: [
      { ticker: 'UGL', aliases: ['ProShares Ultra Gold ETF'] },
      { ticker: 'GLDM', aliases: ['SPDR Gold MiniShares Trust'] },
      { ticker: 'GLD', aliases: ['SPDR Gold Shares ETF'] },
      { ticker: 'AAAU', aliases: ['Goldman Sachs Physical Gold ETF'] },
      { ticker: 'SIVR', aliases: ['abrdn Physical Silver Shares ETF'] },
    ],
    seedHoldings: ['UGL', 'GLDM', 'GLD', 'AAAU', 'SIVR'],
    proxyComponents: [
      { ticker: 'GLD', weight: 0.6 },
      { ticker: 'UGL', weight: 0.25 },
      { ticker: 'SIVR', weight: 0.15 },
    ],
    gapSpreadThreshold: 0.016,
    gapSignalThresholdHint: 0.014,
    fxGapWeight: 0.35,
    noteLabel: '贵金属交易时段/非交易时段',
  },
  '160216': {
    theme: 'commodities',
    aliases: [
      { ticker: 'CPER', aliases: ['United States Copper Index Fund'] },
      { ticker: 'GLD', aliases: ['SPDR Gold Shares ETF', 'SPDR Gold ETF'] },
      { ticker: 'GLDM', aliases: ['SPDR Gold MiniShares Trust', 'MiniShares Trust'] },
      { ticker: 'UGL', aliases: ['ProShares Ultra Gold ETF'] },
      { ticker: 'COPX', aliases: ['Global X Copper Miners ETF'] },
      { ticker: 'DBB', aliases: ['Invesco DB Base Metals Fund'] },
      { ticker: 'GDXU', aliases: ['MicroSectors Gold Miners 3X Leveraged ETN', 'Gold Miners 3X Leveraged ETN'] },
    ],
    seedHoldings: ['CPER', 'GLDM', 'GLD', 'UGL', 'COPX', 'DBB', 'GDXU'],
    proxyComponents: [
      { ticker: 'GLD', weight: 0.38 },
      { ticker: 'COPX', weight: 0.24 },
      { ticker: 'DBB', weight: 0.16 },
      { ticker: 'CPER', weight: 0.14 },
      { ticker: 'UGL', weight: 0.08 },
    ],
    gapSpreadThreshold: 0.018,
    gapSignalThresholdHint: 0.016,
    fxGapWeight: 0.38,
    noteLabel: '商品交易时段/非交易时段',
  },
  '501225': {
    theme: 'semiconductor',
    aliases: [
      { ticker: 'SMH', aliases: ['VanEck Semiconductor ETF'] },
      { ticker: 'SOXQ', aliases: ['Invesco PHLX Semiconductor ETF', 'PHLX Semiconductor ETF'] },
      { ticker: 'SOXX', aliases: ['iShares Semiconductor ETF'] },
      { ticker: 'PSI', aliases: ['Invesco Dynamic Semiconductors ETF', 'Dynamic Semiconductors ETF'] },
      { ticker: '159995', aliases: ['华夏国证半导体芯片ETF', '国证半导体芯片 ETF'] },
      { ticker: '512760', aliases: ['国泰CES半导体芯片行业ETF', 'CES 半导体芯片行业 ETF'] },
      { ticker: '159560', aliases: ['景顺长城中证芯片产业ETF', '中证芯片产业 ETF'] },
      { ticker: '2644', quoteTicker: 'SOXX', aliases: ['Global X Semiconductor ETF/Jap'] },
    ],
    seedHoldings: ['SOXX', 'SMH', 'SOXQ', 'PSI', '159995', '512760', '159560', '2644'],
    proxyComponents: [
      { ticker: 'SOXX', weight: 0.5 },
      { ticker: 'SMH', weight: 0.25 },
      { ticker: 'SOXQ', weight: 0.15 },
      { ticker: '159995', weight: 0.1 },
    ],
    gapSpreadThreshold: 0.018,
    gapSignalThresholdHint: 0.014,
    fxGapWeight: 0.32,
    noteLabel: '半导体交易时段/非交易时段',
  },
  '513310': {
    theme: 'semiconductor',
    aliases: [
      { ticker: '005930', quoteTicker: 'SOXX', aliases: ['SamsungElectronics', 'Samsung Electronics'] },
      { ticker: '000660', quoteTicker: 'SOXX', aliases: ['SK hynix', 'SKHynix'] },
      { ticker: '688256', quoteTicker: '159995', aliases: ['寒武纪', 'Cambricon'] },
      { ticker: '688981', quoteTicker: '159995', aliases: ['中芯国际', 'SMIC'] },
      { ticker: '688041', quoteTicker: '159995', aliases: ['海光信息', 'Hygon'] },
      { ticker: '002371', quoteTicker: '159995', aliases: ['北方华创', 'NAURA'] },
      { ticker: '603986', quoteTicker: '159995', aliases: ['兆易创新', 'GigaDevice'] },
      { ticker: '688008', quoteTicker: '159995', aliases: ['澜起科技', 'Montage Technology'] },
      { ticker: '688012', quoteTicker: '159995', aliases: ['中微公司', 'AMEC'] },
      { ticker: '603501', quoteTicker: '159995', aliases: ['韦尔股份', 'Will Semiconductor'] },
      { ticker: 'SOXX', aliases: ['iShares Semiconductor ETF'] },
      { ticker: 'SMH', aliases: ['VanEck Semiconductor ETF'] },
      { ticker: 'SOXQ', aliases: ['Invesco PHLX Semiconductor ETF', 'PHLX Semiconductor ETF'] },
      { ticker: '159995', aliases: ['华夏国证半导体芯片ETF', '国证半导体芯片 ETF'] },
      { ticker: '512760', aliases: ['国泰CES半导体芯片行业ETF', 'CES 半导体芯片行业 ETF'] },
      { ticker: '159560', aliases: ['景顺长城中证芯片产业ETF', '中证芯片产业 ETF'] },
    ],
    seedHoldings: ['005930', '000660', 'SOXX', 'SMH', 'SOXQ', '159995', '512760', '159560'],
    proxyComponents: [
      { ticker: 'SOXX', weight: 0.45 },
      { ticker: '159995', weight: 0.35 },
      { ticker: 'SMH', weight: 0.2 },
    ],
    gapSpreadThreshold: 0.02,
    gapSignalThresholdHint: 0.016,
    fxGapWeight: 0.3,
    minCoverageForHoldings: 0.9,
    anomalyCoverageMax: 0.95,
    anomalyReturnGap: 0.04,
    anomalyDayWeight: 0.55,
    lowCoverageWeight: 0.72,
    lowCoverageThreshold: 0.92,
    robustDropLargestCount: 2,
    robustExcludeAnomaly: true,
    noteLabel: '中韩半导体交易时段/非交易时段',
  },
  '161130': {
    theme: 'nasdaq-tech',
    aliases: [
      { ticker: 'QQQ', aliases: ['Invesco QQQ Trust Series 1', 'Invesco QQQ Trust'] },
      { ticker: 'XLK', aliases: ['Technology Select Sector SPDR ETF'] },
      { ticker: 'SOXX', aliases: ['iShares Semiconductor ETF'] },
      { ticker: 'SMH', aliases: ['VanEck Semiconductor ETF'] },
      { ticker: 'AAPL', aliases: ['Apple Inc'] },
      { ticker: 'MSFT', aliases: ['Microsoft Corp'] },
      { ticker: 'AMZN', aliases: ['Amazon.com Inc'] },
      { ticker: 'NVDA', aliases: ['NVIDIA Corp'] },
      { ticker: 'META', aliases: ['Meta Platforms Inc'] },
      { ticker: 'TSLA', aliases: ['Tesla Inc'] },
      { ticker: 'GOOGL', aliases: ['Alphabet Inc Class A'] },
      { ticker: 'GOOG', aliases: ['Alphabet Inc Class C'] },
      { ticker: 'AVGO', aliases: ['Broadcom Inc'] },
      { ticker: 'COST', aliases: ['Costco Wholesale Corp'] },
    ],
    seedHoldings: ['QQQ', 'XLK', 'SOXX', 'SMH', 'NVDA', 'AAPL', 'MSFT', 'AMZN'],
    proxyComponents: [
      { ticker: 'QQQ', weight: 0.55 },
      { ticker: 'XLK', weight: 0.25 },
      { ticker: 'SOXX', weight: 0.2 },
    ],
    gapSpreadThreshold: 0.016,
    gapSignalThresholdHint: 0.012,
    fxGapWeight: 0.3,
    noteLabel: '纳指科技交易时段/非交易时段',
  },
  '160416': {
    theme: 'oil-upstream',
    aliases: [
      { ticker: 'XOM', aliases: ['Exxon Mobil Corp'] },
      { ticker: 'CVX', aliases: ['Chevron Corp'] },
      { ticker: 'SHEL', aliases: ['Shell PLC'] },
      { ticker: 'RIGD', quoteTicker: 'XOP', aliases: ['RIGD'] },
      { ticker: 'TTEFP', quoteTicker: 'TTE', aliases: ['TotalEnergies SE', 'TTEFP'] },
      { ticker: 'COP', aliases: ['ConocoPhillips'] },
      { ticker: 'EOG', aliases: ['EOG Resources Inc'] },
      { ticker: 'OXY', aliases: ['Occidental Petroleum Corp'] },
      { ticker: 'PSX', aliases: ['Phillips 66'] },
      { ticker: 'MPC', aliases: ['Marathon Petroleum Corp'] },
      { ticker: 'XOP', aliases: ['SPDR S&P Oil & Gas E&P ETF'] },
      { ticker: 'XLE', aliases: ['Energy Select Sector SPDR'] },
    ],
    seedHoldings: ['XOM', 'CVX', 'SHEL', 'COP', 'EOG', 'OXY', 'PSX', 'MPC', 'XOP', 'XLE'],
    proxyComponents: [
      { ticker: 'XOP', weight: 0.7 },
      { ticker: 'XLE', weight: 0.3 },
    ],
    gapSpreadThreshold: 0.02,
    gapSignalThresholdHint: 0.016,
    fxGapWeight: 0.35,
    noteLabel: '油气上游交易时段/非交易时段',
  },
  '162719': {
    theme: 'oil-upstream',
    aliases: [
      { ticker: 'COP', aliases: ['ConocoPhillips'] },
      { ticker: 'EOG', aliases: ['EOG Resources Inc'] },
      { ticker: 'PSX', aliases: ['Phillips 66'] },
      { ticker: 'MPC', aliases: ['Marathon Petroleum Corp'] },
      { ticker: 'DVN', aliases: ['Devon Energy Corp'] },
      { ticker: 'FANG', aliases: ['Diamondback Energy Inc'] },
      { ticker: 'XOM', aliases: ['Exxon Mobil Corp'] },
      { ticker: 'CVX', aliases: ['Chevron Corp'] },
      { ticker: 'XOP', aliases: ['SPDR S&P Oil & Gas E&P ETF'] },
      { ticker: 'XLE', aliases: ['Energy Select Sector SPDR'] },
    ],
    seedHoldings: ['COP', 'EOG', 'PSX', 'MPC', 'DVN', 'FANG', 'XOM', 'CVX', 'XOP', 'XLE'],
    proxyComponents: [
      { ticker: 'XOP', weight: 0.72 },
      { ticker: 'XLE', weight: 0.28 },
    ],
    gapSpreadThreshold: 0.02,
    gapSignalThresholdHint: 0.016,
    fxGapWeight: 0.35,
    noteLabel: '油气上游交易时段/非交易时段',
  },
  '162411': {
    theme: 'oil-upstream',
    aliases: [
      { ticker: 'VG', quoteTicker: 'XOP', aliases: ['VG'] },
      { ticker: 'XOM', aliases: ['Exxon Mobil Corp'] },
      { ticker: 'CVX', aliases: ['Chevron Corp'] },
      { ticker: 'GPOR', aliases: ['Gulfport Energy Corp'] },
      { ticker: 'OXY', aliases: ['Occidental Petroleum Corp'] },
      { ticker: 'CTRA', aliases: ['Coterra Energy Inc'] },
      { ticker: 'COP', aliases: ['ConocoPhillips'] },
      { ticker: 'DVN', aliases: ['Devon Energy Corp'] },
      { ticker: 'XOP', aliases: ['SPDR S&P Oil & Gas E&P ETF'] },
      { ticker: 'XLE', aliases: ['Energy Select Sector SPDR'] },
    ],
    seedHoldings: ['VG', 'XOM', 'CVX', 'GPOR', 'OXY', 'CTRA', 'COP', 'DVN', 'XOP', 'XLE'],
    proxyComponents: [
      { ticker: 'XOP', weight: 0.72 },
      { ticker: 'XLE', weight: 0.28 },
    ],
    gapSpreadThreshold: 0.02,
    gapSignalThresholdHint: 0.016,
    fxGapWeight: 0.35,
    noteLabel: '油气上游交易时段/非交易时段',
  },
  '161125': {
    theme: 'us-tech-large',
    aliases: [
      { ticker: 'NVDA', aliases: ['NVIDIA Corp'] },
      { ticker: 'AAPL', aliases: ['Apple Inc'] },
      { ticker: 'MSFT', aliases: ['Microsoft Corp'] },
      { ticker: 'AMZN', aliases: ['Amazon.com Inc'] },
      { ticker: 'GOOGL', aliases: ['Alphabet Inc Class A'] },
      { ticker: 'GOOG', aliases: ['Alphabet Inc Class C'] },
      { ticker: 'AVGO', aliases: ['Broadcom Inc'] },
      { ticker: 'META', aliases: ['Meta Platforms Inc'] },
      { ticker: 'SPY', aliases: ['SPDR S&P 500 ETF Trust'] },
      { ticker: 'QQQ', aliases: ['Invesco QQQ Trust Series 1', 'Invesco QQQ Trust'] },
      { ticker: 'XLK', aliases: ['Technology Select Sector SPDR ETF'] },
    ],
    seedHoldings: ['NVDA', 'AAPL', 'MSFT', 'AMZN', 'GOOGL', 'AVGO', 'META', 'SPY'],
    proxyComponents: [
      { ticker: 'SPY', weight: 0.55 },
      { ticker: 'QQQ', weight: 0.3 },
      { ticker: 'XLK', weight: 0.15 },
    ],
    gapSpreadThreshold: 0.016,
    gapSignalThresholdHint: 0.012,
    fxGapWeight: 0.28,
    noteLabel: '美股科技交易时段/非交易时段',
  },
  '159509': {
    theme: 'us-nasdaq100',
    aliases: [
      { ticker: 'NVDA', aliases: ['NVIDIA Corp'] },
      { ticker: 'MSFT', aliases: ['Microsoft Corp'] },
      { ticker: 'AAPL', aliases: ['Apple Inc'] },
      { ticker: 'AMZN', aliases: ['Amazon.com Inc'] },
      { ticker: 'META', aliases: ['Meta Platforms Inc'] },
      { ticker: 'GOOGL', aliases: ['Alphabet Inc Class A'] },
      { ticker: 'GOOG', aliases: ['Alphabet Inc Class C'] },
      { ticker: 'AVGO', aliases: ['Broadcom Inc'] },
      { ticker: 'QQQ', aliases: ['Invesco QQQ Trust Series 1', 'Invesco QQQ Trust'] },
      { ticker: 'XLK', aliases: ['Technology Select Sector SPDR ETF'] },
      { ticker: 'SOXX', aliases: ['iShares Semiconductor ETF'] },
    ],
    seedHoldings: ['NVDA', 'MSFT', 'AAPL', 'AMZN', 'META', 'GOOGL', 'AVGO', 'QQQ'],
    proxyComponents: [
      { ticker: 'QQQ', weight: 0.7 },
      { ticker: 'XLK', weight: 0.2 },
      { ticker: 'SOXX', weight: 0.1 },
    ],
    gapSpreadThreshold: 0.016,
    gapSignalThresholdHint: 0.012,
    fxGapWeight: 0.28,
    noteLabel: '纳指交易时段/非交易时段',
  },
  '513100': {
    theme: 'us-nasdaq100',
    aliases: [
      { ticker: 'NVDA', aliases: ['NVIDIA Corp'] },
      { ticker: 'MSFT', aliases: ['Microsoft Corp'] },
      { ticker: 'AAPL', aliases: ['Apple Inc'] },
      { ticker: 'AMZN', aliases: ['Amazon.com Inc'] },
      { ticker: 'META', aliases: ['Meta Platforms Inc'] },
      { ticker: 'GOOGL', aliases: ['Alphabet Inc Class A'] },
      { ticker: 'GOOG', aliases: ['Alphabet Inc Class C'] },
      { ticker: 'AVGO', aliases: ['Broadcom Inc'] },
      { ticker: 'QQQ', aliases: ['Invesco QQQ Trust Series 1', 'Invesco QQQ Trust'] },
      { ticker: 'XLK', aliases: ['Technology Select Sector SPDR ETF'] },
      { ticker: 'SOXX', aliases: ['iShares Semiconductor ETF'] },
    ],
    seedHoldings: ['NVDA', 'MSFT', 'AAPL', 'AMZN', 'META', 'GOOGL', 'AVGO', 'QQQ'],
    proxyComponents: [
      { ticker: 'QQQ', weight: 0.72 },
      { ticker: 'XLK', weight: 0.18 },
      { ticker: 'SOXX', weight: 0.1 },
    ],
    gapSpreadThreshold: 0.016,
    gapSignalThresholdHint: 0.012,
    fxGapWeight: 0.28,
    noteLabel: '纳指交易时段/非交易时段',
  },
  '513500': {
    theme: 'us-tech-large',
    aliases: [
      { ticker: 'SPY', aliases: ['SPDR S&P 500 ETF Trust'] },
      { ticker: 'VOO', aliases: ['Vanguard S&P 500 ETF'] },
      { ticker: 'IVV', aliases: ['iShares Core S&P 500 ETF'] },
      { ticker: 'QQQ', aliases: ['Invesco QQQ Trust Series 1', 'Invesco QQQ Trust'] },
      { ticker: 'XLK', aliases: ['Technology Select Sector SPDR ETF'] },
      { ticker: 'XLF', aliases: ['Financial Select Sector SPDR Fund'] },
      { ticker: 'XLV', aliases: ['Health Care Select Sector SPDR Fund'] },
    ],
    seedHoldings: ['SPY', 'VOO', 'IVV', 'QQQ', 'XLK'],
    proxyComponents: [
      { ticker: 'SPY', weight: 0.68 },
      { ticker: 'VOO', weight: 0.2 },
      { ticker: 'QQQ', weight: 0.12 },
    ],
    gapSpreadThreshold: 0.015,
    gapSignalThresholdHint: 0.011,
    fxGapWeight: 0.28,
    noteLabel: '标普交易时段/非交易时段',
  },
  '513800': {
    theme: 'japan-topix',
    aliases: [
      { ticker: 'EWJ', aliases: ['iShares MSCI Japan ETF'] },
      { ticker: 'DXJ', aliases: ['WisdomTree Japan Hedged Equity Fund'] },
      { ticker: 'FLJP', aliases: ['Franklin FTSE Japan ETF'] },
      { ticker: 'JPXN', aliases: ['iShares JPX-Nikkei 400 ETF'] },
    ],
    seedHoldings: ['EWJ', 'DXJ', 'FLJP', 'JPXN'],
    proxyComponents: [
      { ticker: 'EWJ', weight: 0.58 },
      { ticker: 'DXJ', weight: 0.22 },
      { ticker: 'FLJP', weight: 0.2 },
    ],
    gapSpreadThreshold: 0.013,
    gapSignalThresholdHint: 0.01,
    fxGapWeight: 0.22,
    noteLabel: '日本股市交易时段/非交易时段',
  },
  '513880': {
    theme: 'japan-nikkei',
    aliases: [
      { ticker: 'EWJ', aliases: ['iShares MSCI Japan ETF'] },
      { ticker: 'DXJ', aliases: ['WisdomTree Japan Hedged Equity Fund'] },
      { ticker: 'FLJP', aliases: ['Franklin FTSE Japan ETF'] },
      { ticker: 'JPXN', aliases: ['iShares JPX-Nikkei 400 ETF'] },
    ],
    seedHoldings: ['EWJ', 'DXJ', 'FLJP', 'JPXN'],
    proxyComponents: [
      { ticker: 'EWJ', weight: 0.5 },
      { ticker: 'DXJ', weight: 0.3 },
      { ticker: 'FLJP', weight: 0.2 },
    ],
    gapSpreadThreshold: 0.013,
    gapSignalThresholdHint: 0.01,
    fxGapWeight: 0.22,
    noteLabel: '日经交易时段/非交易时段',
  },
  '513520': {
    theme: 'japan-nikkei',
    aliases: [
      { ticker: 'EWJ', aliases: ['iShares MSCI Japan ETF'] },
      { ticker: 'DXJ', aliases: ['WisdomTree Japan Hedged Equity Fund'] },
      { ticker: 'FLJP', aliases: ['Franklin FTSE Japan ETF'] },
      { ticker: 'JPXN', aliases: ['iShares JPX-Nikkei 400 ETF'] },
    ],
    seedHoldings: ['EWJ', 'DXJ', 'FLJP', 'JPXN'],
    proxyComponents: [
      { ticker: 'EWJ', weight: 0.48 },
      { ticker: 'DXJ', weight: 0.32 },
      { ticker: 'FLJP', weight: 0.2 },
    ],
    gapSpreadThreshold: 0.013,
    gapSignalThresholdHint: 0.01,
    fxGapWeight: 0.22,
    noteLabel: '日经交易时段/非交易时段',
  },
  '159502': {
    theme: 'us-biotech-sp',
    aliases: [
      { ticker: 'XBI', aliases: ['SPDR S&P Biotech ETF'] },
      { ticker: 'IBB', aliases: ['iShares Biotechnology ETF'] },
      { ticker: 'FBT', aliases: ['First Trust NYSE Arca Biotechnology Index Fund'] },
      { ticker: 'XLV', aliases: ['Health Care Select Sector SPDR Fund'] },
    ],
    seedHoldings: ['XBI', 'IBB', 'FBT', 'XLV'],
    proxyComponents: [
      { ticker: 'XBI', weight: 0.55 },
      { ticker: 'IBB', weight: 0.3 },
      { ticker: 'FBT', weight: 0.15 },
    ],
    gapSpreadThreshold: 0.018,
    gapSignalThresholdHint: 0.014,
    fxGapWeight: 0.28,
    noteLabel: '生物科技交易时段/非交易时段',
  },
  '513290': {
    theme: 'us-biotech-nasdaq',
    aliases: [
      { ticker: 'IBB', aliases: ['iShares Biotechnology ETF'] },
      { ticker: 'XBI', aliases: ['SPDR S&P Biotech ETF'] },
      { ticker: 'FBT', aliases: ['First Trust NYSE Arca Biotechnology Index Fund'] },
      { ticker: 'QQQ', aliases: ['Invesco QQQ Trust Series 1', 'Invesco QQQ Trust'] },
    ],
    seedHoldings: ['IBB', 'XBI', 'FBT', 'QQQ'],
    proxyComponents: [
      { ticker: 'IBB', weight: 0.5 },
      { ticker: 'XBI', weight: 0.3 },
      { ticker: 'QQQ', weight: 0.2 },
    ],
    gapSpreadThreshold: 0.018,
    gapSignalThresholdHint: 0.014,
    fxGapWeight: 0.28,
    noteLabel: '生物科技交易时段/非交易时段',
  },
  '159561': {
    theme: 'germany-dax',
    aliases: [
      { ticker: 'EWG', aliases: ['iShares MSCI Germany ETF'] },
      { ticker: 'VGK', aliases: ['Vanguard FTSE Europe ETF'] },
      { ticker: 'FEZ', aliases: ['SPDR EURO STOXX 50 ETF'] },
      { ticker: 'EZU', aliases: ['iShares MSCI Eurozone ETF'] },
    ],
    seedHoldings: ['EWG', 'VGK', 'FEZ', 'EZU'],
    proxyComponents: [
      { ticker: 'EWG', weight: 0.6 },
      { ticker: 'VGK', weight: 0.2 },
      { ticker: 'FEZ', weight: 0.2 },
    ],
    gapSpreadThreshold: 0.014,
    gapSignalThresholdHint: 0.011,
    fxGapWeight: 0.22,
    noteLabel: '德国股市交易时段/非交易时段',
  },
  '513030': {
    theme: 'germany-dax',
    aliases: [
      { ticker: 'EWG', aliases: ['iShares MSCI Germany ETF'] },
      { ticker: 'VGK', aliases: ['Vanguard FTSE Europe ETF'] },
      { ticker: 'FEZ', aliases: ['SPDR EURO STOXX 50 ETF'] },
      { ticker: 'EZU', aliases: ['iShares MSCI Eurozone ETF'] },
    ],
    seedHoldings: ['EWG', 'VGK', 'FEZ', 'EZU'],
    proxyComponents: [
      { ticker: 'EWG', weight: 0.62 },
      { ticker: 'FEZ', weight: 0.23 },
      { ticker: 'VGK', weight: 0.15 },
    ],
    gapSpreadThreshold: 0.014,
    gapSignalThresholdHint: 0.011,
    fxGapWeight: 0.22,
    noteLabel: '德国股市交易时段/非交易时段',
  },
  '513850': {
    theme: 'us-large50',
    aliases: [
      { ticker: 'MGC', aliases: ['Vanguard Mega Cap ETF'] },
      { ticker: 'SPY', aliases: ['SPDR S&P 500 ETF Trust'] },
      { ticker: 'IVV', aliases: ['iShares Core S&P 500 ETF'] },
      { ticker: 'VOO', aliases: ['Vanguard S&P 500 ETF'] },
      { ticker: 'QQQ', aliases: ['Invesco QQQ Trust Series 1', 'Invesco QQQ Trust'] },
    ],
    seedHoldings: ['MGC', 'SPY', 'IVV', 'VOO', 'QQQ'],
    proxyComponents: [
      { ticker: 'MGC', weight: 0.45 },
      { ticker: 'SPY', weight: 0.35 },
      { ticker: 'QQQ', weight: 0.2 },
    ],
    gapSpreadThreshold: 0.015,
    gapSignalThresholdHint: 0.011,
    fxGapWeight: 0.28,
    noteLabel: '美股大盘交易时段/非交易时段',
  },
  '501312': {
    theme: 'us-overseas-tech',
    aliases: [
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
    seedHoldings: ['ARKK', 'ARKG', 'ARKQ', 'SOXX', 'AIQ', 'BOTZ', 'QQQ', 'XLK', 'SMH', 'FINX'],
    proxyComponents: [
      { ticker: 'ARKK', weight: 0.35 },
      { ticker: 'QQQ', weight: 0.3 },
      { ticker: 'XLK', weight: 0.2 },
      { ticker: 'SOXX', weight: 0.15 },
    ],
    gapSpreadThreshold: 0.018,
    gapSignalThresholdHint: 0.014,
    fxGapWeight: 0.28,
    noteLabel: '海外科技交易时段/非交易时段',
  },
  '501011': {
    theme: 'a-share-medicine',
    aliases: [
      { ticker: '000538', aliases: ['云南白药'] },
      { ticker: '600436', aliases: ['片仔癀'] },
      { ticker: '600085', aliases: ['同仁堂'] },
      { ticker: '000423', aliases: ['东阿阿胶'] },
      { ticker: '000999', aliases: ['华润三九'] },
      { ticker: '000623', aliases: ['吉林敖东'] },
      { ticker: '600332', aliases: ['白云山'] },
      { ticker: '002603', aliases: ['以岭药业'] },
      { ticker: '600329', aliases: ['达仁堂'] },
      { ticker: '002317', aliases: ['众生药业'] },
    ],
    seedHoldings: ['000538', '600436', '600085', '000423', '000999', '000623', '600332', '002603', '600329', '002317'],
    proxyComponents: [
      { ticker: '000538', weight: 0.4 },
      { ticker: '600436', weight: 0.35 },
      { ticker: '600085', weight: 0.25 },
    ],
    gapSpreadThreshold: 0.016,
    gapSignalThresholdHint: 0.011,
    fxGapWeight: 0,
    noteLabel: 'A股医药交易时段/非交易时段',
  },
  '501050': {
    theme: 'a-h-bluechip',
    aliases: [
      { ticker: '600519', aliases: ['贵州茅台'] },
      { ticker: '02318', quoteTicker: '601318', aliases: ['中国平安'] },
      { ticker: '601899', aliases: ['紫金矿业'] },
      { ticker: '600036', aliases: ['招商银行'] },
      { ticker: '601166', aliases: ['兴业银行'] },
      { ticker: '600900', aliases: ['长江电力'] },
      { ticker: '688256', aliases: ['寒武纪'] },
      { ticker: '06030', quoteTicker: '600030', aliases: ['中信证券'] },
      { ticker: '600276', aliases: ['恒瑞医药'] },
      { ticker: '01398', quoteTicker: '601398', aliases: ['工商银行'] },
    ],
    seedHoldings: ['600519', '601318', '601899', '600036', '601166', '600900', '688256', '600030', '600276', '601398'],
    proxyComponents: [
      { ticker: '601318', weight: 0.4 },
      { ticker: '600519', weight: 0.3 },
      { ticker: '601899', weight: 0.3 },
    ],
    gapSpreadThreshold: 0.016,
    gapSignalThresholdHint: 0.011,
    fxGapWeight: 0,
    noteLabel: 'A/H蓝筹交易时段/非交易时段',
  },
  '160221': {
    theme: 'a-share-resources',
    aliases: [
      { ticker: '601899', aliases: ['紫金矿业'] },
      { ticker: '603993', aliases: ['洛阳钼业'] },
      { ticker: '600111', aliases: ['北方稀土'] },
      { ticker: '603799', aliases: ['华友钴业'] },
      { ticker: '601600', aliases: ['中国铝业'] },
      { ticker: '002460', aliases: ['赣锋锂业'] },
      { ticker: '000807', aliases: ['云铝股份'] },
      { ticker: '600547', aliases: ['山东黄金'] },
      { ticker: '600489', aliases: ['中金黄金'] },
      { ticker: '002466', aliases: ['天齐锂业'] },
    ],
    seedHoldings: ['601899', '603993', '600111', '603799', '601600', '002460', '000807', '600547', '600489', '002466'],
    proxyComponents: [
      { ticker: '601899', weight: 0.5 },
      { ticker: '603993', weight: 0.3 },
      { ticker: '600111', weight: 0.2 },
    ],
    gapSpreadThreshold: 0.018,
    gapSignalThresholdHint: 0.012,
    fxGapWeight: 0,
    noteLabel: 'A股资源交易时段/非交易时段',
  },
  '165520': {
    theme: 'a-share-resources',
    aliases: [
      { ticker: '601899', aliases: ['紫金矿业'] },
      { ticker: '603993', aliases: ['洛阳钼业'] },
      { ticker: '600111', aliases: ['北方稀土'] },
      { ticker: '603799', aliases: ['华友钴业'] },
      { ticker: '601600', aliases: ['中国铝业'] },
      { ticker: '002460', aliases: ['赣锋锂业'] },
      { ticker: '600547', aliases: ['山东黄金'] },
      { ticker: '000807', aliases: ['云铝股份'] },
      { ticker: '600489', aliases: ['中金黄金'] },
      { ticker: '002466', aliases: ['天齐锂业'] },
    ],
    seedHoldings: ['601899', '603993', '600111', '603799', '601600', '002460', '600547', '000807', '600489', '002466'],
    proxyComponents: [
      { ticker: '601899', weight: 0.5 },
      { ticker: '603993', weight: 0.3 },
      { ticker: '600111', weight: 0.2 },
    ],
    gapSpreadThreshold: 0.018,
    gapSignalThresholdHint: 0.012,
    fxGapWeight: 0,
    noteLabel: 'A股资源交易时段/非交易时段',
  },
  '167301': {
    theme: 'a-share-financials',
    aliases: [
      { ticker: '601318', aliases: ['中国平安'] },
      { ticker: '601601', aliases: ['中国太保'] },
      { ticker: '601628', aliases: ['中国人寿'] },
      { ticker: '601336', aliases: ['新华保险'] },
      { ticker: '601319', aliases: ['中国人保'] },
      { ticker: '601398', aliases: ['工商银行'] },
      { ticker: '601288', aliases: ['农业银行'] },
      { ticker: '600036', aliases: ['招商银行'] },
      { ticker: '601328', aliases: ['交通银行'] },
      { ticker: '601988', aliases: ['中国银行'] },
    ],
    seedHoldings: ['601318', '601601', '601628', '601336', '601319', '601398', '601288', '600036', '601328', '601988'],
    proxyComponents: [
      { ticker: '601318', weight: 0.45 },
      { ticker: '601398', weight: 0.3 },
      { ticker: '600036', weight: 0.25 },
    ],
    gapSpreadThreshold: 0.016,
    gapSignalThresholdHint: 0.01,
    fxGapWeight: 0,
    noteLabel: 'A股金融交易时段/非交易时段',
  },
  '161226': {
    theme: 'silver',
    aliases: [
      { ticker: 'SLV', aliases: ['iShares Silver Trust', 'iShares Silver Trust ETF'] },
      { ticker: 'SIVR', aliases: ['abrdn Physical Silver Shares ETF', 'Physical Silver Shares ETF'] },
      { ticker: 'AGQ', aliases: ['ProShares Ultra Silver'] },
      { ticker: 'GLD', aliases: ['SPDR Gold Shares ETF'] },
    ],
    seedHoldings: ['SLV', 'SIVR', 'AGQ', 'GLD'],
    proxyComponents: [
      { ticker: 'SLV', weight: 0.72 },
      { ticker: 'SIVR', weight: 0.2 },
      { ticker: 'AGQ', weight: 0.08 },
    ],
    gapSpreadThreshold: 0.018,
    gapSignalThresholdHint: 0.014,
    fxGapWeight: 0.35,
    minCoverageForHoldings: 0.99,
    anomalyCoverageMax: 0.85,
    anomalyReturnGap: 0.06,
    anomalyDayWeight: 0.35,
    lowCoverageWeight: 0.6,
    lowCoverageThreshold: 0.96,
    forcedAnomalyDates: ['2026-02-02'],
    coverageHighThreshold: 0.975,
    coverageMidThreshold: 0.93,
    highCoverageLeadScale: 1.08,
    midCoverageLeadScale: 1,
    lowCoverageLeadScale: 0.86,
    highCoverageBaseBlendAdjust: 0.04,
    midCoverageBaseBlendAdjust: 0,
    lowCoverageBaseBlendAdjust: -0.2,
    gapCoefHigh: 0.22,
    gapCoefMid: 0.38,
    gapCoefLow: 0.62,
    gapAmplifyHigh: 0.18,
    gapAmplifyMid: 0.3,
    gapAmplifyLow: 0.56,
    gapSignalThresholdHigh: 0.01,
    gapSignalThresholdMid: 0.008,
    gapSignalThresholdLow: 0.006,
    robustDropLargestCount: 9,
    robustExcludeAnomaly: true,
    noteLabel: '白银交易时段/非交易时段',
  },
  '161128': {
    theme: 'us-tech-large',
    aliases: [
      { ticker: 'NVDA', aliases: ['NVIDIA Corp'] },
      { ticker: 'AAPL', aliases: ['Apple Inc'] },
      { ticker: 'MSFT', aliases: ['Microsoft Corp'] },
      { ticker: 'AVGO', aliases: ['Broadcom Inc'] },
      { ticker: 'PLTR', aliases: ['Palantir Technologies Inc'] },
      { ticker: 'AMD', aliases: ['Advanced Micro Devices Inc'] },
      { ticker: 'ORCL', aliases: ['Oracle Corp'] },
      { ticker: 'MU', aliases: ['Micron Technology Inc'] },
      { ticker: 'CSCO', aliases: ['Cisco Systems Inc'] },
      { ticker: 'IBM', aliases: ['International Business Machines Corp', 'IBM Corp'] },
      { ticker: 'QQQ', aliases: ['Invesco QQQ Trust'] },
      { ticker: 'XLK', aliases: ['Technology Select Sector SPDR ETF'] },
      { ticker: 'SOXX', aliases: ['iShares Semiconductor ETF'] },
    ],
    seedHoldings: ['NVDA', 'AAPL', 'MSFT', 'AVGO', 'PLTR', 'AMD', 'ORCL', 'MU', 'CSCO', 'IBM'],
    proxyComponents: [
      { ticker: 'QQQ', weight: 0.55 },
      { ticker: 'XLK', weight: 0.3 },
      { ticker: 'SOXX', weight: 0.15 },
    ],
    gapSpreadThreshold: 0.016,
    gapSignalThresholdHint: 0.012,
    fxGapWeight: 0.3,
    noteLabel: '美股科技交易时段/非交易时段',
  },
};
const TARGET_CONFIG = RESEARCH_CONFIG_BY_CODE[TARGET_CODE];
if (!TARGET_CONFIG) {
  throw new Error(`unsupported code ${TARGET_CODE}; currently supported: ${Object.keys(RESEARCH_CONFIG_BY_CODE).join(', ')}`);
}
const HOLDING_ALIAS = TARGET_CONFIG.aliases;

function average(values) {
  if (!values.length) {
    return Number.NaN;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function averageTrimmed(values, dropLargestCount = 1) {
  if (!values.length) {
    return Number.NaN;
  }

  if (values.length <= dropLargestCount + 2) {
    return average(values);
  }

  const sorted = [...values].sort((left, right) => right - left);
  const trimmed = sorted.slice(dropLargestCount);
  return average(trimmed);
}

function weightedAverage(values, weights) {
  if (!values.length || values.length !== weights.length) {
    return Number.NaN;
  }

  let weightedSum = 0;
  let weightSum = 0;
  for (let i = 0; i < values.length; i += 1) {
    const w = Math.max(0, Number(weights[i]) || 0);
    weightedSum += values[i] * w;
    weightSum += w;
  }

  if (weightSum <= 0) {
    return Number.NaN;
  }

  return weightedSum / weightSum;
}

function getPointLossWeight(point) {
  const anomalyDayWeight = Number(TARGET_CONFIG.anomalyDayWeight ?? 1);
  const lowCoverageWeight = Number(TARGET_CONFIG.lowCoverageWeight ?? 1);
  const lowCoverageThreshold = Number(TARGET_CONFIG.lowCoverageThreshold ?? 0);

  let weight = 1;
  if (point.isAnomalyDay) {
    weight *= anomalyDayWeight;
  }
  if (lowCoverageThreshold > 0 && (point.coverageRatio ?? 0) < lowCoverageThreshold) {
    weight *= lowCoverageWeight;
  }

  return Math.max(0.12, weight);
}

function weightedMaeFromPoints(points) {
  return weightedAverage(points.map((item) => item.navError), points.map((item) => getPointLossWeight(item)));
}

function weightedMae30FromPoints(points) {
  const recent = points.slice(-30);
  return weightedAverage(recent.map((item) => item.navError), recent.map((item) => getPointLossWeight(item)));
}

function robustMae30FromPoints(points) {
  const windowSize = 30;
  const dropLargestCount = Math.max(1, Number(TARGET_CONFIG.robustDropLargestCount ?? 1));
  const excludeAnomaly = Boolean(TARGET_CONFIG.robustExcludeAnomaly);
  const recent = points.slice(-windowSize);
  const usable = excludeAnomaly
    ? recent.filter((item) => !item.isAnomalyDay)
    : recent;
  const fallback = usable.length >= 12 ? usable : recent;
  return averageTrimmed(fallback.map((item) => item.navError), dropLargestCount);
}

function solveLinearSystem(matrix, vector) {
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
    const pv = a[col][col];
    for (let j = col; j <= n; j += 1) {
      a[col][j] /= pv;
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

function fitLinearWeights(features, targets, sampleWeights, ridge = 0.2) {
  if (!features.length || features.length !== targets.length || features.length !== sampleWeights.length) {
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

function quantile(values, q) {
  if (!values.length) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q)));
  return sorted[index];
}

function clampRange(value, minValue, maxValue) {
  return Math.max(minValue, Math.min(maxValue, value));
}

function optionalFiniteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function averageTop(values, count) {
  if (!values.length) {
    return 0;
  }

  const top = [...values].sort((left, right) => right - left).slice(0, Math.max(1, count));
  return average(top);
}

function parseIsoDate(value) {
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function diffDays(prevDate, currDate) {
  const prev = parseIsoDate(prevDate);
  const curr = parseIsoDate(currDate);
  if (!prev || !curr) {
    return 1;
  }

  return Math.max(1, Math.round((curr.getTime() - prev.getTime()) / 86400000));
}

function fitHuberIrls(features, targets, delta = 0.012, ridge = 0.35, iterations = 8) {
  if (!features.length || features.length !== targets.length) {
    return null;
  }

  let weights = fitLinearWeights(features, targets, targets.map(() => 1), ridge);
  if (!weights) {
    return null;
  }

  for (let iter = 0; iter < iterations; iter += 1) {
    const sampleWeights = [];
    for (let i = 0; i < features.length; i += 1) {
      const x = features[i];
      const y = targets[i];
      const predicted = x.reduce((sum, value, index) => sum + value * (weights[index] || 0), 0);
      const residual = Math.abs(y - predicted);
      sampleWeights.push(residual <= delta ? 1 : delta / Math.max(residual, 1e-6));
    }

    const next = fitLinearWeights(features, targets, sampleWeights, ridge);
    if (!next) {
      break;
    }
    weights = next;
  }

  return weights;
}

function splitTrainTuning(rows) {
  if (rows.length < 80) {
    const splitIndex = Math.max(20, Math.floor(rows.length * 0.8));
    return {
      core: rows.slice(0, splitIndex),
      tuning: rows.slice(splitIndex),
    };
  }

  const splitIndex = Math.max(60, Math.floor(rows.length * 0.82));
  return {
    core: rows.slice(0, splitIndex),
    tuning: rows.slice(splitIndex),
  };
}

function makeRobustFeatures(list) {
  return list.map((item) => {
    const h = item.holdingReturn;
    const fx = item.fxReturn;
    return [
      1,
      h,
      fx,
      h + fx,
      Math.abs(h + fx),
      Math.sign(h + fx) * (h + fx) * (h + fx),
      item.coverageRatio,
      h * item.coverageRatio,
      fx * item.coverageRatio,
    ];
  });
}

function predictByWeights(row, weights) {
  const h = row.holdingReturn;
  const fx = row.fxReturn;
  const mixed = h + fx;
  const x = [
    1,
    h,
    fx,
    mixed,
    Math.abs(mixed),
    Math.sign(mixed) * mixed * mixed,
    row.coverageRatio,
    h * row.coverageRatio,
    fx * row.coverageRatio,
  ];
  return x.reduce((sum, value, index) => sum + value * (weights[index] || 0), 0);
}

function evaluateAdaptive(rows, baseWeights, params, initialState) {
  const points = [];
  const state = {
    kTrading: initialState?.kTrading ?? 1,
    bTrading: initialState?.bTrading ?? 0,
    kOff: initialState?.kOff ?? 1,
    bOff: initialState?.bOff ?? 0,
    gapBias: initialState?.gapBias ?? 0,
    lastTargetReturn: initialState?.lastTargetReturn ?? 0,
  };

  for (const row of rows) {
    const coverageRatio = Number(row.coverageRatio ?? 0);
    const coverageHighThreshold = Number(params.coverageHighThreshold ?? 1.1);
    const coverageMidThreshold = Number(params.coverageMidThreshold ?? coverageHighThreshold);
    const coverageBand = coverageRatio >= coverageHighThreshold
      ? 'high'
      : (coverageRatio >= coverageMidThreshold ? 'mid' : 'low');
    const pickByBand = (highValue, midValue, lowValue, fallback) => {
      if (coverageBand === 'high') {
        return highValue ?? fallback;
      }
      if (coverageBand === 'mid') {
        return midValue ?? fallback;
      }
      return lowValue ?? fallback;
    };

    const baseReturn = predictByWeights(row, baseWeights);
    const isTradingSession = params.sessionSplit ? row.isOilTradingSession : true;
    const coverageLeadScale = Number(
      pickByBand(
        params.highCoverageLeadScale,
        params.midCoverageLeadScale,
        params.lowCoverageLeadScale,
        1,
      )
    );
    const leadSignalRaw = row.holdingReturn + params.fxMix * row.fxReturn;
    const directionalScale = leadSignalRaw >= 0
      ? (params.upMoveScale ?? 1)
      : (params.downMoveScale ?? 1);
    const leadSignal = isTradingSession
      ? leadSignalRaw * params.tradingLeadScale * directionalScale * coverageLeadScale + params.tradingStaticBias
      : leadSignalRaw * params.offLeadScale * directionalScale * coverageLeadScale + params.offStaticBias;
    const shockThreshold = isTradingSession ? params.tradingShockThreshold : params.offShockThreshold;
    const shockFlag = Math.abs(leadSignal) >= shockThreshold;
    const sessionK = isTradingSession ? state.kTrading : state.kOff;
    const sessionB = isTradingSession ? state.bTrading : state.bOff;
    const adaptiveReturn = sessionK * leadSignal + sessionB;
    const coverageBlendAdjust = Number(
      pickByBand(
        params.highCoverageBaseBlendAdjust,
        params.midCoverageBaseBlendAdjust,
        params.lowCoverageBaseBlendAdjust,
        0,
      )
    );
    const baseBlendRaw = isTradingSession ? params.tradingBaseBlend : params.offBaseBlend;
    const baseBlend = clampRange(baseBlendRaw + coverageBlendAdjust, 0.2, 0.98);
    const blended = shockFlag
      ? params.shockBaseBlend * baseReturn + (1 - params.shockBaseBlend) * adaptiveReturn
      : baseBlend * baseReturn + (1 - baseBlend) * adaptiveReturn;
    const excess = Math.max(0, Math.abs(leadSignal) - shockThreshold);
    const shockBoost = shockFlag ? Math.sign(leadSignal) * excess * params.shockAmplify : 0;
    const gapSignalThreshold = Number(
      pickByBand(
        params.gapSignalThresholdHigh,
        params.gapSignalThresholdMid,
        params.gapSignalThresholdLow,
        params.gapSignalThreshold,
      )
    );
    const gapCoef = Number(
      pickByBand(
        params.gapCoefHigh,
        params.gapCoefMid,
        params.gapCoefLow,
        params.gapCoef,
      )
    );
    const gapAmplify = Number(
      pickByBand(
        params.gapAmplifyHigh,
        params.gapAmplifyMid,
        params.gapAmplifyLow,
        params.gapAmplify,
      )
    );
    const branchGapFlag = params.gapBranch && (row.isGapDayHint || Math.abs(row.gapSignal) >= gapSignalThreshold);
    const gapExcess = Math.max(0, Math.abs(row.gapSignal) - gapSignalThreshold);
    const gapCorrection = branchGapFlag
      ? gapCoef * row.gapSignal + state.gapBias + Math.sign(row.gapSignal) * gapExcess * gapAmplify
      : 0;
    const weekendSignal = leadSignalRaw + params.weekendFxCoef * row.fxReturn;
    const weekendExcess = row.dayGapDays > 1 ? Math.max(0, Math.abs(weekendSignal) - params.weekendThreshold) : 0;
    const weekendCorrection = row.dayGapDays > 1 ? Math.sign(weekendSignal) * weekendExcess * params.weekendAmplify : 0;
    const extremeExcess = Math.max(0, Math.abs(leadSignalRaw) - (params.extremeThreshold ?? Number.POSITIVE_INFINITY));
    const extremeCorrection = Math.sign(leadSignalRaw) * extremeExcess * (params.extremeAmplify ?? 0);
    const weekendMomentum = row.dayGapDays > 1 ? (params.weekendMomentumCoef ?? 0) * state.lastTargetReturn : 0;
    const withMemory = blended + shockBoost + gapCorrection + weekendCorrection + extremeCorrection + weekendMomentum + params.arWeight * state.lastTargetReturn;
    const predictedReturn = clampRange(withMemory, params.minReturn, params.maxReturn);
    const predictedNav = row.prevNav * (1 + predictedReturn);
    const navError = row.actualNav > 0 ? Math.abs(predictedNav / row.actualNav - 1) : 0;
    const premiumProxyError = Math.abs(predictedReturn - row.holdingReturn);

    points.push({
      date: row.date,
      prevNav: row.prevNav,
      actualNav: row.actualNav,
      predictedNav,
      predictedReturn,
      targetReturn: row.targetReturn,
      navError,
      premiumProxyError,
      disclosureDate: row.disclosureDate,
      coverageRatio: row.coverageRatio,
      dayGapDays: row.dayGapDays,
      isOilTradingSession: row.isOilTradingSession,
      isGapDayHint: row.isGapDayHint,
      isAnomalyDay: Boolean(row.isAnomalyDay),
      gapSignal: row.gapSignal,
      usoReturn: row.usoReturn,
      bnoReturn: row.bnoReturn,
      oilSpread: row.oilSpread,
      fxReturn: row.fxReturn,
    });

    const residual = row.targetReturn - predictedReturn;
    if (isTradingSession) {
      state.bTrading = (1 - params.biasLearnRate) * state.bTrading + params.biasLearnRate * residual;
    } else {
      state.bOff = (1 - params.biasLearnRate) * state.bOff + params.biasLearnRate * residual;
    }

    if (Math.abs(leadSignal) >= params.updateMinMove) {
      const ratio = clampRange(row.targetReturn / leadSignal, params.kMin, params.kMax);
      if (isTradingSession) {
        state.kTrading = (1 - params.kLearnRate) * state.kTrading + params.kLearnRate * ratio;
      } else {
        state.kOff = (1 - params.kLearnRate) * state.kOff + params.kLearnRate * ratio;
      }
    }

    if (branchGapFlag) {
      state.gapBias = (1 - params.gapBiasLearnRate) * state.gapBias + params.gapBiasLearnRate * residual;
    }

    state.lastTargetReturn = row.targetReturn;
  }

  return { points, state };
}

function parseJsonpPayload(content) {
  const text = String(content || '').trim();
  if (!text) {
    return null;
  }

  const jsonText = text.startsWith('{') ? text : text.replace(/^[^(]+\(/, '').replace(/\);?\s*$/, '');
  try {
    return JSON.parse(jsonText);
  } catch {
    return null;
  }
}

function quoteTickerFor(ticker) {
  const upper = String(ticker || '').toUpperCase();
  const found = HOLDING_ALIAS.find((item) => item.ticker.toUpperCase() === upper);
  return (found?.quoteTicker || upper).toUpperCase();
}

function isCompatibleDisclosure(disclosure) {
  const allowedTickers = new Set(HOLDING_ALIAS.map((item) => String(item.ticker || '').toUpperCase()));
  const holdings = Array.isArray(disclosure?.holdings) ? disclosure.holdings : [];
  if (!holdings.length) {
    return false;
  }

  const matched = holdings.filter((item) => allowedTickers.has(String(item?.ticker || '').toUpperCase())).length;
  return matched >= Math.max(1, Math.floor(Math.min(holdings.length, 4) / 2));
}

function sanitizeDisclosures(disclosures) {
  return (disclosures || []).filter((item) => isCompatibleDisclosure(item));
}

function parseCsvDailyClose(csvText) {
  const lines = String(csvText || '').trim().split(/\r?\n/).filter(Boolean);
  if (lines.length <= 1) {
    return new Map();
  }

  const header = lines[0].toLowerCase();
  const dateIdx = header.split(',').findIndex((item) => item.trim() === 'date');
  const closeIdx = header.split(',').findIndex((item) => item.trim() === 'close');
  if (dateIdx < 0 || closeIdx < 0) {
    return new Map();
  }

  const out = new Map();
  for (let i = 1; i < lines.length; i += 1) {
    const cols = lines[i].split(',');
    const date = String(cols[dateIdx] || '').trim();
    const close = Number(cols[closeIdx]);
    if (!date || !Number.isFinite(close) || close <= 0) {
      continue;
    }
    out.set(date, close);
  }

  return out;
}

async function fetchStooqSeries(symbol) {
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(symbol)}&i=d`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`stooq ${symbol} ${response.status}`);
  }
  const csv = await response.text();
  return parseCsvDailyClose(csv);
}

function getAshareSecid(ticker) {
  const code = String(ticker || '').toUpperCase();
  if (!/^\d{6}$/.test(code)) {
    return null;
  }
  if (code.startsWith('6') || code.startsWith('9')) {
    return `1.${code}`;
  }
  return `0.${code}`;
}

async function fetchAshareSeries(ticker) {
  const secid = getAshareSecid(ticker);
  if (!secid) {
    return new Map();
  }
  const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6,f7,f8&fields2=f51,f52,f53,f54,f55,f56,f57,f58&klt=101&fqt=1&beg=20240101&end=20500101`;
  const response = await fetch(url, { headers: { referer: 'https://quote.eastmoney.com/' } });
  if (!response.ok) {
    throw new Error(`ashare ${ticker} ${response.status}`);
  }
  const payload = await response.json();
  const klines = payload?.data?.klines || [];
  const series = new Map();
  for (const row of klines) {
    const cols = String(row).split(',');
    const date = String(cols[0] || '').trim();
    const close = Number(cols[2]);
    if (!date || !Number.isFinite(close) || close <= 0) {
      continue;
    }
    series.set(date, close);
  }
  return series;
}

async function fetchQuoteSeriesByTicker(ticker) {
  const normalized = String(ticker || '').toUpperCase();
  if (/^\d{6}$/.test(normalized)) {
    return fetchAshareSeries(normalized);
  }
  return fetchStooqSeries(`${normalized.toLowerCase()}.us`);
}

async function fetchReportList() {
  const url = `https://api.fund.eastmoney.com/f10/JJGG?callback=x&fundcode=${TARGET_CODE}&pageIndex=1&pageSize=200&type=3`;
  const response = await fetch(url, { headers: { referer: 'https://fundf10.eastmoney.com/' } });
  if (!response.ok) {
    throw new Error(`report list ${response.status}`);
  }

  const text = await response.text();
  const payload = parseJsonpPayload(text);
  return (payload?.Data || []).filter((item) => /季度报告/.test(item?.TITLE || ''));
}

async function fetchQuarterDisclosures() {
  const reports = await fetchReportList();
  const disclosures = [];

  for (const report of reports) {
    const artCode = report?.ID;
    if (!artCode) {
      continue;
    }

    try {
      const contentUrl = `https://np-cnotice-fund.eastmoney.com/api/content/ann?client_source=web_fund&show_all=1&art_code=${artCode}`;
      const contentResponse = await fetch(contentUrl, { headers: { referer: `https://fund.eastmoney.com/gonggao/${TARGET_CODE},${artCode}.html` } });
      if (!contentResponse.ok) {
        continue;
      }
      const contentPayload = await contentResponse.json();
      const parsed = parseNoticeHoldingsDisclosure(TARGET_CODE, {
        noticeTitle: report.TITLE,
        noticeContent: contentPayload?.data?.notice_content || '',
        aliases: HOLDING_ALIAS,
        quoteByTicker: new Map(),
      });

      if (!parsed.disclosedHoldings?.length || !parsed.disclosedHoldingsReportDate) {
        continue;
      }

      disclosures.push({
        reportDate: parsed.disclosedHoldingsReportDate,
        title: parsed.disclosedHoldingsTitle || report.TITLE,
        holdings: parsed.disclosedHoldings.slice(0, 10).map((item) => ({
          ticker: String(item.ticker || '').toUpperCase(),
          weight: Number(item.weight) || 0,
        })),
      });
    } catch {
      continue;
    }
  }

  const dedup = new Map();
  for (const item of disclosures) {
    const key = `${item.reportDate}|${item.title}`;
    dedup.set(key, item);
  }

  const parsedDisclosures = sanitizeDisclosures([...dedup.values()].sort((left, right) => left.reportDate.localeCompare(right.reportDate)));
  if (parsedDisclosures.length >= 4) {
    return parsedDisclosures;
  }

  const reportBoundaries = reports
    .map((item) => {
      const match = String(item?.TITLE || '').match(/(\d{4})年第([1-4])季度报告/);
      if (!match) {
        return null;
      }
      const year = Number(match[1]);
      const quarter = Number(match[2]);
      const date = {
        1: `${year}-03-31`,
        2: `${year}-06-30`,
        3: `${year}-09-30`,
        4: `${year}-12-31`,
      }[quarter];
      return date ? { reportDate: date, title: item?.TITLE || '' } : null;
    })
    .filter((item) => Boolean(item))
    .sort((left, right) => left.reportDate.localeCompare(right.reportDate));

  const seedHoldings = parsedDisclosures[parsedDisclosures.length - 1]?.holdings?.length
    ? parsedDisclosures[parsedDisclosures.length - 1].holdings
    : TARGET_CONFIG.seedHoldings.map((ticker) => ({
        ticker,
        weight: 100 / Math.max(1, TARGET_CONFIG.seedHoldings.length),
      }));

  return reportBoundaries.map((item) => ({
    reportDate: item.reportDate,
    title: item.title,
    holdings: seedHoldings,
  }));
}

async function loadDisclosuresFromCache() {
  try {
    const raw = await fs.readFile(HOLDINGS_HISTORY_PATH, 'utf8');
    const payload = JSON.parse(raw);
    const entries = Array.isArray(payload?.[TARGET_CODE]) ? payload[TARGET_CODE] : [];

    const normalized = entries
      .map((item) => ({
        reportDate: String(item?.reportDate || ''),
        title: String(item?.title || ''),
        holdings: Array.isArray(item?.holdings)
          ? item.holdings.slice(0, 10).map((holding) => ({
              ticker: String(holding?.ticker || '').toUpperCase(),
              weight: Number(holding?.weight) || 0,
            }))
          : [],
      }))
      .filter((item) => item.reportDate && item.holdings.length > 0);

    const dedup = new Map();
    for (const item of normalized) {
      dedup.set(`${item.reportDate}|${item.title}`, item);
    }

    return sanitizeDisclosures([...dedup.values()].sort((left, right) => left.reportDate.localeCompare(right.reportDate)));
  } catch {
    return [];
  }
}

function getActiveDisclosure(date, disclosures) {
  let active = null;
  for (const disclosure of disclosures) {
    if (disclosure.reportDate <= date) {
      active = disclosure;
    } else {
      break;
    }
  }
  return active;
}

function buildRows(navHistoryAsc, disclosures, quoteSeriesByTicker, fxSeries) {
  const rows = [];
  const proxyComponents = TARGET_CONFIG.proxyComponents ?? [];
  const forcedAnomalyDateSet = new Set(
    Array.isArray(TARGET_CONFIG.forcedAnomalyDates)
      ? TARGET_CONFIG.forcedAnomalyDates.map((item) => String(item).trim()).filter(Boolean)
      : []
  );

  for (let i = 1; i < navHistoryAsc.length; i += 1) {
    const prev = navHistoryAsc[i - 1];
    const curr = navHistoryAsc[i];
    if (!(prev?.nav > 0) || !(curr?.nav > 0)) {
      continue;
    }

    const activeDisclosure = getActiveDisclosure(curr.date, disclosures);
    const holdings = activeDisclosure?.holdings || [];
    const declaredWeight = holdings.reduce((sum, item) => sum + Math.max(0, Number(item.weight) || 0), 0);

    let weightedReturn = 0;
    let coveredWeight = 0;
    let usedCount = 0;

    for (const holding of holdings) {
      const proxyTicker = quoteTickerFor(holding.ticker);
      const series = quoteSeriesByTicker.get(proxyTicker);
      if (!series) {
        continue;
      }

      const closePrev = series.get(prev.date);
      const closeCurr = series.get(curr.date);
      if (!(closePrev > 0) || !(closeCurr > 0)) {
        continue;
      }

      const r = closeCurr / closePrev - 1;
      const w = Math.max(0, Number(holding.weight) || 0);
      weightedReturn += r * w;
      coveredWeight += w;
      usedCount += 1;
    }

    let primaryReturn = 0;
    let secondaryReturn = 0;
    let hasPrimaryReturn = false;
    let hasSecondaryReturn = false;
    const proxyReturnParts = [];
    for (let proxyIndex = 0; proxyIndex < proxyComponents.length; proxyIndex += 1) {
      const proxy = proxyComponents[proxyIndex];
      const series = quoteSeriesByTicker.get(proxy.ticker);
      if (!series) {
        continue;
      }

      const closePrev = series.get(prev.date);
      const closeCurr = series.get(curr.date);
      if (closePrev > 0 && closeCurr > 0) {
        const proxyReturn = closeCurr / closePrev - 1;
        if (proxyIndex === 0) {
          primaryReturn = proxyReturn;
          hasPrimaryReturn = true;
        }
        if (proxyIndex === 1) {
          secondaryReturn = proxyReturn;
          hasSecondaryReturn = true;
        }
        proxyReturnParts.push({ weight: proxy.weight, value: proxyReturn });
      }
    }

    const proxyReturnWeight = proxyReturnParts.reduce((sum, item) => sum + item.weight, 0);
    const proxyReturn = proxyReturnWeight > 0
      ? proxyReturnParts.reduce((sum, item) => sum + item.value * (item.weight / proxyReturnWeight), 0)
      : 0;
    const uncoveredDeclaredWeight = Math.max(0, declaredWeight - coveredWeight);
    const outsideTopWeight = Math.max(0, 100 - declaredWeight);
    const fillWeight = uncoveredDeclaredWeight + outsideTopWeight;
    const blendedWeight = coveredWeight + fillWeight;
    const holdingReturn = blendedWeight > 0
      ? (weightedReturn + proxyReturn * fillWeight) / blendedWeight
      : proxyReturn;
    const coverageRatio = Math.max(0, Math.min(1, coveredWeight / 100));
    const minCoverageForHoldings = Number(TARGET_CONFIG.minCoverageForHoldings ?? 0);
    const coverageScale = minCoverageForHoldings > 0
      ? clampRange((coverageRatio - minCoverageForHoldings) / Math.max(1e-6, 1 - minCoverageForHoldings), 0, 1)
      : 1;
    const stabilizedHoldingReturn = coverageScale * holdingReturn + (1 - coverageScale) * proxyReturn;

    const fxPrev = fxSeries.get(prev.date);
    const fxCurr = fxSeries.get(curr.date);
    const fxReturn = fxPrev > 0 && fxCurr > 0 ? fxCurr / fxPrev - 1 : 0;
    const dayGapDays = diffDays(prev.date, curr.date);
    const isOilTradingSession = dayGapDays === 1;
    const proxySpread = hasPrimaryReturn && hasSecondaryReturn ? primaryReturn - secondaryReturn : 0;
    const gapSignal = 0.7 * (holdingReturn - proxyReturn) + 0.3 * proxySpread + (TARGET_CONFIG.fxGapWeight ?? 0.4) * fxReturn;
    const isGapDayHint = dayGapDays > 1 || Math.abs(proxySpread) >= (TARGET_CONFIG.gapSpreadThreshold ?? 0.015) || Math.abs(gapSignal) >= (TARGET_CONFIG.gapSignalThresholdHint ?? 0.015);
    const targetReturn = curr.nav / prev.nav - 1;
    const anomalyCoverageMax = Number(TARGET_CONFIG.anomalyCoverageMax ?? -1);
    const anomalyReturnGap = Number(TARGET_CONFIG.anomalyReturnGap ?? Number.POSITIVE_INFINITY);
    const isForcedAnomalyDay = forcedAnomalyDateSet.has(curr.date);
    const isAnomalyDay = isForcedAnomalyDay || (
      anomalyCoverageMax >= 0
      && coverageRatio <= anomalyCoverageMax
      && Math.abs(targetReturn - proxyReturn) >= anomalyReturnGap
    );

    rows.push({
      date: curr.date,
      prevDate: prev.date,
      prevNav: prev.nav,
      actualNav: curr.nav,
      targetReturn,
      holdingReturn: stabilizedHoldingReturn,
      fxReturn,
      coverageRatio,
      usedCount,
      disclosureDate: activeDisclosure?.reportDate || '',
      dayGapDays,
      isOilTradingSession,
      usoReturn: primaryReturn,
      bnoReturn: secondaryReturn,
      oilSpread: proxySpread,
      gapSignal,
      isGapDayHint,
      isAnomalyDay,
    });
  }

  return rows;
}

function buildNavFallbackRows(navHistoryAsc) {
  const rows = [];
  for (let i = 1; i < navHistoryAsc.length; i += 1) {
    const prev = navHistoryAsc[i - 1];
    const curr = navHistoryAsc[i];
    if (!(prev?.nav > 0) || !(curr?.nav > 0)) {
      continue;
    }

    const targetReturn = curr.nav / prev.nav - 1;
    rows.push({
      date: curr.date,
      prevDate: prev.date,
      prevNav: prev.nav,
      actualNav: curr.nav,
      targetReturn,
      holdingReturn: targetReturn,
      fxReturn: 0,
      coverageRatio: 0,
      usedCount: 0,
      disclosureDate: '',
      dayGapDays: diffDays(prev.date, curr.date),
      isOilTradingSession: diffDays(prev.date, curr.date) === 1,
      usoReturn: 0,
      bnoReturn: 0,
      oilSpread: 0,
      gapSignal: 0,
      isGapDayHint: false,
      isAnomalyDay: false,
    });
  }

  return rows;
}

function splitTrainValidation(rows) {
  const train = rows.filter((item) => item.date.startsWith('2025-'));
  const validation = rows.filter((item) => item.date >= '2026-01-01');

  if (train.length >= 40 && validation.length >= 30) {
    return { train, validation, mode: 'year-split' };
  }

  const splitIndex = Math.max(40, Math.floor(rows.length * 0.7));
  return {
    train: rows.slice(0, splitIndex),
    validation: rows.slice(splitIndex),
    mode: 'fallback-70-30',
  };
}

function evaluate(rows, predictor) {
  return rows.map((row) => {
    const predictedReturn = predictor(row);
    const predictedNav = row.prevNav * (1 + predictedReturn);
    const navError = row.actualNav > 0 ? Math.abs(predictedNav / row.actualNav - 1) : 0;
    const premiumProxyError = Math.abs(predictedReturn - row.holdingReturn);

    return {
      date: row.date,
      actualNav: row.actualNav,
      predictedNav,
      navError,
      premiumProxyError,
      disclosureDate: row.disclosureDate,
      coverageRatio: row.coverageRatio,
    };
  });
}

function summarizeTopErrors(points, limit = 8) {
  return [...points]
    .sort((left, right) => right.navError - left.navError)
    .slice(0, limit)
    .map((item) => {
      const tags = [];
      if (!item.isOilTradingSession) {
        tags.push('非油价交易时段');
      }
      if (item.isGapDayHint) {
        tags.push('缺口日');
      }
      if (Math.abs(item.gapSignal) >= 0.02) {
        tags.push('主代理/次代理与FX错位');
      }
      if (Math.abs((item.usoReturn ?? 0) - (item.bnoReturn ?? 0)) >= 0.02) {
        tags.push('主代理/次代理分化大');
      }
      if (Math.abs(item.fxReturn ?? 0) >= 0.006) {
        tags.push('汇率波动较大');
      }
      if ((item.coverageRatio ?? 0) < 0.9) {
        tags.push('披露覆盖不足');
      }
      if (item.isAnomalyDay) {
        tags.push('异常日');
      }

      return {
        date: item.date,
        absError: item.navError,
        predictedReturn: item.predictedReturn,
        targetReturn: item.targetReturn,
        residualCorrection: item.residualCorrection ?? 0,
        isOilTradingSession: item.isOilTradingSession,
        isGapDayHint: item.isGapDayHint,
        isAnomalyDay: item.isAnomalyDay,
        gapSignal: item.gapSignal,
        usoReturn: item.usoReturn,
        bnoReturn: item.bnoReturn,
        fxReturn: item.fxReturn,
        tags,
      };
    });
}

function makeResidualFeatures(point) {
  const nonTrading = point.isOilTradingSession ? 0 : 1;
  const gapHint = point.isGapDayHint ? 1 : 0;
  const curved = Math.sign(point.predictedReturn) * point.predictedReturn * point.predictedReturn;
  return [
    1,
    point.gapSignal,
    point.fxReturn,
    point.oilSpread ?? ((point.usoReturn ?? 0) - (point.bnoReturn ?? 0)),
    nonTrading,
    gapHint,
    curved,
  ];
}

function applyResidualCorrection(points, weights, shrink, cap, minReturn, maxReturn) {
  return points.map((point) => {
    const features = makeResidualFeatures(point);
    const raw = features.reduce((sum, value, index) => sum + value * (weights[index] || 0), 0);
    const regimeFactor = point.isGapDayHint || !point.isOilTradingSession ? 1 : 0.35;
    const correction = clampRange(shrink * regimeFactor * raw, -cap, cap);
    const predictedReturn = clampRange(point.predictedReturn + correction, minReturn, maxReturn);
    const predictedNav = point.prevNav * (1 + predictedReturn);
    const navError = point.actualNav > 0 ? Math.abs(predictedNav / point.actualNav - 1) : 0;

    return {
      ...point,
      predictedReturn,
      predictedNav,
      navError,
      residualCorrection: correction,
    };
  });
}

function xmlEscape(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function pathFromPoints(points, scaleX, scaleY) {
  if (!points.length) {
    return '';
  }
  return points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${scaleX(point.date).toFixed(2)} ${scaleY(point.value).toFixed(2)}`).join(' ');
}

function renderChart({ x, y, width, height, title, yFormatter, yMin, yMax, dates, series, splitDate }) {
  const padLeft = 56;
  const padRight = 20;
  const padTop = 40;
  const padBottom = 40;
  const innerWidth = width - padLeft - padRight;
  const innerHeight = height - padTop - padBottom;

  const dateIndex = new Map(dates.map((date, index) => [date, index]));
  const scaleX = (date) => x + padLeft + ((dateIndex.get(date) || 0) / Math.max(1, dates.length - 1)) * innerWidth;
  const span = Math.max(1e-9, yMax - yMin);
  const scaleY = (value) => y + padTop + (1 - (value - yMin) / span) * innerHeight;

  const yTicks = Array.from({ length: 5 }, (_, i) => yMax - (i / 4) * span);
  const xTickIndices = [0, 0.16, 0.32, 0.5, 0.68, 0.84, 1].map((ratio) => Math.round(ratio * Math.max(0, dates.length - 1)));

  const yLines = yTicks.map((tick) => {
    const py = scaleY(tick);
    return `<line x1="${x + padLeft}" y1="${py.toFixed(2)}" x2="${x + width - padRight}" y2="${py.toFixed(2)}" stroke="#d7e3df" stroke-width="1" />
      <text x="${x + padLeft - 8}" y="${(py + 4).toFixed(2)}" text-anchor="end" fill="#5b6b68" font-size="11">${xmlEscape(yFormatter(tick))}</text>`;
  }).join('\n');

  const xLines = [...new Set(xTickIndices)].map((index) => {
    const date = dates[index];
    const px = scaleX(date);
    return `<line x1="${px.toFixed(2)}" y1="${y + padTop}" x2="${px.toFixed(2)}" y2="${y + height - padBottom}" stroke="#eef3f1" stroke-width="1" />
      <text x="${px.toFixed(2)}" y="${y + height - 12}" text-anchor="middle" fill="#5b6b68" font-size="11">${xmlEscape(date.slice(2))}</text>`;
  }).join('\n');

  const splitMarkup = splitDate && dateIndex.has(splitDate)
    ? `<line x1="${scaleX(splitDate).toFixed(2)}" y1="${y + padTop}" x2="${scaleX(splitDate).toFixed(2)}" y2="${y + height - padBottom}" stroke="#f59e0b" stroke-width="1.4" stroke-dasharray="4 4" />
       <text x="${(scaleX(splitDate) + 6).toFixed(2)}" y="${y + padTop - 8}" fill="#a16207" font-size="11">验证起点</text>`
    : '';

  const lineMarkup = series.map((item) => {
    const d = pathFromPoints(item.points.map((point) => ({ date: point.date, value: point.value })), scaleX, scaleY);
    if (!d) {
      return '';
    }
    return `<path d="${d}" fill="none" stroke="${item.color}" stroke-width="2" ${item.dashed ? 'stroke-dasharray="6 4"' : ''} />`;
  }).join('\n');

  const legend = series.map((item, idx) => {
    const lx = x + padLeft + idx * 215;
    const ly = y + 20;
    return `<line x1="${lx}" y1="${ly}" x2="${lx + 26}" y2="${ly}" stroke="${item.color}" stroke-width="2" ${item.dashed ? 'stroke-dasharray="6 4"' : ''} />
      <text x="${lx + 32}" y="${ly + 4}" fill="#24312e" font-size="12">${xmlEscape(item.label)}</text>`;
  }).join('\n');

  return `<g>
    <text x="${x + 12}" y="${y + 18}" fill="#1f2937" font-size="16" font-weight="700">${xmlEscape(title)}</text>
    ${legend}
    ${yLines}
    ${xLines}
    ${splitMarkup}
    ${lineMarkup}
  </g>`;
}

function renderSvg({ dates, segmentedPoints, splitDate, meta }) {
  const width = 1360;
  const height = 980;

  const navValues = segmentedPoints.flatMap((item) => [item.actualNav, item.predictedNav]).filter((value) => Number.isFinite(value));
  const errValues = segmentedPoints.map((item) => item.navError).filter((value) => Number.isFinite(value));

  const navMin = Math.min(...navValues) * 0.995;
  const navMax = Math.max(...navValues) * 1.005;
  const errMax = Math.max(0.001, ...errValues) * 1.12;

  const navChart = renderChart({
    x: 42,
    y: 92,
    width: 1270,
    height: 390,
    title: 'A. 净值拟合（同日对齐，无平移）',
    yFormatter: (value) => value.toFixed(3),
    yMin: navMin,
    yMax: navMax,
    dates,
    splitDate,
    series: [
      { label: '真实净值', color: '#0f766e', points: segmentedPoints.map((item) => ({ date: item.date, value: item.actualNav })) },
      { label: '持仓分段估值', color: '#1d4ed8', points: segmentedPoints.map((item) => ({ date: item.date, value: item.predictedNav })) },
    ],
  });

  const errChart = renderChart({
    x: 42,
    y: 520,
    width: 1270,
    height: 360,
    title: 'B. 绝对误差（越低越好）',
    yFormatter: (value) => `${(value * 100).toFixed(2)}%`,
    yMin: 0,
    yMax: errMax,
    dates,
    splitDate,
    series: [
      { label: '持仓分段误差', color: '#1d4ed8', points: segmentedPoints.map((item) => ({ date: item.date, value: item.navError })) },
    ],
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#f4efe6" />
      <stop offset="100%" stop-color="#eef5f2" />
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="${width}" height="${height}" fill="url(#bg)" />
  <text x="46" y="36" fill="#1f2937" font-size="31" font-weight="700">${TARGET_CODE} 离线研究图（持仓逐日估值版）</text>
  <text x="46" y="66" fill="#5b6b68" font-size="13">历史前十大持仓 + 持仓逐日涨跌幅 + USDCNY；双目标 lambda=${meta.lambda.toFixed(2)}；披露期数 ${meta.disclosureCount}；覆盖率均值 ${(meta.avgCoverage * 100).toFixed(1)}%</text>
  ${navChart}
  ${errChart}
</svg>`;
}

async function main() {
  const runtimeRaw = await fs.readFile(RUNTIME_PATH, 'utf8');
  const runtimePayload = JSON.parse(runtimeRaw);
  const fund = (runtimePayload.funds || []).find((item) => item.code === TARGET_CODE);

  if (!fund) {
    throw new Error(`fund ${TARGET_CODE} not found in runtime`);
  }

  const navHistoryAsc = [...(fund.navHistory || [])].sort((left, right) => left.date.localeCompare(right.date));
  if (navHistoryAsc.length < 120) {
    throw new Error(`insufficient nav history: ${navHistoryAsc.length}`);
  }

  let disclosures = await fetchQuarterDisclosures();
  if (!disclosures.length) {
    disclosures = await loadDisclosuresFromCache();
  }
  if (!disclosures.length) {
    disclosures = [
      {
        reportDate: navHistoryAsc[0]?.date || '2025-01-01',
        title: 'fallback-seed-holdings',
        holdings: TARGET_CONFIG.seedHoldings.map((ticker) => ({
          ticker,
          weight: 100 / Math.max(1, TARGET_CONFIG.seedHoldings.length),
        })),
      },
    ];
  }

  const quoteTickers = [...new Set(disclosures.flatMap((item) => item.holdings.map((holding) => quoteTickerFor(holding.ticker))))];
  const quoteSeriesByTicker = new Map();

  for (const ticker of quoteTickers) {
    try {
      const series = await fetchQuoteSeriesByTicker(ticker);
      if (series.size) {
        quoteSeriesByTicker.set(ticker, series);
      }
    } catch {
      continue;
    }
  }

  const fxSeries = await fetchStooqSeries('usdcny');
  let rows = buildRows(navHistoryAsc, disclosures, quoteSeriesByTicker, fxSeries);
  let fallbackMode = 'none';
  if (rows.length < 50) {
    rows = buildNavFallbackRows(navHistoryAsc);
    fallbackMode = 'nav-fallback';
  }

  if (rows.length < 30) {
    throw new Error(`insufficient aligned rows: ${rows.length}`);
  }

  const { train, validation, mode: splitMode } = splitTrainValidation(rows);
  if (!train.length || !validation.length) {
    const splitIndex = Math.max(1, Math.floor(rows.length * 0.7));
    const patchedTrain = rows.slice(0, splitIndex);
    const patchedValidation = rows.slice(splitIndex);
    train.splice(0, train.length, ...patchedTrain);
    validation.splice(0, validation.length, ...patchedValidation);
  }

  const robustFeaturesTrain = makeRobustFeatures(train);
  const robustTargetsTrain = train.map((item) => item.targetReturn);
  const robustWeights = fitHuberIrls(robustFeaturesTrain, robustTargetsTrain, 0.011, 0.42, 10)
    || fitLinearWeights(robustFeaturesTrain, robustTargetsTrain, train.map(() => 1), 0.5)
    || [0, 0.85, 0.25, 1.0, 0, 0, 0, 0, 0];

  const leadSignalsTrain = train.map((item) => item.holdingReturn + 0.7 * item.fxReturn);
  const targetReturnsTrain = train.map((item) => item.targetReturn);
  const absTargetTrain = targetReturnsTrain.map((item) => Math.abs(item));
  const maxAbsMove = Math.max(0.04, quantile(absTargetTrain, 0.995), quantile(leadSignalsTrain.map((item) => Math.abs(item)), 0.995));
  const minReturnCap = -(maxAbsMove * 1.8 + 0.015);
  const maxReturnCap = maxAbsMove * 1.8 + 0.015;
  const tuningSplit = splitTrainTuning(train);
  const sessionTradingLeadAbs = train.filter((item) => item.isOilTradingSession).map((item) => Math.abs(item.holdingReturn + 0.7 * item.fxReturn));
  const sessionOffLeadAbs = train.filter((item) => !item.isOilTradingSession).map((item) => Math.abs(item.holdingReturn + 0.7 * item.fxReturn));
  const fallbackLeadAbs = train.map((item) => Math.abs(item.holdingReturn + 0.7 * item.fxReturn));
  const gapAbsSignals = train.map((item) => Math.abs(item.gapSignal));

  const adaptiveParamGrid = [];
  const coverageHighThresholdBase = optionalFiniteNumber(TARGET_CONFIG.coverageHighThreshold);
  const coverageMidThresholdBase = optionalFiniteNumber(TARGET_CONFIG.coverageMidThreshold);
  const highCoverageLeadScaleBase = optionalFiniteNumber(TARGET_CONFIG.highCoverageLeadScale);
  const midCoverageLeadScaleBase = optionalFiniteNumber(TARGET_CONFIG.midCoverageLeadScale);
  const lowCoverageLeadScaleBase = optionalFiniteNumber(TARGET_CONFIG.lowCoverageLeadScale);
  const highCoverageBaseBlendAdjustBase = optionalFiniteNumber(TARGET_CONFIG.highCoverageBaseBlendAdjust);
  const midCoverageBaseBlendAdjustBase = optionalFiniteNumber(TARGET_CONFIG.midCoverageBaseBlendAdjust);
  const lowCoverageBaseBlendAdjustBase = optionalFiniteNumber(TARGET_CONFIG.lowCoverageBaseBlendAdjust);
  const gapCoefHighBase = optionalFiniteNumber(TARGET_CONFIG.gapCoefHigh);
  const gapCoefMidBase = optionalFiniteNumber(TARGET_CONFIG.gapCoefMid);
  const gapCoefLowBase = optionalFiniteNumber(TARGET_CONFIG.gapCoefLow);
  const gapAmplifyHighBase = optionalFiniteNumber(TARGET_CONFIG.gapAmplifyHigh);
  const gapAmplifyMidBase = optionalFiniteNumber(TARGET_CONFIG.gapAmplifyMid);
  const gapAmplifyLowBase = optionalFiniteNumber(TARGET_CONFIG.gapAmplifyLow);
  const gapSignalThresholdHighBase = optionalFiniteNumber(TARGET_CONFIG.gapSignalThresholdHigh);
  const gapSignalThresholdMidBase = optionalFiniteNumber(TARGET_CONFIG.gapSignalThresholdMid);
  const gapSignalThresholdLowBase = optionalFiniteNumber(TARGET_CONFIG.gapSignalThresholdLow);

  for (const kLearnRate of [0.05, 0.08, 0.12, 0.18]) {
    for (const biasLearnRate of [0.03, 0.05, 0.08, 0.12]) {
      for (const fxMix of [0.5, 0.7, 0.9, 1.1]) {
        const absLeadSignals = train.map((item) => Math.abs(item.holdingReturn + fxMix * item.fxReturn));
        for (const shockQuantile of [0.8, 0.86, 0.9, 0.94]) {
          for (const shockBaseBlend of [0.3, 0.45, 0.6, 0.75]) {
            for (const normalBaseBlend of [0.65, 0.75, 0.85]) {
              for (const shockAmplify of [0, 0.2, 0.35, 0.5]) {
                for (const arWeight of [0, 0.15, 0.3, 0.45]) {
                  for (const gapCoef of [0.15, 0.35, 0.55]) {
                    for (const upMoveScale of [0.9, 1, 1.1]) {
                      for (const downMoveScale of [0.9, 1, 1.12]) {
                  adaptiveParamGrid.push({
                    kLearnRate,
                    biasLearnRate,
                    fxMix,
                    tradingShockThreshold: quantile(sessionTradingLeadAbs.length ? sessionTradingLeadAbs : fallbackLeadAbs, shockQuantile),
                    offShockThreshold: quantile(sessionOffLeadAbs.length ? sessionOffLeadAbs : fallbackLeadAbs, Math.min(0.96, shockQuantile + 0.04)),
                    shockBaseBlend,
                    tradingBaseBlend: clampRange(normalBaseBlend - 0.06, 0.45, 0.9),
                    offBaseBlend: clampRange(normalBaseBlend + 0.08, 0.45, 0.95),
                    sessionSplit: true,
                    tradingLeadScale: 1.08,
                    offLeadScale: 1.04,
                    upMoveScale,
                    downMoveScale,
                    tradingStaticBias: 0,
                    offStaticBias: 0,
                    shockAmplify,
                    arWeight,
                    gapBranch: true,
                    gapCoef,
                    gapAmplify: 0.35,
                    gapSignalThreshold: Math.max(0.006, quantile(gapAbsSignals, 0.86)),
                    coverageHighThreshold: coverageHighThresholdBase,
                    coverageMidThreshold: coverageMidThresholdBase,
                    highCoverageLeadScale: highCoverageLeadScaleBase,
                    midCoverageLeadScale: midCoverageLeadScaleBase,
                    lowCoverageLeadScale: lowCoverageLeadScaleBase,
                    highCoverageBaseBlendAdjust: highCoverageBaseBlendAdjustBase,
                    midCoverageBaseBlendAdjust: midCoverageBaseBlendAdjustBase,
                    lowCoverageBaseBlendAdjust: lowCoverageBaseBlendAdjustBase,
                    gapCoefHigh: gapCoefHighBase,
                    gapCoefMid: gapCoefMidBase,
                    gapCoefLow: gapCoefLowBase,
                    gapAmplifyHigh: gapAmplifyHighBase,
                    gapAmplifyMid: gapAmplifyMidBase,
                    gapAmplifyLow: gapAmplifyLowBase,
                    gapSignalThresholdHigh: gapSignalThresholdHighBase,
                    gapSignalThresholdMid: gapSignalThresholdMidBase,
                    gapSignalThresholdLow: gapSignalThresholdLowBase,
                    gapBiasLearnRate: 0.08,
                    weekendThreshold: 0.02,
                    weekendAmplify: 0.35,
                    weekendFxCoef: 0.6,
                    extremeThreshold: quantile(absLeadSignals, 0.95),
                    extremeAmplify: 0,
                    minReturn: minReturnCap,
                    maxReturn: maxReturnCap,
                    updateMinMove: 0.001,
                    kMin: 0.25,
                    kMax: 1.8,
                  });
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  let bestAdaptiveTuning = null;
  for (const params of adaptiveParamGrid) {
    const coreResult = evaluateAdaptive(tuningSplit.core, robustWeights, params, { k: 1, b: 0 });
    const tuningResult = evaluateAdaptive(tuningSplit.tuning, robustWeights, params, coreResult.state);
    const tuningErrors = tuningResult.points.map((item) => item.navError);
    const mae = weightedMaeFromPoints(tuningResult.points);
    const mae30 = weightedMae30FromPoints(tuningResult.points);
    const robust30 = robustMae30FromPoints(tuningResult.points);
    const top3 = [...tuningErrors].sort((a, b) => b - a).slice(0, 3);
    const score = mae + 0.9 * mae30 + 1.3 * robust30 + average(top3) * 0.3;

    if (!bestAdaptiveTuning || score < bestAdaptiveTuning.score) {
      bestAdaptiveTuning = { params, score, mae, mae30, robust30 };
    }
  }

  let bestAdaptiveValidation = null;
  for (const params of adaptiveParamGrid) {
    const trainResult = evaluateAdaptive(train, robustWeights, params, { k: 1, b: 0 });
    const validationResult = evaluateAdaptive(validation, robustWeights, params, trainResult.state);
    const trainErrors = trainResult.points.map((item) => item.navError);
    const valErrors = validationResult.points.map((item) => item.navError);
    const mae = weightedMaeFromPoints(validationResult.points);
    const mae30 = weightedMae30FromPoints(validationResult.points);
    const robust30 = robustMae30FromPoints(validationResult.points);
    const trainTop4 = averageTop(trainErrors, 4);
    const valTop3 = averageTop(valErrors, 3);
    const score = mae + 0.85 * mae30 + 1.45 * robust30 + valTop3 * 0.16 + trainTop4 * 0.18;

    if (!bestAdaptiveValidation || score < bestAdaptiveValidation.score) {
      bestAdaptiveValidation = { params, score, mae, mae30, robust30, trainTop4 };
    }
  }

  const refinementSeed = bestAdaptiveValidation?.params || bestAdaptiveTuning?.params;
  let bestAdaptiveRefined = bestAdaptiveValidation;
  if (refinementSeed) {
    const refinedCandidates = [];
    const offLeadScales = [...new Set([
      clampRange(refinementSeed.offLeadScale - 0.1, 0.7, 1.25),
      clampRange(refinementSeed.offLeadScale, 0.7, 1.25),
      clampRange(refinementSeed.offLeadScale + 0.1, 0.7, 1.25),
    ].map((item) => Number(item.toFixed(4))))];
    const offBaseBlends = [...new Set([
      clampRange(refinementSeed.offBaseBlend - 0.08, 0.45, 0.95),
      clampRange(refinementSeed.offBaseBlend, 0.45, 0.95),
      clampRange(refinementSeed.offBaseBlend + 0.08, 0.45, 0.95),
    ].map((item) => Number(item.toFixed(4))))];
    const gapCoefs = [...new Set([
      clampRange(refinementSeed.gapCoef - 0.2, 0, 0.9),
      clampRange(refinementSeed.gapCoef, 0, 0.9),
      clampRange(refinementSeed.gapCoef + 0.2, 0, 0.9),
    ].map((item) => Number(item.toFixed(4))))];
    const weekendThresholds = [0.01, refinementSeed.weekendThreshold, 0.03];
    const weekendAmplifies = [...new Set([
      0,
      clampRange(refinementSeed.weekendAmplify, 0, 1.2),
      clampRange(refinementSeed.weekendAmplify + 0.25, 0, 1.2),
      1.0,
    ].map((item) => Number(item.toFixed(4))))];
    const weekendFxCoefs = [0.4, refinementSeed.weekendFxCoef, 0.8];
    const weekendMomentumCoefs = [0, 0.25, 0.45, 0.7];
    const upMoveScales = [0.9, refinementSeed.upMoveScale ?? 1, 1.12];
    const downMoveScales = [0.9, refinementSeed.downMoveScale ?? 1, 1.15];
    const extremeThresholds = [
      quantile(fallbackLeadAbs, 0.92),
      refinementSeed.extremeThreshold ?? quantile(fallbackLeadAbs, 0.95),
      quantile(fallbackLeadAbs, 0.97),
    ];
    const extremeAmplifies = [0, 0.25, 0.45, 0.7];
    const segmentedVariants = TARGET_CODE === '161226'
      ? [
          {
            lowCoverageLeadScale: clampRange((refinementSeed.lowCoverageLeadScale ?? 0.9) - 0.08, 0.65, 1.1),
            lowCoverageBaseBlendAdjust: clampRange((refinementSeed.lowCoverageBaseBlendAdjust ?? -0.15) - 0.06, -0.35, 0.15),
            gapCoefLow: clampRange((refinementSeed.gapCoefLow ?? refinementSeed.gapCoef ?? 0.55) + 0.14, 0.05, 0.95),
            gapAmplifyLow: clampRange((refinementSeed.gapAmplifyLow ?? refinementSeed.gapAmplify ?? 0.35) + 0.14, 0, 1.1),
          },
          {
            lowCoverageLeadScale: refinementSeed.lowCoverageLeadScale ?? 0.9,
            lowCoverageBaseBlendAdjust: refinementSeed.lowCoverageBaseBlendAdjust ?? -0.15,
            gapCoefLow: refinementSeed.gapCoefLow ?? refinementSeed.gapCoef ?? 0.55,
            gapAmplifyLow: refinementSeed.gapAmplifyLow ?? refinementSeed.gapAmplify ?? 0.35,
          },
          {
            lowCoverageLeadScale: clampRange((refinementSeed.lowCoverageLeadScale ?? 0.9) + 0.05, 0.65, 1.1),
            lowCoverageBaseBlendAdjust: clampRange((refinementSeed.lowCoverageBaseBlendAdjust ?? -0.15) + 0.06, -0.35, 0.15),
            gapCoefLow: clampRange((refinementSeed.gapCoefLow ?? refinementSeed.gapCoef ?? 0.55) - 0.12, 0.05, 0.95),
            gapAmplifyLow: clampRange((refinementSeed.gapAmplifyLow ?? refinementSeed.gapAmplify ?? 0.35) - 0.12, 0, 1.1),
          },
        ]
      : [{}];

    for (const offLeadScale of offLeadScales) {
      for (const offBaseBlend of offBaseBlends) {
        for (const gapCoef of gapCoefs) {
          for (const weekendThreshold of weekendThresholds) {
            for (const weekendAmplify of weekendAmplifies) {
              for (const weekendFxCoef of weekendFxCoefs) {
                for (const weekendMomentumCoef of weekendMomentumCoefs) {
                  for (const upMoveScale of upMoveScales) {
                    for (const downMoveScale of downMoveScales) {
                      for (const extremeThreshold of extremeThresholds) {
                        for (const extremeAmplify of extremeAmplifies) {
                          for (const segmentedVariant of segmentedVariants) {
                            refinedCandidates.push({
                              ...refinementSeed,
                              ...segmentedVariant,
                              offLeadScale,
                              offBaseBlend,
                              gapCoef,
                              weekendThreshold,
                              weekendAmplify,
                              weekendFxCoef,
                              weekendMomentumCoef,
                              upMoveScale,
                              downMoveScale,
                              extremeThreshold,
                              extremeAmplify,
                            });
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }

    for (const params of refinedCandidates) {
      const trainResult = evaluateAdaptive(train, robustWeights, params, { k: 1, b: 0 });
      const validationResult = evaluateAdaptive(validation, robustWeights, params, trainResult.state);
      const trainErrors = trainResult.points.map((item) => item.navError);
      const valErrors = validationResult.points.map((item) => item.navError);
      const mae = weightedMaeFromPoints(validationResult.points);
      const mae30 = weightedMae30FromPoints(validationResult.points);
      const robust30 = robustMae30FromPoints(validationResult.points);
      const trainTop4 = averageTop(trainErrors, 4);
      const valTop3 = averageTop(valErrors, 3);
      const score = mae + 0.78 * mae30 + 1.55 * robust30 + valTop3 * 0.12 + trainTop4 * 0.2;

      if (!bestAdaptiveRefined || score < bestAdaptiveRefined.score) {
        bestAdaptiveRefined = { params, score, mae, mae30, robust30, trainTop4 };
      }
    }
  }

  const adaptiveParams = bestAdaptiveRefined?.params || bestAdaptiveValidation?.params || bestAdaptiveTuning?.params || {
    kLearnRate: 0.08,
    biasLearnRate: 0.05,
    fxMix: 0.7,
    tradingShockThreshold: quantile(sessionTradingLeadAbs.length ? sessionTradingLeadAbs : fallbackLeadAbs, 0.9),
    offShockThreshold: quantile(sessionOffLeadAbs.length ? sessionOffLeadAbs : fallbackLeadAbs, 0.94),
    shockBaseBlend: 0.45,
    tradingBaseBlend: 0.72,
    offBaseBlend: 0.84,
    sessionSplit: true,
    tradingLeadScale: 1.08,
    offLeadScale: 1.04,
    upMoveScale: 1,
    downMoveScale: 1,
    tradingStaticBias: 0,
    offStaticBias: 0,
    shockAmplify: 0.2,
    arWeight: 0.15,
    gapBranch: true,
    gapCoef: 0.35,
    gapAmplify: 0.35,
    gapSignalThreshold: Math.max(0.006, quantile(gapAbsSignals, 0.86)),
    coverageHighThreshold: coverageHighThresholdBase,
    coverageMidThreshold: coverageMidThresholdBase,
    highCoverageLeadScale: highCoverageLeadScaleBase,
    midCoverageLeadScale: midCoverageLeadScaleBase,
    lowCoverageLeadScale: lowCoverageLeadScaleBase,
    highCoverageBaseBlendAdjust: highCoverageBaseBlendAdjustBase,
    midCoverageBaseBlendAdjust: midCoverageBaseBlendAdjustBase,
    lowCoverageBaseBlendAdjust: lowCoverageBaseBlendAdjustBase,
    gapCoefHigh: gapCoefHighBase,
    gapCoefMid: gapCoefMidBase,
    gapCoefLow: gapCoefLowBase,
    gapAmplifyHigh: gapAmplifyHighBase,
    gapAmplifyMid: gapAmplifyMidBase,
    gapAmplifyLow: gapAmplifyLowBase,
    gapSignalThresholdHigh: gapSignalThresholdHighBase,
    gapSignalThresholdMid: gapSignalThresholdMidBase,
    gapSignalThresholdLow: gapSignalThresholdLowBase,
    gapBiasLearnRate: 0.08,
    weekendThreshold: 0.02,
    weekendAmplify: 0.35,
    weekendFxCoef: 0.6,
    weekendMomentumCoef: 0,
    extremeThreshold: quantile(fallbackLeadAbs, 0.95),
    extremeAmplify: 0,
    minReturn: minReturnCap,
    maxReturn: maxReturnCap,
    updateMinMove: 0.001,
    kMin: 0.25,
    kMax: 1.8,
  };

  const segmentedTrainResult = evaluateAdaptive(train, robustWeights, adaptiveParams, { k: 1, b: 0 });
  let segmentedTrain = segmentedTrainResult.points;
  const segmentedValidationResult = evaluateAdaptive(validation, robustWeights, adaptiveParams, segmentedTrainResult.state);
  let segmentedValidation = segmentedValidationResult.points;

  const residualTargets = segmentedTrain.map((item) => item.targetReturn - item.predictedReturn);
  const residualFeatures = segmentedTrain.map((item) => makeResidualFeatures(item));
  const residualSampleWeights = segmentedTrain.map((item) => {
    const hardRegimeBoost = item.isGapDayHint || !item.isOilTradingSession ? 1.8 : 1;
    const tailBoost = Math.abs(item.targetReturn - item.predictedReturn) >= 0.01 ? 1.4 : 1;
    return hardRegimeBoost * tailBoost;
  });
  const residualWeights = fitLinearWeights(residualFeatures, residualTargets, residualSampleWeights, 1.6);
  let bestResidualRefine = null;

  if (residualWeights) {
    for (const shrink of [0, 0.2, 0.35, 0.5, 0.65, 0.8]) {
      for (const cap of [0.008, 0.012, 0.016, 0.022, 0.03]) {
        const trainCorrected = applyResidualCorrection(segmentedTrain, residualWeights, shrink, cap, adaptiveParams.minReturn, adaptiveParams.maxReturn);
        const valCorrected = applyResidualCorrection(segmentedValidation, residualWeights, shrink, cap, adaptiveParams.minReturn, adaptiveParams.maxReturn);
        const trainErrors = trainCorrected.map((item) => item.navError);
        const valErrors = valCorrected.map((item) => item.navError);
        const mae = average(valErrors);
        const mae30 = average(valErrors.slice(-30));
        const robust30 = robustMae30FromPoints(valCorrected);
        const valTop3 = averageTop(valErrors, 3);
        const trainTop4 = averageTop(trainErrors, 4);
        const trainTop8 = averageTop(trainErrors, 8);
        const score = mae + 0.7 * mae30 + 1.8 * robust30 + 0.12 * valTop3 + 0.16 * trainTop4 + 0.08 * trainTop8;

        if (!bestResidualRefine || score < bestResidualRefine.score) {
          bestResidualRefine = {
            score,
            mae,
            mae30,
            robust30,
            trainTop4,
            trainTop8,
            shrink,
            cap,
            trainCorrected,
            valCorrected,
          };
        }
      }
    }
  }

  if (bestResidualRefine && bestResidualRefine.shrink > 0) {
    segmentedTrain = bestResidualRefine.trainCorrected;
    segmentedValidation = bestResidualRefine.valCorrected;
  }

  const topTrainErrors = summarizeTopErrors(segmentedTrain, 10);
  const topValidationErrors = summarizeTopErrors(segmentedValidation, 10);
  const maeBySession = {
    oilTradingSession: average(segmentedValidation.filter((item) => item.isOilTradingSession).map((item) => item.navError)),
    nonTradingSession: average(segmentedValidation.filter((item) => !item.isOilTradingSession).map((item) => item.navError)),
    gapDayHint: average(segmentedValidation.filter((item) => item.isGapDayHint).map((item) => item.navError)),
    nonGapDay: average(segmentedValidation.filter((item) => !item.isGapDayHint).map((item) => item.navError)),
  };

  const lambdaGrid = [0.1, 0.2, 0.35, 0.5, 0.7, 0.9, 1.2];
  let bestDual = null;

  for (const lambda of lambdaGrid) {
    const sampleWeights = train.map((row, index) => {
      const recency = 0.985 ** (train.length - 1 - index);
      return recency * (1 + lambda * Math.max(0.1, row.coverageRatio));
    });

    const makeFeatures = (list) => list.map((item) => [1, item.holdingReturn, item.fxReturn, item.coverageRatio]);
    const makeTargets = (list) => list.map((item) => item.targetReturn);
    const w = fitLinearWeights(makeFeatures(train), makeTargets(train), sampleWeights, 0.4) || [0, 0.85, 0.25, 0];
    const predictor = (row) => w[0] + w[1] * row.holdingReturn + w[2] * row.fxReturn + w[3] * row.coverageRatio;
    const valPoints = evaluate(validation, predictor);
    const navMae = average(valPoints.map((item) => item.navError));
    const premiumProxyMae = average(valPoints.map((item) => item.premiumProxyError));
    const score = navMae + lambda * premiumProxyMae;

    if (!bestDual || score < bestDual.score) {
      bestDual = { lambda, weights: w, score };
    }
  }

  const dualPredictor = (row) => {
    const w = bestDual.weights;
    return w[0] + w[1] * row.holdingReturn + w[2] * row.fxReturn + w[3] * row.coverageRatio;
  };

  const dualTrain = evaluate(train, dualPredictor);
  const dualValidation = evaluate(validation, dualPredictor);

  const mergedSegmented = [...segmentedTrain, ...segmentedValidation];
  const allDates = [...train, ...validation].map((item) => item.date);

  const svg = renderSvg({
    dates: allDates,
    segmentedPoints: mergedSegmented,
    splitDate: validation[0]?.date,
    meta: {
      lambda: bestDual.lambda,
      disclosureCount: disclosures.length,
      avgCoverage: average(rows.map((item) => item.coverageRatio)),
    },
  });

  const summary = {
    code: TARGET_CODE,
    generatedAt: new Date().toISOString(),
    splitMode,
    method: 'history-holdings-daily-return',
    explanation: '旧版离线研究主要基于净值时序特征，并未直接按前十大持仓逐日涨跌幅估值；本版已切换为历史前十大持仓逐日估值。',
    fallbackMode,
    disclosureCount: disclosures.length,
    usedQuoteTickers: [...quoteSeriesByTicker.keys()],
    avgHoldingCoverage: average(rows.map((item) => item.coverageRatio)),
    trainRange: `${train[0]?.date || '--'} ~ ${train[train.length - 1]?.date || '--'}`,
    validationRange: `${validation[0]?.date || '--'} ~ ${validation[validation.length - 1]?.date || '--'}`,
    segmented: {
      maeTrain: average(segmentedTrain.map((item) => item.navError)),
      maeValidation: average(segmentedValidation.map((item) => item.navError)),
      maeValidation30: average(segmentedValidation.slice(-30).map((item) => item.navError)),
      maeValidation30Robust: robustMae30FromPoints(segmentedValidation),
      maeValidationWeighted: weightedMaeFromPoints(segmentedValidation),
      maeValidation30Weighted: weightedMae30FromPoints(segmentedValidation),
    },
    dualObjective: {
      mode: 'holdings-return-plus-fx',
      lambda: bestDual.lambda,
      maeValidation: average(dualValidation.map((item) => item.navError)),
      maeValidation30: average(dualValidation.slice(-30).map((item) => item.navError)),
      premiumProxyValidation: average(dualValidation.map((item) => item.premiumProxyError)),
    },
    adaptiveModel: {
      kLearnRate: adaptiveParams.kLearnRate,
      biasLearnRate: adaptiveParams.biasLearnRate,
      fxMix: adaptiveParams.fxMix,
      tradingShockThreshold: adaptiveParams.tradingShockThreshold,
      offShockThreshold: adaptiveParams.offShockThreshold,
      shockBaseBlend: adaptiveParams.shockBaseBlend,
      tradingBaseBlend: adaptiveParams.tradingBaseBlend,
      offBaseBlend: adaptiveParams.offBaseBlend,
      sessionSplit: adaptiveParams.sessionSplit,
      tradingLeadScale: adaptiveParams.tradingLeadScale,
      offLeadScale: adaptiveParams.offLeadScale,
      upMoveScale: adaptiveParams.upMoveScale,
      downMoveScale: adaptiveParams.downMoveScale,
      shockAmplify: adaptiveParams.shockAmplify,
      arWeight: adaptiveParams.arWeight,
      gapBranch: adaptiveParams.gapBranch,
      gapCoef: adaptiveParams.gapCoef,
      gapAmplify: adaptiveParams.gapAmplify,
      gapSignalThreshold: adaptiveParams.gapSignalThreshold,
      weekendThreshold: adaptiveParams.weekendThreshold,
      weekendAmplify: adaptiveParams.weekendAmplify,
      weekendFxCoef: adaptiveParams.weekendFxCoef,
      weekendMomentumCoef: adaptiveParams.weekendMomentumCoef,
      extremeThreshold: adaptiveParams.extremeThreshold,
      extremeAmplify: adaptiveParams.extremeAmplify,
      tuningMae: bestAdaptiveTuning?.mae ?? Number.NaN,
      tuningMae30: bestAdaptiveTuning?.mae30 ?? Number.NaN,
      tuningMae30Robust: bestAdaptiveTuning?.robust30 ?? Number.NaN,
      validationSelectionMae: bestAdaptiveValidation?.mae ?? Number.NaN,
      validationSelectionMae30: bestAdaptiveValidation?.mae30 ?? Number.NaN,
      validationSelectionMae30Robust: bestAdaptiveValidation?.robust30 ?? Number.NaN,
      validationSelectionTrainTop4: bestAdaptiveValidation?.trainTop4 ?? Number.NaN,
      refinedSelectionMae: bestAdaptiveRefined?.mae ?? Number.NaN,
      refinedSelectionMae30: bestAdaptiveRefined?.mae30 ?? Number.NaN,
      refinedSelectionMae30Robust: bestAdaptiveRefined?.robust30 ?? Number.NaN,
      refinedSelectionTrainTop4: bestAdaptiveRefined?.trainTop4 ?? Number.NaN,
      residualRefineShrink: bestResidualRefine?.shrink ?? 0,
      residualRefineCap: bestResidualRefine?.cap ?? 0,
      residualRefineMae: bestResidualRefine?.mae ?? Number.NaN,
      residualRefineMae30: bestResidualRefine?.mae30 ?? Number.NaN,
      residualRefineMae30Robust: bestResidualRefine?.robust30 ?? Number.NaN,
      residualRefineTrainTop4: bestResidualRefine?.trainTop4 ?? Number.NaN,
      residualRefineTrainTop8: bestResidualRefine?.trainTop8 ?? Number.NaN,
    },
    validationDiagnostics: {
      maeBySession,
      topErrorDays: topValidationErrors,
    },
    trainDiagnostics: {
      topErrorDays: topTrainErrors,
    },
    chartPath: `generated/${TARGET_CODE}-offline-research.svg`,
    notes: `估值点使用同日持仓涨跌幅对齐同日净值，不做时间平移；${TARGET_CODE} 使用“${TARGET_CONFIG.noteLabel}”分参数与“主代理/次代理跳空+汇率错位”缺口日专用分支。若个别持仓缺历史行情，按可用权重归一化。${disclosures.length < 4 ? '季度正文解析不足时按全部季度边界+种子持仓权重回退。' : ''}`,
  };

  if (topValidationErrors.length) {
    console.log(`[offline-research] ${TARGET_CODE} top validation error diagnostics:`);
    for (const item of topValidationErrors.slice(0, 6)) {
      console.log(
        `  ${item.date} err=${(item.absError * 100).toFixed(2)}% tags=${item.tags.join('|') || 'none'} gapSignal=${(item.gapSignal * 100).toFixed(2)}% fx=${(item.fxReturn * 100).toFixed(2)}%`,
      );
    }
  }

  if (topTrainErrors.length) {
    console.log(`[offline-research] ${TARGET_CODE} top train error diagnostics:`);
    for (const item of topTrainErrors.slice(0, 6)) {
      console.log(
        `  ${item.date} err=${(item.absError * 100).toFixed(2)}% tags=${item.tags.join('|') || 'none'} gapSignal=${(item.gapSignal * 100).toFixed(2)}% fx=${(item.fxReturn * 100).toFixed(2)}%`,
      );
    }
  }

  await fs.mkdir(path.dirname(OUT_SVG_PATH), { recursive: true });
  await fs.writeFile(OUT_SVG_PATH, svg, 'utf8');
  await fs.writeFile(OUT_JSON_PATH, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

  console.log(`[offline-research] ${TARGET_CODE} svg generated: ${OUT_SVG_PATH}`);
  console.log(`[offline-research] summary generated: ${OUT_JSON_PATH}`);
}

main().catch((error) => {
  console.error(`[offline-research] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
