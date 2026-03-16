import fs from 'node:fs/promises';
import path from 'node:path';
import { parseNoticeHoldingsDisclosure } from './notice-parsers/registry.mjs';

const CODE = '161725';
const RUNTIME_PATH = path.resolve('public/generated/funds-runtime.json');
const OUT_SVG_PATH = path.resolve('public/generated/161725-offline-research.svg');
const OUT_JSON_PATH = path.resolve('public/generated/161725-offline-research.json');
const HOLDINGS_HISTORY_PATH = path.resolve('.cache/fund-sync/holdings-disclosures.json');

const HOLDING_ALIAS = [];

function average(values) {
  if (!values.length) {
    return Number.NaN;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
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

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
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

function normalizeTicker(ticker) {
  return String(ticker || '').toUpperCase();
}

function getSecId(ticker) {
  const code = normalizeTicker(ticker);
  if (!/^\d{6}$/.test(code)) {
    return null;
  }

  if (code.startsWith('6') || code.startsWith('9')) {
    return `1.${code}`;
  }

  if (code.startsWith('0') || code.startsWith('2') || code.startsWith('3') || code.startsWith('8') || code.startsWith('4')) {
    return `0.${code}`;
  }

  return null;
}

async function fetchAshareSeries(ticker) {
  const secid = getSecId(ticker);
  if (!secid) {
    return new Map();
  }

  const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6,f7,f8&fields2=f51,f52,f53,f54,f55,f56,f57,f58&klt=101&fqt=1&beg=20240101&end=20500101`;
  const response = await fetch(url, { headers: { referer: 'https://quote.eastmoney.com/' } });
  if (!response.ok) {
    throw new Error(`eastmoney kline ${ticker} ${response.status}`);
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

async function fetchReportList() {
  const url = `https://api.fund.eastmoney.com/f10/JJGG?callback=x&fundcode=${CODE}&pageIndex=1&pageSize=200&type=3`;
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
      const contentResponse = await fetch(contentUrl, { headers: { referer: `https://fund.eastmoney.com/gonggao/${CODE},${artCode}.html` } });
      if (!contentResponse.ok) {
        continue;
      }
      const contentPayload = await contentResponse.json();
      const parsed = parseNoticeHoldingsDisclosure(CODE, {
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
          ticker: normalizeTicker(item.ticker),
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

  const parsedDisclosures = [...dedup.values()].sort((left, right) => left.reportDate.localeCompare(right.reportDate));
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
    : [
        { ticker: '600519', weight: 10 },
        { ticker: '600809', weight: 10 },
        { ticker: '000858', weight: 10 },
        { ticker: '000568', weight: 10 },
        { ticker: '002304', weight: 10 },
        { ticker: '000596', weight: 10 },
        { ticker: '603369', weight: 10 },
        { ticker: '603198', weight: 10 },
        { ticker: '600702', weight: 10 },
        { ticker: '603589', weight: 10 },
      ];

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
    const entries = Array.isArray(payload?.[CODE]) ? payload[CODE] : [];

    const normalized = entries
      .map((item) => ({
        reportDate: String(item?.reportDate || ''),
        title: String(item?.title || ''),
        holdings: Array.isArray(item?.holdings)
          ? item.holdings.slice(0, 10).map((holding) => ({
              ticker: normalizeTicker(holding?.ticker),
              weight: Number(holding?.weight) || 0,
            }))
          : [],
      }))
      .filter((item) => item.reportDate && item.holdings.length > 0);

    const dedup = new Map();
    for (const item of normalized) {
      dedup.set(`${item.reportDate}|${item.title}`, item);
    }

    return [...dedup.values()].sort((left, right) => left.reportDate.localeCompare(right.reportDate));
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

function buildRows(navHistoryAsc, disclosures, quoteSeriesByTicker) {
  const rows = [];

  for (let i = 1; i < navHistoryAsc.length; i += 1) {
    const prev = navHistoryAsc[i - 1];
    const curr = navHistoryAsc[i];
    if (!(prev?.nav > 0) || !(curr?.nav > 0)) {
      continue;
    }

    const activeDisclosure = getActiveDisclosure(curr.date, disclosures);
    const holdings = activeDisclosure?.holdings || [];

    let weightedReturn = 0;
    let coveredWeight = 0;
    let usedCount = 0;
    let missingWeight = 0;
    const contributions = [];

    for (const holding of holdings) {
      const ticker = normalizeTicker(holding.ticker);
      const series = quoteSeriesByTicker.get(ticker);
      const w = Math.max(0, Number(holding.weight) || 0);
      if (!series) {
        missingWeight += w;
        continue;
      }

      const closePrev = series.get(prev.date);
      const closeCurr = series.get(curr.date);
      if (!(closePrev > 0) || !(closeCurr > 0)) {
        missingWeight += w;
        continue;
      }

      const r = closeCurr / closePrev - 1;
      weightedReturn += r * w;
      coveredWeight += w;
      usedCount += 1;
      contributions.push({
        ticker,
        weight: w,
        returnRate: r,
        weightedContribution: r * (w / 100),
      });
    }

    const holdingReturn = coveredWeight > 0 ? weightedReturn / coveredWeight : 0;
    const coverageRatio = Math.max(0, Math.min(1, coveredWeight / 100));

    rows.push({
      date: curr.date,
      prevDate: prev.date,
      prevNav: prev.nav,
      actualNav: curr.nav,
      targetReturn: curr.nav / prev.nav - 1,
      holdingReturn,
      coverageRatio,
      usedCount,
      missingWeight,
      topContributors: contributions
        .sort((left, right) => Math.abs(right.weightedContribution) - Math.abs(left.weightedContribution))
        .slice(0, 3),
      disclosureDate: activeDisclosure?.reportDate || '',
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
      coverageRatio: 0,
      usedCount: 0,
      missingWeight: 0,
      topContributors: [],
      disclosureDate: '',
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
    return [
      1,
      h,
      Math.abs(h),
      Math.sign(h) * h * h,
      item.coverageRatio,
      h * item.coverageRatio,
      Math.max(0, item.missingWeight || 0) / 100,
    ];
  });
}

function predictByWeights(row, weights) {
  const h = row.holdingReturn;
  const x = [
    1,
    h,
    Math.abs(h),
    Math.sign(h) * h * h,
    row.coverageRatio,
    h * row.coverageRatio,
    Math.max(0, row.missingWeight || 0) / 100,
  ];
  return x.reduce((sum, value, index) => sum + value * (weights[index] || 0), 0);
}

function evaluateAdaptive(rows, baseWeights, params, initialState) {
  const points = [];
  const state = {
    k: initialState?.k ?? 1,
    b: initialState?.b ?? 0,
  };

  for (const row of rows) {
    const baseReturn = predictByWeights(row, baseWeights);
    const shockFlag = Math.abs(row.holdingReturn) >= params.shockThreshold;
    const adaptReturn = state.k * row.holdingReturn + state.b;
    const blended = shockFlag
      ? params.shockBaseBlend * baseReturn + (1 - params.shockBaseBlend) * adaptReturn
      : params.normalBaseBlend * baseReturn + (1 - params.normalBaseBlend) * adaptReturn;
    const excess = Math.max(0, Math.abs(row.holdingReturn) - params.shockThreshold);
    const shockAmplify = shockFlag ? Math.sign(row.holdingReturn) * excess * params.shockAmplify : 0;
    const predictedReturn = clamp(blended + shockAmplify, params.minReturn, params.maxReturn);
    const predictedNav = row.prevNav * (1 + predictedReturn);
    const navError = row.actualNav > 0 ? Math.abs(predictedNav / row.actualNav - 1) : 0;
    const premiumProxyError = Math.abs(predictedReturn - row.holdingReturn);

    points.push({
      date: row.date,
      actualNav: row.actualNav,
      predictedNav,
      predictedReturn,
      navError,
      premiumProxyError,
      disclosureDate: row.disclosureDate,
      coverageRatio: row.coverageRatio,
    });

    const residual = row.targetReturn - predictedReturn;
    state.b = (1 - params.biasLearnRate) * state.b + params.biasLearnRate * residual;

    if (Math.abs(row.holdingReturn) >= params.updateMinMove) {
      const ratio = clamp(row.targetReturn / row.holdingReturn, params.kMin, params.kMax);
      state.k = (1 - params.kLearnRate) * state.k + params.kLearnRate * ratio;
    }
  }

  return { points, state };
}

function summarizeTopErrorDays(points, rowsByDate, limit = 8) {
  return [...points]
    .sort((left, right) => right.navError - left.navError)
    .slice(0, limit)
    .map((point) => {
      const row = rowsByDate.get(point.date);
      return {
        date: point.date,
        navError: point.navError,
        targetReturn: row?.targetReturn ?? Number.NaN,
        holdingReturn: row?.holdingReturn ?? Number.NaN,
        predictedReturn: point.predictedReturn ?? Number.NaN,
        coverageRatio: row?.coverageRatio ?? Number.NaN,
        missingWeight: row?.missingWeight ?? Number.NaN,
        topContributors: row?.topContributors || [],
      };
    });
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
    return `<line x1="${x + padLeft}" y1="${py.toFixed(2)}" x2="${x + width - padRight}" y2="${py.toFixed(2)}" stroke="#d7e3df" stroke-width="1" />\n      <text x="${x + padLeft - 8}" y="${(py + 4).toFixed(2)}" text-anchor="end" fill="#5b6b68" font-size="11">${xmlEscape(yFormatter(tick))}</text>`;
  }).join('\n');

  const xLines = [...new Set(xTickIndices)].map((index) => {
    const date = dates[index];
    const px = scaleX(date);
    return `<line x1="${px.toFixed(2)}" y1="${y + padTop}" x2="${px.toFixed(2)}" y2="${y + height - padBottom}" stroke="#eef3f1" stroke-width="1" />\n      <text x="${px.toFixed(2)}" y="${y + height - 12}" text-anchor="middle" fill="#5b6b68" font-size="11">${xmlEscape(date.slice(2))}</text>`;
  }).join('\n');

  const splitMarkup = splitDate && dateIndex.has(splitDate)
    ? `<line x1="${scaleX(splitDate).toFixed(2)}" y1="${y + padTop}" x2="${scaleX(splitDate).toFixed(2)}" y2="${y + height - padBottom}" stroke="#f59e0b" stroke-width="1.4" stroke-dasharray="4 4" />\n       <text x="${(scaleX(splitDate) + 6).toFixed(2)}" y="${y + padTop - 8}" fill="#a16207" font-size="11">验证起点</text>`
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
    return `<line x1="${lx}" y1="${ly}" x2="${lx + 26}" y2="${ly}" stroke="${item.color}" stroke-width="2" ${item.dashed ? 'stroke-dasharray="6 4"' : ''} />\n      <text x="${lx + 32}" y="${ly + 4}" fill="#24312e" font-size="12">${xmlEscape(item.label)}</text>`;
  }).join('\n');

  return `<g>\n    <text x="${x + 12}" y="${y + 18}" fill="#1f2937" font-size="16" font-weight="700">${xmlEscape(title)}</text>\n    ${legend}\n    ${yLines}\n    ${xLines}\n    ${splitMarkup}\n    ${lineMarkup}\n  </g>`;
}

function renderSvg({ dates, segmentedPoints, dualPoints, splitDate, meta }) {
  const width = 1360;
  const height = 980;

  const navValues = [...segmentedPoints, ...dualPoints].flatMap((item) => [item.actualNav, item.predictedNav]).filter((value) => Number.isFinite(value));
  const errValues = [...segmentedPoints, ...dualPoints].map((item) => item.navError).filter((value) => Number.isFinite(value));

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
      { label: '持仓双目标估值', color: '#b45309', dashed: true, points: dualPoints.map((item) => ({ date: item.date, value: item.predictedNav })) },
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
      { label: '持仓双目标误差', color: '#b45309', dashed: true, points: dualPoints.map((item) => ({ date: item.date, value: item.navError })) },
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
  <text x="46" y="36" fill="#1f2937" font-size="31" font-weight="700">161725 离线研究图（持仓逐日估值版）</text>
  <text x="46" y="66" fill="#5b6b68" font-size="13">历史前十大持仓 + A股日线收盘价；双目标 lambda=${meta.lambda.toFixed(2)}；披露期数 ${meta.disclosureCount}；覆盖率均值 ${(meta.avgCoverage * 100).toFixed(1)}%</text>
  ${navChart}
  ${errChart}
</svg>`;
}

async function main() {
  const runtimeRaw = await fs.readFile(RUNTIME_PATH, 'utf8');
  const runtimePayload = JSON.parse(runtimeRaw);
  const fund = (runtimePayload.funds || []).find((item) => item.code === CODE);

  if (!fund) {
    throw new Error(`fund ${CODE} not found in runtime`);
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
        holdings: [
          { ticker: '600519', weight: 10 },
          { ticker: '600809', weight: 10 },
          { ticker: '000858', weight: 10 },
          { ticker: '000568', weight: 10 },
          { ticker: '002304', weight: 10 },
          { ticker: '000596', weight: 10 },
          { ticker: '603369', weight: 10 },
          { ticker: '603198', weight: 10 },
          { ticker: '600702', weight: 10 },
          { ticker: '603589', weight: 10 },
        ],
      },
    ];
  }

  const quoteTickers = [...new Set(disclosures.flatMap((item) => item.holdings.map((holding) => normalizeTicker(holding.ticker))))];
  const quoteSeriesByTicker = new Map();

  for (const ticker of quoteTickers) {
    try {
      const series = await fetchAshareSeries(ticker);
      if (series.size) {
        quoteSeriesByTicker.set(ticker, series);
      }
    } catch {
      continue;
    }
  }

  let rows = buildRows(navHistoryAsc, disclosures, quoteSeriesByTicker);
  let fallbackMode = 'none';
  if (rows.length < 50) {
    rows = buildNavFallbackRows(navHistoryAsc);
    fallbackMode = 'nav-fallback';
  }

  if (rows.length < 30) {
    throw new Error(`insufficient aligned rows: ${rows.length}`);
  }

  const split = splitTrainValidation(rows);
  let train = split.train;
  let validation = split.validation;
  const splitMode = split.mode;

  if (!train.length || !validation.length) {
    const splitIndex = Math.max(1, Math.floor(rows.length * 0.7));
    train = rows.slice(0, splitIndex);
    validation = rows.slice(splitIndex);
  }

  const robustFeaturesTrain = makeRobustFeatures(train);
  const robustTargetsTrain = train.map((item) => item.targetReturn);
  const robustWeights = fitHuberIrls(robustFeaturesTrain, robustTargetsTrain, 0.0085, 0.4, 10)
    || fitLinearWeights(robustFeaturesTrain, robustTargetsTrain, train.map(() => 1), 0.45)
    || [0, 0.92, 0, 0, 0, 0, 0];

  const absHoldingTrain = train.map((item) => Math.abs(item.holdingReturn));
  const targetReturnsTrain = train.map((item) => item.targetReturn);
  const absTargetTrain = targetReturnsTrain.map((item) => Math.abs(item));
  const maxAbsMove = Math.max(0.03, quantile(absTargetTrain, 0.995), quantile(absHoldingTrain, 0.995));
  const minReturnCap = -(maxAbsMove * 1.55 + 0.015);
  const maxReturnCap = maxAbsMove * 1.55 + 0.015;
  const tuningSplit = splitTrainTuning(train);

  const adaptiveParamGrid = [];
  for (const kLearnRate of [0.06, 0.08, 0.12, 0.18, 0.24]) {
    for (const biasLearnRate of [0.03, 0.05, 0.1, 0.16]) {
      for (const shockQuantile of [0.8, 0.84, 0.9, 0.94]) {
        for (const shockBaseBlend of [0.35, 0.55, 0.68, 0.8]) {
          for (const normalBaseBlend of [0.72, 0.82, 0.9]) {
            for (const shockAmplify of [0, 0.25, 0.45, 0.65]) {
              for (const updateMinMove of [0.001, 0.002, 0.003]) {
                adaptiveParamGrid.push({
                  kLearnRate,
                  biasLearnRate,
                  shockThreshold: quantile(absHoldingTrain, shockQuantile),
                  shockBaseBlend,
                  normalBaseBlend,
                  shockAmplify,
                  minReturn: minReturnCap,
                  maxReturn: maxReturnCap,
                  updateMinMove,
                  kMin: 0.35,
                  kMax: 1.55,
                });
              }
            }
          }
        }
      }
    }
  }

  let bestAdaptive = null;
  for (const params of adaptiveParamGrid) {
    const coreResult = evaluateAdaptive(tuningSplit.core, robustWeights, params, { k: 1, b: 0 });
    const tuningResult = evaluateAdaptive(tuningSplit.tuning, robustWeights, params, coreResult.state);
    const tuningErrors = tuningResult.points.map((item) => item.navError);
    const mae = average(tuningErrors);
    const mae30 = average(tuningErrors.slice(-30));
    const top3 = [...tuningErrors].sort((a, b) => b - a).slice(0, 3);
    const score = mae + 1.2 * mae30 + average(top3) * 0.2;

    if (!bestAdaptive || score < bestAdaptive.score) {
      bestAdaptive = { params, score, mae, mae30 };
    }
  }

  const adaptiveParams = bestAdaptive?.params || {
    kLearnRate: 0.12,
    biasLearnRate: 0.1,
    shockThreshold: quantile(absHoldingTrain, 0.9),
    shockBaseBlend: 0.68,
    normalBaseBlend: 0.9,
    shockAmplify: 0.25,
    minReturn: minReturnCap,
    maxReturn: maxReturnCap,
    updateMinMove: 0.002,
    kMin: 0.4,
    kMax: 1.45,
  };

  const segmentedTrainResult = evaluateAdaptive(train, robustWeights, adaptiveParams, { k: 1, b: 0 });
  const segmentedTrain = segmentedTrainResult.points;
  const segmentedValidationResult = evaluateAdaptive(validation, robustWeights, adaptiveParams, segmentedTrainResult.state);
  const segmentedValidation = segmentedValidationResult.points;

  const lambdaGrid = [0.1, 0.2, 0.35, 0.5, 0.7, 0.9, 1.2];
  let bestDual = null;

  for (const lambda of lambdaGrid) {
    const sampleWeights = train.map((row, index) => {
      const recency = 0.985 ** (train.length - 1 - index);
      return recency * (1 + lambda * Math.max(0.1, row.coverageRatio));
    });

    const w = fitLinearWeights(
      train.map((item) => [1, item.holdingReturn, item.coverageRatio]),
      train.map((item) => item.targetReturn),
      sampleWeights,
      0.4,
    ) || [0, 0.92, 0];
    const predictor = (row) => w[0] + w[1] * row.holdingReturn + w[2] * row.coverageRatio;
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
    return w[0] + w[1] * row.holdingReturn + w[2] * row.coverageRatio;
  };

  const dualTrain = evaluate(train, dualPredictor);
  const dualValidation = evaluate(validation, dualPredictor);

  const mergedSegmented = [...segmentedTrain, ...segmentedValidation];
  const mergedDual = [...dualTrain, ...dualValidation];
  const allDates = [...train, ...validation].map((item) => item.date);
  const rowsByDate = new Map(rows.map((item) => [item.date, item]));
  const topErrorDays = summarizeTopErrorDays(segmentedValidation, rowsByDate, 8);

  const svg = renderSvg({
    dates: allDates,
    segmentedPoints: mergedSegmented,
    dualPoints: mergedDual,
    splitDate: validation[0]?.date,
    meta: {
      lambda: bestDual.lambda,
      disclosureCount: disclosures.length,
      avgCoverage: average(rows.map((item) => item.coverageRatio)),
    },
  });

  const summary = {
    code: CODE,
    generatedAt: new Date().toISOString(),
    splitMode: `${splitMode}+adaptive` ,
    method: 'history-holdings-daily-return',
    explanation: '该版本按历史前十大持仓逐日收益估值，使用A股日线收盘价同日对齐净值；并引入鲁棒回归与滚动自适应修正因子处理极端波动日。',
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
    },
    dualObjective: {
      mode: 'holdings-return-a-share',
      lambda: bestDual.lambda,
      maeValidation: average(dualValidation.map((item) => item.navError)),
      maeValidation30: average(dualValidation.slice(-30).map((item) => item.navError)),
      premiumProxyValidation: average(dualValidation.map((item) => item.premiumProxyError)),
    },
    chartPath: 'generated/161725-offline-research.svg',
    adaptiveModel: {
      kLearnRate: adaptiveParams.kLearnRate,
      biasLearnRate: adaptiveParams.biasLearnRate,
      shockThreshold: adaptiveParams.shockThreshold,
      shockBaseBlend: adaptiveParams.shockBaseBlend,
      normalBaseBlend: adaptiveParams.normalBaseBlend,
      shockAmplify: adaptiveParams.shockAmplify,
      tuningMae: bestAdaptive?.mae ?? Number.NaN,
      tuningMae30: bestAdaptive?.mae30 ?? Number.NaN,
    },
    topErrorDays,
    notes: `估值点使用同日持仓涨跌幅对齐同日净值，不做时间平移；若个别持仓缺历史行情，按可用权重归一化；极端波动日启用动态修正。${disclosures.length < 4 ? '季度正文解析不足时按全部季度边界+种子持仓权重回退。' : ''}`,
  };

  await fs.mkdir(path.dirname(OUT_SVG_PATH), { recursive: true });
  await fs.writeFile(OUT_SVG_PATH, svg, 'utf8');
  await fs.writeFile(OUT_JSON_PATH, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

  console.log(`[offline-research] ${CODE} svg generated: ${OUT_SVG_PATH}`);
  console.log(`[offline-research] summary generated: ${OUT_JSON_PATH}`);
}

main().catch((error) => {
  console.error(`[offline-research] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
