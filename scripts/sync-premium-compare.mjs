import fs from 'node:fs/promises';
import path from 'node:path';

const projectRoot = process.cwd();
const runtimePath = path.join(projectRoot, 'public', 'generated', 'funds-runtime.json');
const outputPath = path.join(projectRoot, 'public', 'generated', 'premium-compare.json');
const historyPath = path.join(projectRoot, '.cache', 'fund-sync', 'premium-compare-history.json');
const manualPremiumPath = path.join(projectRoot, 'public', 'generated', 'premium-compare-manual.json');
const localManualPremiumPath = path.join(projectRoot, '.cache', 'fund-sync', 'premium-compare-manual-local.json');

const HISTORY_MAX_ROWS_PER_PROVIDER = 360;
const PROVIDER_DAILY_ROWS_LIMIT = 120;
const SETTLED_WINDOW_SIZE = 30;
const EASTMONEY_QUOTE_RETRY = 3;
const CLOSE_SNAPSHOT_TIME = '15:00:00';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toFiniteNumber(value) {
  if (value === null || value === undefined) {
    return Number.NaN;
  }
  if (typeof value === 'string' && !value.trim()) {
    return Number.NaN;
  }
  const num = Number(value);
  return Number.isFinite(num) ? num : Number.NaN;
}

function pickLatestRowsByDate(rows) {
  const byDate = new Map();

  for (const row of Array.isArray(rows) ? rows : []) {
    const date = String(row?.date || '').trim();
    if (!date) {
      continue;
    }

    const current = byDate.get(date);
    const nextTime = String(row?.time || '');
    const prevTime = String(current?.time || '');
    if (!current || nextTime >= prevTime) {
      byDate.set(date, row);
    }
  }

  return [...byDate.values()].sort((left, right) => String(left?.date || '').localeCompare(String(right?.date || '')));
}

function isTimeOnOrAfter(leftTime, rightTime) {
  const left = toTimeOnly(leftTime);
  const right = toTimeOnly(rightTime);
  if (!left || !right) {
    return false;
  }
  return left >= right;
}

function pickCanonicalRowsByDate(rows, targetTime = CLOSE_SNAPSHOT_TIME) {
  const grouped = new Map();

  for (const row of Array.isArray(rows) ? rows : []) {
    const date = toDateOnly(row?.date);
    const time = toTimeOnly(row?.time);
    if (!date || !time) {
      continue;
    }
    if (!grouped.has(date)) {
      grouped.set(date, []);
    }
    grouped.get(date).push(row);
  }

  const selected = [];
  for (const [date, dateRows] of grouped.entries()) {
    const normalized = sortRowsByDateTime(dateRows);
    let picked = normalized.find((item) => toTimeOnly(item?.time) === targetTime) || null;

    if (!picked) {
      const beforeOrAt = normalized.filter((item) => toTimeOnly(item?.time) <= targetTime);
      if (beforeOrAt.length) {
        picked = beforeOrAt[beforeOrAt.length - 1];
      }
    }

    if (!picked) {
      const after = normalized.filter((item) => toTimeOnly(item?.time) > targetTime);
      if (after.length) {
        picked = after[0];
      }
    }

    if (!picked && normalized.length) {
      picked = normalized[normalized.length - 1];
    }

    if (picked) {
      selected.push(picked);
    }
  }

  return selected.sort((left, right) => String(left?.date || '').localeCompare(String(right?.date || '')));
}

function sortRowsByDateTime(rows) {
  return [...(Array.isArray(rows) ? rows : [])].sort((left, right) => {
    const leftDate = String(left?.date || '');
    const rightDate = String(right?.date || '');
    if (leftDate !== rightDate) {
      return leftDate.localeCompare(rightDate);
    }
    const leftTime = String(left?.time || '');
    const rightTime = String(right?.time || '');
    return leftTime.localeCompare(rightTime);
  });
}

