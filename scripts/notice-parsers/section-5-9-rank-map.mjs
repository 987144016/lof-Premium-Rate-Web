import {
  normalizeNoticeTextLines,
  parseCnReportDate,
  parseNumber,
} from './shared.mjs';

const RANK_HOLDING_MAP = {
  '160719': {
    1: { ticker: 'GLD', name: 'SPDR Gold Shares ETF' },
    2: { ticker: 'SGOL', name: 'Physical Gold Shares ETF' },
    3: { ticker: 'IAU', name: 'iShares Gold Trust' },
    // 该基金季报原文第4-6行在网页文本中存在字段折叠，先用稳定占位ticker保留行信息。
    4: { ticker: 'SWISSCANTO_GOLD', name: 'Swisscanto CH Gold ETF' },
    5: { ticker: 'ETF_SECURITIES_GOLD', name: 'ETF Securities Gold ETF' },
    6: { ticker: 'ISHARES_GOLD_CH', name: 'iShares Gold ETF CH' },
  },
  '160723': {
    1: { ticker: 'USO', name: 'United States Oil Fund LP' },
    2: { ticker: 'WTI_ETC', name: 'WisdomTree WTI Crude Oil' },
    3: { ticker: 'SIMPLEX_WTI', name: 'Simplex WTI ETF' },
    4: { ticker: 'BRENT_ETC', name: 'WisdomTree Brent Crude Oil' },
    5: { ticker: 'BNO', name: 'Brent Oil Fund LP' },
    6: { ticker: '1699', name: 'NEXT FUNDS NOMURA Crude Oil Long Index Linked ETF' },
    7: { ticker: 'BRENT_BBG_ETC', name: 'WisdomTree Bloomberg Brent Crude Oil' },
  },
  '501018': {
    1: { ticker: 'BRENT_ETC', name: 'WisdomTree Brent Crude Oil ETF' },
    2: { ticker: 'WTI_ETC', name: 'WisdomTree WTI Crude Oil ETF' },
    3: { ticker: 'USO', name: 'United States Oil Fund LP' },
    4: { ticker: '1699', name: 'NEXT FUNDS NOMURA Crude Oil Long Index Linked ETF' },
    5: { ticker: 'SIMPLEX_WTI', name: 'Simplex WTI ETF' },
    6: { ticker: 'BNO', name: 'United States Brent Oil Fund LP' },
    7: { ticker: 'UBS_CMCI_OIL', name: 'UBS CMCI Oil SF ETF' },
  },
};

export function parseNoticeHoldingsBySection59RankMap({ code, noticeTitle, noticeContent, quoteByTicker }) {
  const rankMap = RANK_HOLDING_MAP[code];
  if (!rankMap) {
    return {
      disclosedHoldingsTitle: '',
      disclosedHoldingsReportDate: '',
      disclosedHoldings: [],
    };
  }

  const sectionMatch = String(noticeContent || '').match(/5\.9\b([\s\S]*?)5\.10\b/);
  if (!sectionMatch) {
    return {
      disclosedHoldingsTitle: '',
      disclosedHoldingsReportDate: '',
      disclosedHoldings: [],
    };
  }

  const holdings = normalizeNoticeTextLines(sectionMatch[1])
    .map((line) => line.match(/^(\d{1,2})\s+(.+?)\s+([\d,]+\.\d{2})\s*(\d+\.\d{2})$/))
    .filter(Boolean)
    .map((match) => {
      const rank = Number(match[1]);
      const resolved = rankMap[rank];
      if (!resolved) {
        return null;
      }

      const quote = quoteByTicker.get(resolved.ticker.toUpperCase());
      return {
        rank,
        ticker: resolved.ticker,
        name: resolved.name,
        marketValue: parseNumber(match[3]),
        weight: parseNumber(match[4]),
        currentPrice: quote?.currentPrice,
        changeRate: quote?.changeRate,
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.rank - right.rank)
    .map(({ rank, ...item }) => item);

  const titleMatch = String(noticeTitle || '').match(/(\d{4}年第[1-4]季度)报告/);

  return {
    disclosedHoldingsTitle: titleMatch ? `${titleMatch[1]}前十名基金投资明细` : noticeTitle || '',
    disclosedHoldingsReportDate: parseCnReportDate(noticeContent),
    disclosedHoldings: holdings,
  };
}