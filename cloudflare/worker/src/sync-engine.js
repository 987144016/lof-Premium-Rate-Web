/**
 * 数据同步引擎 - 使用与本地 sync-funds.mjs 相同的数据源
 * 腾讯行情(qt.gtimg.cn) + 新浪汇率 + 天天基金净值
 */

const FUND_CATALOG = {
  '160723': { name: '嘉实原油', benchmark: '原油', type: 'qdii-lof', proxyTickers: ['USO', 'BNO'], sinaPrefix: 'sh' },
  '501018': { name: '南方原油', benchmark: '原油', type: 'qdii-lof', proxyTickers: ['USO', 'BNO'], sinaPrefix: 'sh' },
  '161129': { name: '易方达原油', benchmark: '原油', type: 'qdii-lof', proxyTickers: ['USO', 'BNO'], sinaPrefix: 'sz' },
  '160416': { name: '华安石油', benchmark: '油气', type: 'qdii-lof', proxyTickers: ['XOP', 'XLE'], sinaPrefix: 'sh' },
  '162719': { name: '广发道琼斯石油', benchmark: '油气', type: 'qdii-lof', proxyTickers: ['XOP', 'XLE'], sinaPrefix: 'sz' },
  '162411': { name: '华宝油气', benchmark: '油气', type: 'qdii-lof', proxyTickers: ['XOP', 'XLE'], sinaPrefix: 'sz' },
  '163208': { name: '诺安油气', benchmark: '油气', type: 'qdii-lof', proxyTickers: ['XLE', 'SLB'], sinaPrefix: 'sz' },
  '160216': { name: '国泰黄金', benchmark: '黄金', type: 'qdii-lof', proxyTickers: ['GLD', 'IAU'], sinaPrefix: 'sh' },
  '160719': { name: '嘉实黄金', benchmark: '黄金', type: 'qdii-lof', proxyTickers: ['GLD', 'IAU'], sinaPrefix: 'sh' },
  '161116': { name: '易方达黄金', benchmark: '黄金', type: 'qdii-lof', proxyTickers: ['GLD', 'UGL'], sinaPrefix: 'sz' },
  '164701': { name: '汇添富黄金', benchmark: '黄金', type: 'qdii-lof', proxyTickers: ['GLD', 'IAU'], sinaPrefix: 'sz' },
  '159518': { name: '华夏原油', benchmark: '原油', type: 'qdii-etf', proxyTickers: ['USO', 'BNO'], sinaPrefix: 'sz' },
};