function average(values) {
  if (!values.length) {
    return Number.NaN;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function toDateOnly(value) {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return '';
  }
  return text;
}

function toTimeOnly(value) {
  const text = String(value || '').trim();
  if (!text) {
    return '';
  }
  if (/^\d{2}:\d{2}(:\d{2})?$/.test(text)) {
    return text.length === 5 ? `${text}:00` : text;
  }
  return '';
}

function appendHistoryRow(rows, nextRow) {
  const date = toDateOnly(nextRow?.date);
  const time = toTimeOnly(nextRow?.time);
  const providerPremiumRate = toFiniteNumber(nextRow?.providerPremiumRate);
  if (!date || !Number.isFinite(providerPremiumRate)) {
    return rows;
  }

  const merged = Array.isArray(rows) ? [...rows] : [];
  const key = `${date}|${time}`;
  const index = merged.findIndex((item) => `${toDateOnly(item?.date)}|${toTimeOnly(item?.time)}` === key);
  const normalized = {
    date,
    time,
    marketPrice: toFiniteNumber(nextRow?.marketPrice),
    ourPremiumRate: toFiniteNumber(nextRow?.ourPremiumRate),
    providerPremiumRate,
    sourceUrl: String(nextRow?.sourceUrl || ''),
    status: String(nextRow?.status || ''),
  };

  if (index >= 0) {
    merged[index] = normalized;
  } else {
    merged.push(normalized);
  }

  return merged;
}

function normalizeManualPremiumEntries(payload) {
  const rawList = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.entries)
      ? payload.entries
      : [];

  return rawList
    .map((item) => {
      const code = String(item?.code || '').trim();
      const provider = String(item?.provider || '').trim();
      const date = toDateOnly(item?.date);
      const time = toTimeOnly(item?.time);
      const premiumRate = toFiniteNumber(item?.premiumRate);
      if (!code || !provider || !date || !Number.isFinite(premiumRate)) {
        return null;
      }

      return {
        code,
        provider,
        date,
        time,
        premiumRate,
        marketPrice: toFiniteNumber(item?.marketPrice),
        ourPremiumRate: toFiniteNumber(item?.ourPremiumRate),
        sourceUrl: String(item?.sourceUrl || ''),
        status: String(item?.status || 'manual-input'),
      };
    })
    .filter(Boolean);
}

function toDateTimeLabel(date, time) {
  const left = String(date || '').trim();
  const right = String(time || '').trim();
  return `${left} ${right}`.trim();
}

function toCloseDateTimeLabel(date) {
  const left = String(date || '').trim();
  if (!left) {
    return '';
  }
  return `${left} ${CLOSE_SNAPSHOT_TIME}`;
}

function parsePremiumFromText(text) {
  const input = String(text || '');
  const hit = input.match(/(?:溢价率|折溢价率|premium[^\d-]*)\s*[:：]?\s*(-?\d+(?:\.\d+)?)\s*%/i);
  if (!hit) {
    return Number.NaN;
  }
  const value = Number(hit[1]);
  return Number.isFinite(value) ? value / 100 : Number.NaN;
}

async function safeFetchText(url, referer = '') {
  const response = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0',
      ...(referer ? { referer } : {}),
    },
  });

  if (!response.ok) {
    throw new Error(`http-${response.status}`);
  }

  return response.text();
}

async function safeFetchJsonWithRetry(url, referer = '', attempts = EASTMONEY_QUOTE_RETRY) {
  let lastError = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const raw = await safeFetchText(url, referer);
      return JSON.parse(raw);
    } catch (error) {
      lastError = error;
      if (attempt < attempts - 1) {
        await sleep(180 * (attempt + 1));
      }
    }
  }

  throw lastError || new Error('request-failed');
}

function getSecidByCode(code) {
  return code.startsWith('5') ? `1.${code}` : `0.${code}`;
}

function parseFundGzJsonp(rawText) {
  const text = String(rawText || '').trim();
  const matched = text.match(/^jsonpgz\((\{.*\})\);?$/);
  if (!matched) {
    return null;
  }

  try {
    return JSON.parse(matched[1]);
  } catch {
    return null;
  }
}

async function fetchFromEastmoneyFundgz(code, marketPrice) {
  const apiUrl = `https://fundgz.1234567.com.cn/js/${code}.js`;
  try {
    const raw = await safeFetchText(apiUrl, `https://fund.eastmoney.com/${code}.html`);
    const payload = parseFundGzJsonp(raw);
    const estimatedNav = Number(payload?.gsz);
    if (!Number.isFinite(estimatedNav) || estimatedNav <= 0 || !Number.isFinite(marketPrice) || marketPrice <= 0) {
      return {
        provider: 'eastmoney-fundgz',
        sourceUrl: apiUrl,
        status: 'gsz-unavailable',
        premiumRate: null,
      };
    }

    return {
      provider: 'eastmoney-fundgz',
      sourceUrl: apiUrl,
      status: 'ok',
      premiumRate: marketPrice / estimatedNav - 1,
    };
  } catch (error) {
    return {
      provider: 'eastmoney-fundgz',
      sourceUrl: apiUrl,
      status: error instanceof Error ? error.message : 'request-failed',
      premiumRate: null,
    };
  }
}

async function fetchFromEastmoneyQuotePremium(code) {
  const secidCandidates = [getSecidByCode(code), `1.${code}`, `0.${code}`]
    .filter((item, index, arr) => arr.indexOf(item) === index);

  let lastStatus = 'premium-unavailable';
  let lastUrl = 'https://push2.eastmoney.com/';

  for (const secid of secidCandidates) {
    const referer = `https://quote.eastmoney.com/${secid}.html`;
    const jsonEndpoints = [
      `https://push2.eastmoney.com/api/qt/stock/get?invt=2&fltt=2&secid=${secid}&fields=f57,f58,f193,f194`,
      `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=f57,f58,f193,f194`,
      `https://push2his.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=f57,f58,f193,f194`,
    ];

    for (const apiUrl of jsonEndpoints) {
      lastUrl = apiUrl;
      try {
        const payload = await safeFetchJsonWithRetry(apiUrl, referer);
        const premiumPercent = Number(payload?.data?.f193);
        if (Number.isFinite(premiumPercent)) {
          return {
            provider: 'eastmoney-quote',
            sourceUrl: apiUrl,
            status: 'ok',
            premiumRate: premiumPercent / 100,
          };
        }
        lastStatus = 'premium-unavailable';
      } catch (error) {
        lastStatus = error instanceof Error ? error.message : 'request-failed';
      }
    }

    const htmlEndpoints = [
      `https://quote.eastmoney.com/${secid}.html`,
      `https://fund.eastmoney.com/${code}.html`,
    ];

    for (const pageUrl of htmlEndpoints) {
      lastUrl = pageUrl;
      try {
        const html = await safeFetchText(pageUrl, referer);
        const parsed = parsePremiumFromText(html);
        if (Number.isFinite(parsed)) {
          return {
            provider: 'eastmoney-quote',
            sourceUrl: pageUrl,
            status: 'ok',
            premiumRate: parsed,
          };
        }
        lastStatus = 'premium-unavailable';
      } catch (error) {
        lastStatus = error instanceof Error ? error.message : 'request-failed';
      }
    }
  }

  return {
    provider: 'eastmoney-quote',
    sourceUrl: lastUrl,
    status: lastStatus === 'premium-unavailable' ? 'premium-unavailable' : 'fetch failed',
    premiumRate: null,
  };
}

async function fetchFromEtfpro(code) {
  const candidates = [
    `https://etfpro.cn/${code}`,
    `https://etfpro.cn/fund/${code}`,
    `https://etfpro.cn/?code=${code}`,
  ];

  for (const url of candidates) {
    try {
      const html = await safeFetchText(url, 'https://etfpro.cn/');
      const parsed = parsePremiumFromText(html);
      if (Number.isFinite(parsed)) {
        return {
          provider: 'etfpro',
          sourceUrl: url,
          status: 'ok',
          premiumRate: parsed,
        };
      }
    } catch {
      continue;
    }
  }

  return {
    provider: 'etfpro',
    sourceUrl: 'https://etfpro.cn/',
    status: 'unavailable-or-blocked',
    premiumRate: null,
  };
}

async function fetchFromXueqiu(code) {
  const symbols = [`SZ${code}`, `SH${code}`];
  for (const symbol of symbols) {
    const url = `https://xueqiu.com/S/${symbol}`;
    try {
      const html = await safeFetchText(url, 'https://xueqiu.com/');
      const parsed = parsePremiumFromText(html);
      if (Number.isFinite(parsed)) {
        return {
          provider: 'xueqiu',
          sourceUrl: url,
          status: 'ok',
          premiumRate: parsed,
        };
      }
    } catch {
      continue;
    }
  }

  return {
    provider: 'xueqiu',
    sourceUrl: 'https://xueqiu.com/',
    status: 'unavailable-or-blocked',
    premiumRate: null,
  };
}