const PROXY_BASKET_WEIGHTS = {
  '原油': { USO: 0.6, BNO: 0.4 },
  '黄金': { GLD: 0.7, IAU: 0.3 },
  '油气': { XOP: 0.5, XLE: 0.5 },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 腾讯行情 - 批量获取场内基金价格
 * 格式: qt.gtimg.cn/q=sh160723,sh501018,...
 * 返回: Map<code, { marketPrice, previousClose, name }>
 */
async function fetchFundQuotesBatch(codes) {
  const result = new Map();
  try {
    const symbols = codes.map(code => {
      const cfg = FUND_CATALOG[code];
      return `${cfg?.sinaPrefix || 'sh'}${code}`;
    }).join(',');
    const url = `https://qt.gtimg.cn/q=${symbols}`;
    const res = await fetchWithTimeout(url, {
      headers: { Referer: 'https://gu.qq.com/', 'User-Agent': UA },
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    // 腾讯行情返回 GBK，Worker 环境用 TextDecoder 解码
    const buf = await res.arrayBuffer();
    const text = new TextDecoder('gbk').decode(buf);
    // 格式: v_sh160723="1~嘉实原油~160723~99.31~99.31~..."
    for (const line of text.split(';')) {
      const m = line.match(/v_[a-z]{2}(\d{6})="([^"]+)"/);
      if (!m) continue;
      const code = m[1];
      const parts = m[2].split('~');
      const marketPrice = parseFloat(parts[3]) || 0;
      const previousClose = parseFloat(parts[4]) || 0;
      const name = parts[1] || '';
      result.set(code, { marketPrice, previousClose, name });
    }
  } catch (e) {
    console.warn(`[tencent-quote] batch failed: ${e.message}`);
  }
  return result;
}

/**
 * 腾讯行情 - 批量获取美股代理 ETF
 * 格式: qt.gtimg.cn/q=usUSO,usBNO,...
 */
async function fetchUSQuotesBatch(tickers) {
  const result = new Map();
  try {
    const unique = [...new Set(tickers)];
    const symbols = unique.map(t => `us${t}`).join(',');
    const url = `https://qt.gtimg.cn/q=${symbols}`;
    const res = await fetchWithTimeout(url, {
      headers: { Referer: 'https://gu.qq.com/', 'User-Agent': UA },
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const buf = await res.arrayBuffer();
    const text = new TextDecoder('gbk').decode(buf);
    // 格式: v_usUSO="1~USO~...~currentPrice~...~previousClose~..."
    for (const line of text.split(';')) {
      const m = line.match(/v_us([A-Z]+)="([^"]+)"/);
      if (!m) continue;
      const ticker = m[1];
      const parts = m[2].split('~');
      // 腾讯美股字段: [0]类型 [1]名称 [2]代码 [3]当前价 [4]涨跌额 [5]涨跌% [6]成交量 [7]成交额 [8]昨收 ...
      const currentPrice = parseFloat(parts[3]) || 0;
      const previousClose = parseFloat(parts[8]) || parseFloat(parts[3]) || 0;
      result.set(ticker, { ticker, currentPrice, previousClose });
    }
  } catch (e) {
    console.warn(`[tencent-us] batch failed: ${e.message}`);
  }
  return result;
}

/**
 * 新浪财经 - 获取 USD/CNY 汇率
 */
async function fetchUsdCny() {
  try {
    const res = await fetchWithTimeout(
      'https://hq.sinajs.cn/list=USDCNY,fx_susdcny',
      { headers: { Referer: 'https://finance.sina.com.cn/', 'User-Agent': UA } }
    );
    if (!res.ok) throw new Error(`status ${res.status}`);
    const buf = await res.arrayBuffer();
    const text = new TextDecoder('gbk').decode(buf);
    // 取第一个有效汇率
    const m = text.match(/"([67]\.\d+)/);
    if (m) return parseFloat(m[1]);
  } catch (e) {
    console.warn(`[sina-fx] ${e.message}`);
  }
  // 兜底: frankfurter.app
  try {
    const res = await fetchWithTimeout('https://api.frankfurter.app/latest?from=USD&to=CNY');
    if (res.ok) {
      const d = await res.json();
      if (d?.rates?.CNY > 5) return d.rates.CNY;
    }
  } catch { /* ignore */ }
  return 7.25;
}

/**
 * 天天基金 - 获取最新官方净值（历史净值接口，非交易时段也有数据）
 */
async function fetchOfficialNav(code) {
  try {
    const url = `https://api.fund.eastmoney.com/f10/lsjz?callback=x&fundCode=${code}&pageIndex=1&pageSize=1&startDate=&endDate=`;
    const res = await fetchWithTimeout(url, {
      headers: { Referer: 'https://fundf10.eastmoney.com/', 'User-Agent': UA },
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const text = await res.text();
    const m = text.match(/x\((\{.*\})\)/s);
    if (!m) throw new Error('no callback');
    const data = JSON.parse(m[1]);
    const row = data?.Data?.LSJZList?.[0];
    if (!row) throw new Error('no data');
    return {
      officialNavT1: parseFloat(row.DWJZ) || 0,
      navDate: (row.FSRQ || '').slice(0, 10),
    };
  } catch (e) {
    console.warn(`[eastmoney-nav] ${code}: ${e.message}`);
    return null;
  }
}

/**
 * 天天基金 - 实时估值（交易时段）
 */
async function fetchEstimatedNav(code) {
  try {
    const url = `http://fundgz.1234567.com.cn/js/${code}.js?rt=${Date.now()}`;
    const res = await fetchWithTimeout(url, {
      headers: { Referer: 'http://fund.eastmoney.com/', 'User-Agent': UA },
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const text = await res.text();
    const m = text.match(/jsonpgz\((\{.*?\})\)/);
    if (!m) return null;
    const d = JSON.parse(m[1]);
    const estimatedNav = parseFloat(d.gsz) || 0;
    if (estimatedNav <= 0) return null;
    return {
      estimatedNav,
      estimatedNavChangeRate: parseFloat(d.gszzl) / 100 || 0,
      estimateTime: d.gztime || '',
      // fundgz 也带昨日净值，可作为补充
      officialNavT1FromGz: parseFloat(d.dwjz) || 0,
      navDateFromGz: (d.jzrq || '').slice(0, 10),
    };
  } catch (e) {
    console.warn(`[eastmoney-gz] ${code}: ${e.message}`);
    return null;
  }
}

function calcProxyReturn(benchmark, quotesMap) {
  const weights = PROXY_BASKET_WEIGHTS[benchmark];
  if (!weights) return { proxyReturn: 0, proxyQuotes: [] };
  let totalReturn = 0, totalWeight = 0;
  const proxyQuotes = [];
  for (const [ticker, weight] of Object.entries(weights)) {
    const q = quotesMap.get(ticker);
    const currentPrice = q?.currentPrice || 0;
    const previousClose = q?.previousClose || 0;
    const changeRate = previousClose > 0 ? currentPrice / previousClose - 1 : 0;
    proxyQuotes.push({ ticker, weight, currentPrice, previousClose, changeRate });
    if (previousClose > 0) { totalReturn += changeRate * weight; totalWeight += weight; }
  }
  return {
    proxyReturn: totalWeight > 0 ? totalReturn / totalWeight : 0,
    proxyQuotes,
  };
}

async function syncSingleFund(code, config, fundQuotesMap, usQuotesMap, fxRate) {
  // 并发获取净值数据
  const [navData, gzData] = await Promise.all([
    fetchOfficialNav(code),
    fetchEstimatedNav(code),
  ]);

  const officialNavT1 = navData?.officialNavT1 || gzData?.officialNavT1FromGz || 0;
  const navDate = navData?.navDate || gzData?.navDateFromGz || '';
  const estimatedNav = gzData?.estimatedNav || 0;
  const estimatedNavChangeRate = gzData?.estimatedNavChangeRate || 0;

  const quote = fundQuotesMap.get(code);
  const marketPrice = quote?.marketPrice || 0;
  const previousClose = quote?.previousClose || officialNavT1 || 0;
  const name = quote?.name || config.name;

  const { proxyReturn, proxyQuotes } = calcProxyReturn(config.benchmark, usQuotesMap);
  const effectiveEstimatedNav = estimatedNav || (officialNavT1 > 0 ? officialNavT1 * (1 + proxyReturn) : 0);
  const premiumRate = effectiveEstimatedNav > 0 && marketPrice > 0 ? marketPrice / effectiveEstimatedNav - 1 : null;

  return {
    code,
    name,
    benchmark: config.benchmark,
    pageCategory: config.type,
    fundType: config.type.includes('etf') ? 'ETF' : 'LOF',
    estimateMode: 'proxy',

    officialNavT1,
    navDate,
    estimatedNav: effectiveEstimatedNav,
    estimatedNavChangeRate: estimatedNavChangeRate || proxyReturn,
    navHistory: [],
    disclosedHoldings: [],
    holdingQuotes: [],

    marketPrice,
    previousClose,
    marketDate: new Date().toISOString().slice(0, 10),
    marketTime: new Date().toISOString().slice(11, 19),

    premiumRate,

    proxyBasketName: config.benchmark,
    proxyQuotes,
    proxyQuoteDate: new Date().toISOString().slice(0, 10),
    proxyQuoteTime: new Date().toISOString().slice(11, 19),

    fx: { pair: 'USD/CNY', currentRate: fxRate, previousCloseRate: fxRate },
    updatedAt: new Date().toISOString(),
  };
}

export async function syncAllFunds(db, options = {}) {
  const force = options.force || false;
  const startTime = Date.now();

  if (!force) {
    const lastSync = await db.prepare('SELECT synced_at FROM runtime_runs ORDER BY id DESC LIMIT 1').first();
    if (lastSync?.synced_at) {
      const elapsed = (startTime - new Date(lastSync.synced_at).getTime()) / 60000;
      if (elapsed < 5) return { ok: true, skipped: true, reason: 'Too soon', lastSyncAt: lastSync.synced_at };
    }
  }

  try {
    const codes = Object.keys(FUND_CATALOG);
    const allUsTickers = [...new Set(Object.values(FUND_CATALOG).flatMap(c => c.proxyTickers || []))];

    // 并发抓取：场内行情 + 美股行情 + 汇率
    const [fundQuotesMap, usQuotesMap, fxRate] = await Promise.all([
      fetchFundQuotesBatch(codes),
      fetchUSQuotesBatch(allUsTickers),
      fetchUsdCny(),
    ]);

    console.log(`[SyncEngine] fund quotes: ${fundQuotesMap.size}, US quotes: ${usQuotesMap.size}, USD/CNY: ${fxRate}`);

    // 逐个同步（净值接口串行，避免限流）
    const funds = [];
    for (const [code, config] of Object.entries(FUND_CATALOG)) {
      const fundData = await syncSingleFund(code, config, fundQuotesMap, usQuotesMap, fxRate);
      if (fundData) funds.push(fundData);
      await new Promise(r => setTimeout(r, 100));
    }

    if (!funds.length) throw new Error('No funds synced');

    const syncedAt = new Date().toISOString();
    const stmts = [
      db.prepare('INSERT INTO runtime_runs (synced_at, fund_count, source_url) VALUES (?, ?, ?)')
        .bind(syncedAt, funds.length, 'sync-engine-auto'),
    ];
    for (const fund of funds) {
      stmts.push(
        db.prepare(
          `INSERT INTO latest_fund_runtime (code, synced_at, runtime_json)
           VALUES (?, ?, ?)
           ON CONFLICT(code) DO UPDATE SET synced_at=excluded.synced_at, runtime_json=excluded.runtime_json`
        ).bind(fund.code, syncedAt, JSON.stringify(fund))
      );
    }
    await db.batch(stmts);

    const duration = Date.now() - startTime;
    console.log(`[SyncEngine] Done: ${funds.length} funds in ${duration}ms`);
    return { ok: true, skipped: false, syncedAt, fundCount: funds.length, duration, funds: funds.map(f => f.code) };
  } catch (error) {
    console.error('[SyncEngine] Failed:', error);
    return { ok: false, error: error.message, duration: Date.now() - startTime };
  }
}

export async function getAllFunds(db) {
  const result = await db.prepare('SELECT code, runtime_json FROM latest_fund_runtime ORDER BY code').all();
  return (result.results || []).map(row => {
    try { return JSON.parse(row.runtime_json); } catch { return null; }
  }).filter(Boolean);
}

export async function getFundByCode(db, code) {
  const row = await db.prepare('SELECT code, synced_at, runtime_json FROM latest_fund_runtime WHERE code = ?').bind(code).first();
  if (!row) return null;
  try {
    const fund = JSON.parse(row.runtime_json);
    fund.syncedAt = row.synced_at;
    return fund;
  } catch { return null; }
}