async function fetchFromSina(code) {
  const symbol = code.startsWith('5') ? `sh${code}` : `sz${code}`;
  const url = `https://hq.sinajs.cn/list=${symbol}`;
  try {
    const raw = await safeFetchText(url, 'https://finance.sina.com.cn/');
    const parsed = parsePremiumFromText(raw);
    if (Number.isFinite(parsed)) {
      return {
        provider: 'sina',
        sourceUrl: url,
        status: 'ok',
        premiumRate: parsed,
      };
    }

    return {
      provider: 'sina',
      sourceUrl: url,
      status: 'no-premium-field',
      premiumRate: null,
    };
  } catch {
    return {
      provider: 'sina',
      sourceUrl: url,
      status: 'unavailable-or-blocked',
      premiumRate: null,
    };
  }
}

async function readJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const normalized = String(raw).replace(/^\uFEFF/, '');
    return JSON.parse(normalized);
  } catch {
    return fallback;
  }
}

function sanitizeHistory(history) {
  return Object.fromEntries(
    Object.entries(history || {}).map(([code, providerMap]) => [
      code,
      Object.fromEntries(
        Object.entries(providerMap || {}).map(([provider, rows]) => [
          provider,
          sortRowsByDateTime(
            (Array.isArray(rows) ? rows : [])
              .filter((item) => {
                const prem = toFiniteNumber(item?.providerPremiumRate);
                if (!Number.isFinite(prem)) return false;
                if (provider === 'eastmoney-quote' && Math.abs(prem) > 2) return false;
                return true;
              }),
          ).slice(-HISTORY_MAX_ROWS_PER_PROVIDER),
        ]),
      ),
    ]),
  );
}

async function main() {
  const runtime = await readJson(runtimePath, { funds: [], syncedAt: '' });
  const historyRaw = await readJson(historyPath, {});
  const history = sanitizeHistory(historyRaw);
  const manualPremiumRaw = await readJson(manualPremiumPath, { entries: [] });
  const localManualPremiumRaw = await readJson(localManualPremiumPath, { entries: [] });
  const manualPremiumEntries = [
    ...normalizeManualPremiumEntries(manualPremiumRaw),
    ...normalizeManualPremiumEntries(localManualPremiumRaw),
  ];
  const fundByCode = new Map((runtime.funds || []).map((item) => [item.code, item]));
  const stateByCode = runtime?.stateByCode && typeof runtime.stateByCode === 'object' ? runtime.stateByCode : {};

  for (const entry of manualPremiumEntries) {
    if (!history[entry.code]) {
      history[entry.code] = {};
    }
    if (!history[entry.code][entry.provider]) {
      history[entry.code][entry.provider] = [];
    }
    history[entry.code][entry.provider] = appendHistoryRow(history[entry.code][entry.provider], {
      date: entry.date,
      time: entry.time,
      marketPrice: entry.marketPrice,
      ourPremiumRate: entry.ourPremiumRate,
      providerPremiumRate: entry.premiumRate,
      sourceUrl: entry.sourceUrl,
      status: entry.status,
    });
  }

  const codes = [...new Set((runtime.funds || []).map((item) => String(item?.code || '')).filter(Boolean))];
  const outputByCode = {};

  for (const code of codes) {
    const fund = fundByCode.get(code);
    const marketPrice = Number(fund?.marketPrice);
    const officialNav = Number(fund?.officialNavT1);
    const ourPremiumRate = marketPrice > 0 && officialNav > 0 ? marketPrice / officialNav - 1 : Number.NaN;
    const marketDate = String(fund?.marketDate || fund?.navDate || '');
    const marketTime = String(fund?.marketTime || '');

    const providers = await Promise.all([
      fetchFromEastmoneyFundgz(code, marketPrice),
      fetchFromEastmoneyQuotePremium(code),
      fetchFromEtfpro(code),
      fetchFromXueqiu(code),
      fetchFromSina(code),
    ]);
    const marketPriceFallback = Number.isFinite(marketPrice) ? marketPrice : Number.NaN;
    const ourPremiumRateFallback = Number.isFinite(ourPremiumRate) ? ourPremiumRate : Number.NaN;

    for (const provider of providers) {
      if (!Number.isFinite(provider.premiumRate)) {
        continue;
      }
      if (!Number.isFinite(ourPremiumRate) || !marketDate) {
        continue;
      }

      if (!history[code]) {
        history[code] = {};
      }
      if (!history[code][provider.provider]) {
        history[code][provider.provider] = [];
      }

      history[code][provider.provider] = appendHistoryRow(history[code][provider.provider], {
        date: marketDate,
        time: marketTime,
        marketPrice,
        ourPremiumRate,
        providerPremiumRate: provider.premiumRate,
        sourceUrl: provider.sourceUrl,
        status: provider.status,
      });

      if (marketDate && isTimeOnOrAfter(marketTime, CLOSE_SNAPSHOT_TIME)) {
        history[code][provider.provider] = appendHistoryRow(history[code][provider.provider], {
          date: marketDate,
          time: CLOSE_SNAPSHOT_TIME,
          marketPrice,
          ourPremiumRate,
          providerPremiumRate: provider.premiumRate,
          sourceUrl: provider.sourceUrl,
          status: `${provider.status || 'ok'}|close-benchmark`,
        });
      }
    }

    const errorRows = Array.isArray(stateByCode?.[code]?.journal?.errors) ? stateByCode[code].journal.errors : [];
    const actualPremiumByDate = new Map();
    const actualNavByDate = new Map();
    const navHistoryRows = Array.isArray(fund?.navHistory) ? fund.navHistory : [];
    for (const row of navHistoryRows) {
      const date = String(row?.date || '').trim();
      const nav = toFiniteNumber(row?.nav);
      if (date && Number.isFinite(nav) && nav > 0) {
        actualNavByDate.set(date, nav);
      }
    }

    for (const row of errorRows) {
      const date = String(row?.date || '').trim();
      const actualPremium = toFiniteNumber(row?.actualPremiumRate);
      const actualNav = toFiniteNumber(row?.actualNav);
      if (date && Number.isFinite(actualPremium)) {
        actualPremiumByDate.set(date, actualPremium);
      }
      if (date && Number.isFinite(actualNav) && actualNav > 0) {
        actualNavByDate.set(date, actualNav);
      }
    }

    const providerSet = new Set([
      ...providers.map((provider) => provider.provider),
      ...Object.keys(history?.[code] || {}),
    ]);
    const dateMarketSnapshotMap = new Map();
    const dateOurPremiumMap = new Map();
    for (const providerName of providerSet) {
      const providerRows = sortRowsByDateTime(history?.[code]?.[providerName] ?? []);
      for (const row of providerRows) {
        const date = String(row?.date || '').trim();
        if (!date) {
          continue;
        }
        const rowMarketPrice = toFiniteNumber(row?.marketPrice);
        const rowOurPremiumRate = toFiniteNumber(row?.ourPremiumRate);
        if (Number.isFinite(rowMarketPrice)) {
          dateMarketSnapshotMap.set(date, rowMarketPrice);
        }
        if (Number.isFinite(rowOurPremiumRate)) {
          dateOurPremiumMap.set(date, rowOurPremiumRate);
        }
      }
    }

    for (const [date, nav] of actualNavByDate.entries()) {
      if (actualPremiumByDate.has(date)) {
        continue;
      }

      const marketPriceAtDate = toFiniteNumber(dateMarketSnapshotMap.get(date));
      if (!Number.isFinite(marketPriceAtDate) || !(marketPriceAtDate > 0) || !Number.isFinite(nav) || !(nav > 0)) {
        continue;
      }

      actualPremiumByDate.set(date, marketPriceAtDate / nav - 1);
    }

    for (const errorRow of errorRows) {
      const date = String(errorRow?.date || '').trim();
      const estimatedPremiumRate = toFiniteNumber(errorRow?.premiumRate);
      if (date && Number.isFinite(estimatedPremiumRate) && !dateOurPremiumMap.has(date) && actualPremiumByDate.has(date)) {
        dateOurPremiumMap.set(date, estimatedPremiumRate);
      }
    }

    const settledOurRows = [...dateOurPremiumMap.entries()]
      .map(([date, ourReportedPremiumRate]) => {
        const actualPremiumRate = toFiniteNumber(actualPremiumByDate.get(date));
        if (!date || !Number.isFinite(actualPremiumRate) || !Number.isFinite(ourReportedPremiumRate)) {
          return null;
        }
        return {
          date,
          absOurPremiumError: Math.abs(ourReportedPremiumRate - actualPremiumRate),
        };
      })
      .filter(Boolean)
      .slice(-SETTLED_WINDOW_SIZE);

    const ourPremiumSummary = {
      settledCount30: settledOurRows.length,
      settledWindowSize: SETTLED_WINDOW_SIZE,
      avgAbsOurError30: Number.isFinite(average(settledOurRows.map((item) => item.absOurPremiumError)))
        ? average(settledOurRows.map((item) => item.absOurPremiumError))
        : null,
    };

    const providerStats = [...providerSet].map((providerName) => {
      const runtimeProvider = providers.find((item) => item.provider === providerName) || null;
      const providerHistoryRows = pickCanonicalRowsByDate(history?.[code]?.[providerName] ?? []);
      const hitRows60 = providerHistoryRows.slice(-60);
      const latestHistoryRows = sortRowsByDateTime(history?.[code]?.[providerName] ?? []);
      const latestHistoryRow = latestHistoryRows.length ? latestHistoryRows[latestHistoryRows.length - 1] : null;
      const dailyRows = providerHistoryRows
        .map((row) => {
          const date = String(row?.date || '').trim();
          const time = String(row?.time || '').trim();
          const marketPriceAtSnapshot = toFiniteNumber(row?.marketPrice);
          const actualPremiumRate = toFiniteNumber(actualPremiumByDate.get(date));
          const providerPremiumRate = toFiniteNumber(row?.providerPremiumRate);
          const ourReportedPremiumRate = toFiniteNumber(row?.ourPremiumRate);

          if (!date || !Number.isFinite(providerPremiumRate)) {
            return null;
          }

          const marketPriceResolved = Number.isFinite(marketPriceAtSnapshot)
            ? marketPriceAtSnapshot
            : (Number.isFinite(toFiniteNumber(dateMarketSnapshotMap.get(date)))
              ? toFiniteNumber(dateMarketSnapshotMap.get(date))
              : (date === marketDate && Number.isFinite(marketPriceFallback) ? marketPriceFallback : Number.NaN));
          const ourReportedPremiumResolved = Number.isFinite(ourReportedPremiumRate)
            ? ourReportedPremiumRate
            : (Number.isFinite(toFiniteNumber(dateOurPremiumMap.get(date)))
              ? toFiniteNumber(dateOurPremiumMap.get(date))
              : (date === marketDate && Number.isFinite(ourPremiumRateFallback) ? ourPremiumRateFallback : Number.NaN));

          const isSettled = Number.isFinite(actualPremiumRate);
          const providerPremiumError = isSettled ? providerPremiumRate - actualPremiumRate : Number.NaN;
          const ourPremiumError = isSettled && Number.isFinite(ourReportedPremiumResolved) ? ourReportedPremiumResolved - actualPremiumRate : Number.NaN;
          const premiumErrorDelta = Number.isFinite(providerPremiumError) && Number.isFinite(ourPremiumError)
            ? providerPremiumError - ourPremiumError
            : Number.NaN;

          return {
            date,
            time,
            marketPrice: Number.isFinite(marketPriceResolved) ? marketPriceResolved : null,
            providerPremiumRate,
            ourReportedPremiumRate: Number.isFinite(ourReportedPremiumResolved) ? ourReportedPremiumResolved : null,
            actualPremiumRate: isSettled ? actualPremiumRate : null,
            status: isSettled ? 'settled' : 'pending',
            providerPremiumError: Number.isFinite(providerPremiumError) ? providerPremiumError : null,
            absProviderPremiumError: Math.abs(providerPremiumError),
            ourPremiumError: Number.isFinite(ourPremiumError) ? ourPremiumError : null,
            absOurPremiumError: Number.isFinite(ourPremiumError) ? Math.abs(ourPremiumError) : null,
            premiumErrorDelta: Number.isFinite(premiumErrorDelta) ? premiumErrorDelta : null,
            absDelta: Number.isFinite(ourPremiumError) ? Math.abs(providerPremiumError) - Math.abs(ourPremiumError) : null,
          };
        })
        .filter(Boolean);

      const settledRows = dailyRows.filter((item) => item.status === 'settled');
      const last30SettledRows = settledRows.slice(-SETTLED_WINDOW_SIZE);

      const providerMae30 = average(last30SettledRows.map((item) => item.absProviderPremiumError));
      const ourMae30 = average(last30SettledRows.map((item) => item.absOurPremiumError).filter((item) => Number.isFinite(item)));
      const deltaMae30 = Number.isFinite(providerMae30) && Number.isFinite(ourMae30) ? providerMae30 - ourMae30 : Number.NaN;
      const latestPremiumRate = toFiniteNumber(latestHistoryRow?.providerPremiumRate);

      return {
        provider: providerName,
        sourceUrl: runtimeProvider?.sourceUrl || String(latestHistoryRow?.sourceUrl || ''),
        status: runtimeProvider?.status || String(latestHistoryRow?.status || (latestHistoryRow ? 'manual-only' : 'unavailable')),
        premiumRateCurrent: Number.isFinite(toFiniteNumber(runtimeProvider?.premiumRate))
          ? toFiniteNumber(runtimeProvider?.premiumRate)
          : (Number.isFinite(latestPremiumRate) ? latestPremiumRate : null),
        hitCount60: hitRows60.length,
        avgAbsProviderError30: Number.isFinite(providerMae30) ? providerMae30 : null,
        avgAbsOurError30: Number.isFinite(ourMae30) ? ourMae30 : null,
        avgAbsDelta30: Number.isFinite(deltaMae30) ? deltaMae30 : null,
        settledCount30: last30SettledRows.length,
        sampleCount30: last30SettledRows.length,
        settledWindowSize: SETTLED_WINDOW_SIZE,
      };
    }).sort((left, right) => String(left.provider).localeCompare(String(right.provider)));

    const providerDailyComparisons = Object.fromEntries(
      [...providerSet].map((providerName) => {
        const providerHistoryRows = pickCanonicalRowsByDate(history?.[code]?.[providerName] ?? []);
        const rows = providerHistoryRows
          .map((row) => {
            const date = String(row?.date || '').trim();
            const time = String(row?.time || '').trim();
            const marketPriceAtSnapshot = toFiniteNumber(row?.marketPrice);
            const providerPremiumRate = toFiniteNumber(row?.providerPremiumRate);
            const ourReportedPremiumRate = toFiniteNumber(row?.ourPremiumRate);
            if (!date || !Number.isFinite(providerPremiumRate)) {
              return null;
            }

            const marketPriceResolved = Number.isFinite(marketPriceAtSnapshot)
              ? marketPriceAtSnapshot
              : (Number.isFinite(toFiniteNumber(dateMarketSnapshotMap.get(date)))
                ? toFiniteNumber(dateMarketSnapshotMap.get(date))
                : (date === marketDate && Number.isFinite(marketPriceFallback) ? marketPriceFallback : Number.NaN));
            const ourReportedPremiumResolved = Number.isFinite(ourReportedPremiumRate)
              ? ourReportedPremiumRate
              : (Number.isFinite(toFiniteNumber(dateOurPremiumMap.get(date)))
                ? toFiniteNumber(dateOurPremiumMap.get(date))
                : (date === marketDate && Number.isFinite(ourPremiumRateFallback) ? ourPremiumRateFallback : Number.NaN));

            const actualPremiumRate = toFiniteNumber(actualPremiumByDate.get(date));
            const isSettled = Number.isFinite(actualPremiumRate);
            const providerPremiumError = isSettled ? providerPremiumRate - actualPremiumRate : Number.NaN;
            const ourPremiumError = isSettled && Number.isFinite(ourReportedPremiumResolved) ? ourReportedPremiumResolved - actualPremiumRate : Number.NaN;
            const premiumErrorDelta = Number.isFinite(providerPremiumError) && Number.isFinite(ourPremiumError)
              ? providerPremiumError - ourPremiumError
              : Number.NaN;

            return {
              date,
              time,
              marketPrice: Number.isFinite(marketPriceResolved) ? marketPriceResolved : null,
              providerPremiumRate,
              ourReportedPremiumRate: Number.isFinite(ourReportedPremiumResolved) ? ourReportedPremiumResolved : null,
              status: isSettled ? 'settled' : 'pending',
              actualPremiumRate: isSettled ? actualPremiumRate : null,
              providerPremiumError: Number.isFinite(providerPremiumError) ? providerPremiumError : null,
              ourPremiumError: Number.isFinite(ourPremiumError) ? ourPremiumError : null,
              premiumErrorDelta: Number.isFinite(premiumErrorDelta) ? premiumErrorDelta : null,
            };
          })
          .filter(Boolean);

        const settledRows = rows.filter((item) => item.status === 'settled');
        const pendingRows = rows.filter((item) => item.status !== 'settled');
        const keptSettledRows = settledRows.slice(-SETTLED_WINDOW_SIZE);
        const keptRows = sortRowsByDateTime([...keptSettledRows, ...pendingRows]).slice(-PROVIDER_DAILY_ROWS_LIMIT);

        return [providerName, keptRows];
      }),
    );

    const eastmoneyHistoryRows = pickCanonicalRowsByDate(history?.[code]?.['eastmoney-fundgz'] ?? []);
    const eastmoneyDailyValuations = eastmoneyHistoryRows
      .map((row) => {
        const date = String(row?.date || '').trim();
        const time = String(row?.time || '').trim();
        const marketPriceAtSnapshot = toFiniteNumber(row?.marketPrice);
        const providerPremiumRate = toFiniteNumber(row?.providerPremiumRate);
        const ourReportedPremiumRate = toFiniteNumber(row?.ourPremiumRate);
        if (!date || !Number.isFinite(providerPremiumRate) || !Number.isFinite(marketPriceAtSnapshot) || marketPriceAtSnapshot <= 0) {
          return null;
        }

        const providerEstimatedNav = 1 + providerPremiumRate !== 0 ? marketPriceAtSnapshot / (1 + providerPremiumRate) : Number.NaN;
        const ourEstimatedNav = Number.isFinite(ourReportedPremiumRate) && 1 + ourReportedPremiumRate !== 0
          ? marketPriceAtSnapshot / (1 + ourReportedPremiumRate)
          : Number.NaN;
        const actualNav = toFiniteNumber(actualNavByDate.get(date));
        const providerNavError = Number.isFinite(actualNav) && actualNav > 0 && Number.isFinite(providerEstimatedNav)
          ? providerEstimatedNav / actualNav - 1
          : Number.NaN;
        const ourNavError = Number.isFinite(actualNav) && actualNav > 0 && Number.isFinite(ourEstimatedNav)
          ? ourEstimatedNav / actualNav - 1
          : Number.NaN;
        const status = Number.isFinite(actualNav) && actualNav > 0 ? 'settled' : 'pending';

        return {
          date,
          time,
          marketPrice: marketPriceAtSnapshot,
          providerPremiumRate,
          providerEstimatedNav: Number.isFinite(providerEstimatedNav) ? providerEstimatedNav : null,
          status,
          actualNav: Number.isFinite(actualNav) && actualNav > 0 ? actualNav : null,
          providerNavError: Number.isFinite(providerNavError) ? providerNavError : null,
          ourReportedPremiumRate: Number.isFinite(ourReportedPremiumRate) ? ourReportedPremiumRate : null,
          ourEstimatedNav: Number.isFinite(ourEstimatedNav) ? ourEstimatedNav : null,
          ourNavError: Number.isFinite(ourNavError) ? ourNavError : null,
        };
      })
      .filter(Boolean)
      .slice(-60);

    outputByCode[code] = {
      code,
      name: String(fund?.name || code),
      snapshotAt: toCloseDateTimeLabel(marketDate),
      snapshotAtLive: toDateTimeLabel(marketDate, marketTime),
      ourPremiumRate: Number.isFinite(ourPremiumRate) ? ourPremiumRate : null,
      ourPremiumSummary,
      eastmoneyDailyValuations,
      providerDailyComparisons,
      providers: providerStats,
    };
  }

  const sanitized = sanitizeHistory(history);
  await fs.mkdir(path.dirname(historyPath), { recursive: true });
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(historyPath, `${JSON.stringify(sanitized, null, 2)}\n`, 'utf8');
  await fs.writeFile(outputPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), syncedAt: runtime.syncedAt || '', codes: outputByCode }, null, 2)}\n`, 'utf8');

  if (manualPremiumEntries.length) {
    console.log(`[sync:premium-compare] merged manual entries: ${manualPremiumEntries.length}`);
  }
  console.log(`[sync:premium-compare] generated ${outputPath}`);
}

main().catch((error) => {
  console.error(`[sync:premium-compare] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
