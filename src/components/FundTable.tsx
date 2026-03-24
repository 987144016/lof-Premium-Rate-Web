import { useEffect, useMemo, useRef, useState } from 'react';
import type { FundViewModel } from '../types';
import { readFundSortPreference, writeFundSortPreference } from '../lib/storage';
import fundShortNameMap from '../data/fund-short-names.json';

type SortKey = 'manual' | 'code' | 'premiumRate' | 'estimatedNav' | 'marketPrice' | 'officialNavT1' | 'meanAbsError' | 'latestError' | 'error30d' | 'changeRate';
const VALID_SORT_KEYS: SortKey[] = ['manual', 'code', 'premiumRate', 'estimatedNav', 'marketPrice', 'officialNavT1', 'meanAbsError', 'latestError', 'error30d', 'changeRate'];

interface FundTableProps {
  funds: FundViewModel[];
  trainingMetricsByCode: Record<string, { maeValidation30: number }>;
  eastmoneyPremiumByCode: Record<string, number | null>;
  formatCurrency: (value: number) => string;
  formatPercent: (value: number) => string;
  title: string;
  description: string;
  pagePath: string;
  favoriteCodes: string[];
  onToggleFavorite: (code: string) => void;
  onReorder: (orderedCodes: string[]) => void;
}

export function FundTable({
  funds,
  trainingMetricsByCode,
  eastmoneyPremiumByCode,
  formatCurrency,
  formatPercent,
  title,
  description,
  pagePath,
  favoriteCodes,
  onToggleFavorite,
  onReorder,
}: FundTableProps) {
    const SORT_LABEL_HINTS: Partial<Record<SortKey, string>> = {
      premiumRate: '场内交易价相对当日预估净值的偏离幅度。正数表示场内价高于预估净值（溢价），负数表示低于预估净值（折价）。',
      marketPrice: '场内实时价格。',
      estimatedNav: '当日净值的估值。',
      officialNavT1: 'T-N 的官方净值（按交易日口径，不含周末/节假日）。N 根据基金类别与披露节奏确定：国内 LOF 常见 T-1/T-2，QDII/黄金常见 T-2/T-3。',
      meanAbsError: '离线训练验证集近30天 MAE（鲁棒口径：剔除最近30天最大单日误差后计算）。反映模型在"排除历史异常后"的可靠性，越低越好。',
      latestError: '线上最近一个已结算交易日的估值误差（估值相对后续真实净值的偏离）。单日波动较大，需配合 30d 指标看整体效果。',
      error30d: '线上最近30个交易日平均绝对误差（滚动均值）。反映近期模型稳定性表现，更平滑更有参考价值。',
    };

  const [sortKey, setSortKey] = useState<SortKey>(() => {
    const saved = readFundSortPreference();
    if (!saved) {
      return 'manual';
    }
    return VALID_SORT_KEYS.includes(saved.sortKey as SortKey) ? (saved.sortKey as SortKey) : 'manual';
  });
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>(() => {
    const saved = readFundSortPreference();
    return saved?.sortDirection === 'asc' ? 'asc' : 'desc';
  });
  const tableRef = useRef<HTMLTableElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [floatingHeaderState, setFloatingHeaderState] = useState({
    visible: false,
    left: 0,
    width: 0,
    scrollLeft: 0,
  });
  const favoriteSet = useMemo(() => new Set(favoriteCodes), [favoriteCodes]);
  const [draggingCode, setDraggingCode] = useState<string | null>(null);

  const sortedFunds = useMemo(() => {
    if (sortKey === 'manual') {
      return funds;
    }

    const next = [...funds];
    next.sort((left, right) => {
      const multiplier = sortDirection === 'asc' ? 1 : -1;

      if (sortKey === 'code') {
        return multiplier * left.runtime.code.localeCompare(right.runtime.code, 'zh-CN');
      }

      const leftValue =
        sortKey === 'premiumRate'
          ? normalizeSortableNumber(left.estimate.premiumRate, Number.NEGATIVE_INFINITY)
          : sortKey === 'meanAbsError'
            ? getTrainingValidation30Error(left, trainingMetricsByCode) ?? Number.POSITIVE_INFINITY
          : sortKey === 'latestError'
            ? getLatestError(left) ?? Number.NEGATIVE_INFINITY
            : sortKey === 'error30d'
              ? getRecent30DayAvgAbsError(left) ?? Number.POSITIVE_INFINITY
          : sortKey === 'changeRate'
            ? getChangeRate(left.runtime.marketPrice, left.runtime.previousClose)
          : sortKey === 'estimatedNav'
            ? left.estimate.estimatedNav
            : sortKey === 'marketPrice'
              ? left.runtime.marketPrice
              : sortKey === 'officialNavT1'
                ? left.runtime.officialNavT1
                : Number.POSITIVE_INFINITY;
      const rightValue =
        sortKey === 'premiumRate'
          ? normalizeSortableNumber(right.estimate.premiumRate, Number.NEGATIVE_INFINITY)
          : sortKey === 'meanAbsError'
            ? getTrainingValidation30Error(right, trainingMetricsByCode) ?? Number.POSITIVE_INFINITY
          : sortKey === 'latestError'
            ? getLatestError(right) ?? Number.NEGATIVE_INFINITY
            : sortKey === 'error30d'
              ? getRecent30DayAvgAbsError(right) ?? Number.POSITIVE_INFINITY
          : sortKey === 'changeRate'
            ? getChangeRate(right.runtime.marketPrice, right.runtime.previousClose)
          : sortKey === 'estimatedNav'
            ? right.estimate.estimatedNav
            : sortKey === 'marketPrice'
              ? right.runtime.marketPrice
              : sortKey === 'officialNavT1'
                ? right.runtime.officialNavT1
                : Number.POSITIVE_INFINITY;

      return multiplier * (leftValue - rightValue);
    });

    return next;
  }, [funds, sortDirection, sortKey, trainingMetricsByCode]);

  const toggleSort = (nextKey: SortKey) => {
    if (sortKey === nextKey) {
      setSortDirection((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(nextKey);
      setSortDirection(nextKey === 'code' ? 'asc' : 'desc');
    }
  };

  useEffect(() => {
    writeFundSortPreference({ sortKey, sortDirection });
  }, [sortKey, sortDirection]);

  useEffect(() => {
    const updateFloatingHeader = () => {
      if (window.innerWidth <= 720 || !tableRef.current || !scrollRef.current) {
        setFloatingHeaderState((current) => (current.visible
          ? {
            ...current,
            visible: false,
            left: 0,
            width: 0,
          }
          : current));
        return;
      }

      const tableRect = tableRef.current.getBoundingClientRect();
      const scrollRect = scrollRef.current.getBoundingClientRect();
      const shouldShow = tableRect.top < 0 && tableRect.bottom > 72;

      setFloatingHeaderState((current) => ({
        ...current,
        visible: shouldShow,
        left: scrollRect.left,
        width: scrollRect.width,
      }));
    };

    const syncScroll = () => {
      const left = scrollRef.current?.scrollLeft || 0;
      setFloatingHeaderState((current) => (current.scrollLeft === left
        ? current
        : {
          ...current,
          scrollLeft: left,
        }));
    };

    updateFloatingHeader();
    syncScroll();

    window.addEventListener('scroll', updateFloatingHeader, { passive: true });
    window.addEventListener('resize', updateFloatingHeader);
    scrollRef.current?.addEventListener('scroll', syncScroll, { passive: true });

    return () => {
      window.removeEventListener('scroll', updateFloatingHeader);
      window.removeEventListener('resize', updateFloatingHeader);
      scrollRef.current?.removeEventListener('scroll', syncScroll);
    };
  }, [funds.length]);

  const handleRowDrop = (targetCode: string) => {
    if (!draggingCode || draggingCode === targetCode) {
      return;
    }

    const displayCodes = sortedFunds.map((item) => item.runtime.code);
    const dragIndex = displayCodes.indexOf(draggingCode);
    const targetIndex = displayCodes.indexOf(targetCode);
    if (dragIndex < 0 || targetIndex < 0) {
      setDraggingCode(null);
      return;
    }

    const next = [...displayCodes];
    const [moved] = next.splice(dragIndex, 1);
    next.splice(targetIndex, 0, moved);
    onReorder(next);
    setSortKey('manual');
    setDraggingCode(null);
  };

  const handleRowDragStart = (event: React.DragEvent<HTMLTableRowElement>, code: string) => {
    setDraggingCode(code);
    event.dataTransfer.effectAllowed = 'move';
    // Some browsers require setting data to activate DnD.
    event.dataTransfer.setData('text/plain', code);
  };

  const handleRowDragEnd = () => {
    setDraggingCode(null);
  };

  const renderSortLabel = (label: string, key: SortKey) => {
    const active = sortKey === key;
    const suffix = active ? (sortDirection === 'desc' ? ' ↓' : ' ↑') : '';

    return (
      <button
        className={`table-sort-button${active ? ' table-sort-button--active' : ''}`}
        type="button"
        onClick={() => toggleSort(key)}
        title={SORT_LABEL_HINTS[key] || label}
      >
        {label}
        {suffix}
      </button>
    );
  };

  const renderFloatingHeaderLabel = (label: string, key?: SortKey) => {
    if (!key || sortKey !== key) {
      return label;
    }
    return `${label}${sortDirection === 'desc' ? ' ↓' : ' ↑'}`;
  };

  const renderHeaderCells = (sortable: boolean) => (
    <>
      <div>收藏</div>
      <div>{sortable ? renderSortLabel('代码', 'code') : renderFloatingHeaderLabel('代码', 'code')}</div>
      <div>名称</div>
      <div>东财估值溢价</div>
      <div>{sortable ? renderSortLabel('溢价率', 'premiumRate') : renderFloatingHeaderLabel('溢价率', 'premiumRate')}</div>
      <div>限购</div>
      <div>{sortable ? renderSortLabel('涨跌幅', 'changeRate') : renderFloatingHeaderLabel('涨跌幅', 'changeRate')}</div>
      <div>{sortable ? renderSortLabel('最近误差', 'latestError') : renderFloatingHeaderLabel('最近误差', 'latestError')}</div>
      <div>{sortable ? renderSortLabel('30d误差', 'error30d') : renderFloatingHeaderLabel('30d误差', 'error30d')}</div>
      <div>{sortable ? renderSortLabel('训练误差', 'meanAbsError') : renderFloatingHeaderLabel('训练误差', 'meanAbsError')}</div>
      <div>{sortable ? renderSortLabel('现价', 'marketPrice') : renderFloatingHeaderLabel('现价', 'marketPrice')}</div>
      <div>{sortable ? renderSortLabel('估值', 'estimatedNav') : renderFloatingHeaderLabel('估值', 'estimatedNav')}</div>
      <div>{sortable ? renderSortLabel('净值', 'officialNavT1') : renderFloatingHeaderLabel('净值', 'officialNavT1')}</div>
      <div>净值日期</div>
      <div>现价时间</div>
      <div>调整</div>
    </>
  );

  return (
    <section className="table-card fund-table-card">
      <div className="table-card__header">
        <h3>{title}</h3>
        <p>{description}</p>
      </div>

      <div
        className={`fund-table-floating-header${floatingHeaderState.visible ? ' fund-table-floating-header--visible' : ''}`}
        style={{ left: `${floatingHeaderState.left}px`, width: `${floatingHeaderState.width}px` }}
      >
        <div className="fund-table-floating-header__inner" style={{ transform: `translateX(-${floatingHeaderState.scrollLeft}px)` }}>
          {renderHeaderCells(true)}
        </div>
      </div>

      <div className="table-scroll" ref={scrollRef}>
        <table className="fund-table" ref={tableRef}>
          <colgroup>
            <col className="fund-table__col fund-table__col--favorite" />
            <col className="fund-table__col fund-table__col--code" />
            <col className="fund-table__col fund-table__col--name" />
            <col className="fund-table__col fund-table__col--provider-premium" />
            <col className="fund-table__col fund-table__col--premium" />
            <col className="fund-table__col fund-table__col--limit" />
            <col className="fund-table__col fund-table__col--change" />
            <col className="fund-table__col fund-table__col--recent-error" />
            <col className="fund-table__col fund-table__col--error-30d" />
            <col className="fund-table__col fund-table__col--error" />
            <col className="fund-table__col fund-table__col--market" />
            <col className="fund-table__col fund-table__col--estimate" />
            <col className="fund-table__col fund-table__col--nav" />
            <col className="fund-table__col fund-table__col--nav-date" />
            <col className="fund-table__col fund-table__col--market-time" />
            <col className="fund-table__col fund-table__col--adjust" />
          </colgroup>
          <thead>
            <tr>
              <th>收藏</th>
              <th>{renderSortLabel('代码', 'code')}</th>
              <th>名称</th>
              <th title="东财 fundgz 估值计算的溢价率（第三方口径）。">东财估值溢价</th>
              <th>{renderSortLabel('溢价率', 'premiumRate')}</th>
              <th title="当前是否存在购买限额限制。点击基金详情页可查看最新限购政策。">限购</th>
              <th title="这个交易日场内价相对前一交易日的涨跌幅。">{renderSortLabel('涨跌幅', 'changeRate')}</th>
              <th>{renderSortLabel('最近误差', 'latestError')}</th>
              <th>{renderSortLabel('30d误差', 'error30d')}</th>
              <th>{renderSortLabel('训练误差', 'meanAbsError')}</th>
              <th title="场内实时价格。">{renderSortLabel('现价', 'marketPrice')}</th>
              <th title="当日净值的估值。">{renderSortLabel('估值', 'estimatedNav')}</th>
              <th title="T-N 的官方净值（按交易日口径，不含周末/节假日）。N 根据基金类别与披露节奏确定：国内 LOF 常见 T-1/T-2，QDII/黄金常见 T-2/T-3。">{renderSortLabel('净值', 'officialNavT1')}</th>
              <th title="官方净值对应日期。">净值日期</th>
              <th title="场内行情数据的采集时间。用于判断现价和涨跌幅是当日还是前一日。">现价时间</th>
              <th title="鼠标按住该按钮可拖拽调整本页基金顺序（手动排序）。">调整</th>
            </tr>
          </thead>
          <tbody>
            {sortedFunds.map((fund) => {
              const isFavorite = favoriteSet.has(fund.runtime.code);
              const premiumTone = fund.estimate.premiumRate > 0 ? 'positive' : 'negative';
              const eastmoneyPremiumRate = eastmoneyPremiumByCode[fund.runtime.code];
              const eastmoneyTone = typeof eastmoneyPremiumRate === 'number' && Number.isFinite(eastmoneyPremiumRate)
                ? (eastmoneyPremiumRate >= 0 ? 'positive' : 'negative')
                : null;
              const changeRate = getChangeRate(fund.runtime.marketPrice, fund.runtime.previousClose);
              const latestError = getLatestError(fund);
              const avg30dError = getRecent30DayAvgAbsError(fund);
              const training30Error = getTrainingValidation30Error(fund, trainingMetricsByCode);
              const compactName = getCompactFundName(fund.runtime.code, fund.runtime.name, fund.runtime.pageCategory);
              const fullName = getFullFundName(fund.runtime.code, fund.runtime.name);

              return (
                <tr
                  key={fund.runtime.code}
                  className={isFavorite ? 'fund-table__row--favorite' : undefined}
                  draggable
                  onDragStart={(event) => handleRowDragStart(event, fund.runtime.code)}
                  onDragEnd={handleRowDragEnd}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={() => handleRowDrop(fund.runtime.code)}
                >
                  <td>
                    <button
                      className={`fund-favorite-button${isFavorite ? ' fund-favorite-button--active' : ''}`}
                      type="button"
                      onClick={() => onToggleFavorite(fund.runtime.code)}
                      aria-label={isFavorite ? `取消收藏 ${fund.runtime.code}` : `收藏 ${fund.runtime.code}`}
                      title={isFavorite ? '取消收藏该基金' : '收藏该基金'}
                    >
                      <span aria-hidden="true">{isFavorite ? '★' : '☆'}</span>
                    </button>
                  </td>
                  <td>
                    <a className="fund-table__link" href={`#/fund/${fund.runtime.code}?from=${pagePath}`}>
                      {fund.runtime.code}
                    </a>
                  </td>
                  <td>
                    <span className={`fund-table__name${isFavorite ? ' fund-table__name--favorite' : ''}`} title={fullName}>{compactName}</span>
                  </td>
                  <td className={eastmoneyTone ? `tone-${eastmoneyTone}` : 'muted-text'}>
                    {typeof eastmoneyPremiumRate === 'number' && Number.isFinite(eastmoneyPremiumRate) ? formatPercent(eastmoneyPremiumRate) : '--'}
                  </td>
                  <td className={`tone-${premiumTone}`}>{formatPercent(fund.estimate.premiumRate)}</td>
                  <td className={getLimitClass(fund.runtime.purchaseLimit)}>
                    {fund.runtime.purchaseLimit || '待校验'}
                  </td>
                  <td className={changeRate >= 0 ? 'tone-positive' : 'tone-negative'}>{formatPercent(changeRate)}</td>
                  <td className={typeof latestError === 'number' ? (latestError >= 0 ? 'tone-positive' : 'tone-negative') : 'muted-text'}>
                    {typeof latestError === 'number' ? formatPercent(latestError) : '--'}
                  </td>
                  <td>{typeof avg30dError === 'number' ? formatPercent(avg30dError) : '--'}</td>
                  <td className={typeof training30Error === 'number' ? (training30Error > 0.02 ? 'tone-positive' : 'tone-negative') : 'muted-text'}>
                    {typeof training30Error === 'number' ? formatPercent(training30Error) : '未训练'}
                  </td>
                  <td>{formatCurrency(fund.runtime.marketPrice)}</td>
                  <td>{formatCurrency(fund.estimate.estimatedNav)}</td>
                  <td>{formatCurrency(fund.runtime.officialNavT1)}</td>
                  <td>{fund.runtime.navDate || '--'}</td>
                  <td>{`${fund.runtime.marketDate || '--'} ${fund.runtime.marketTime || ''}`.trim()}</td>
                  <td>
                    <button
                      className="fund-order-handle"
                      type="button"
                      title="拖拽调整本页基金顺序"
                      aria-label={`拖拽调整 ${fund.runtime.code} 顺序`}
                    >
                      <span aria-hidden="true">≡</span>
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function getChangeRate(marketPrice: number, previousClose: number) {
  return previousClose > 0 ? marketPrice / previousClose - 1 : 0;
}

function normalizeSortableNumber(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return value;
}

function stripFundCodeSuffix(name: string): string {
  return name.replace(/\s*[（(]\s*(?:基金)?(?:代码)?\s*[:：]?\s*\d{6}\s*[)）]\s*$/, '').trim();
}

const FUND_NAME_OVERRIDES: Record<string, { shortName: string; fullName?: string }> = fundShortNameMap;

const FUND_COMPANY_PREFIXES = [
  '南方', '易方达', '华夏', '嘉实', '广发', '汇添富', '富国', '博时', '国泰', '招商', '鹏华', '工银瑞信',
  '银华', '中欧', '中银', '景顺长城', '华安', '天弘', '建信', '兴证全球', '华宝', '平安', '万家', '长城',
  '长信', '国投瑞银', '诺安', '大成', '中信保诚', '交银施罗德', '前海开源', '民生加银', '南华', '华泰柏瑞',
  '华商', '中加', '西部利得', '海富通', '永赢', '信达澳亚', '创金合信', '摩根', '摩根士丹利',
];

function getFullFundName(code: string, name: string): string {
  const override = FUND_NAME_OVERRIDES[code];
  if (override?.fullName) {
    return override.fullName;
  }
  return stripFundCodeSuffix(name);
}

function getCompactFundName(code: string, name: string, pageCategory: FundViewModel['runtime']['pageCategory']): string {
  const override = FUND_NAME_OVERRIDES[code];
  if (override) {
    return withCategorySuffix(override.shortName, pageCategory);
  }

  const baseName = stripFundCodeSuffix(name);
  let compact = baseName;

  compact = compact.replace(/[（(][^)）]*(?:ETF|QDII|LOF)[^)）]*[)）]/gi, ' ');
  compact = compact.replace(/\b(?:ETF|QDII|LOF)\b/gi, ' ');
  compact = compact.replace(/(?:ETF|QDII|LOF)/gi, ' ');
  compact = compact.replace(/联接/gi, ' ');
  compact = compact.replace(/(?:人民币|人民幣)/gi, ' ');
  compact = compact.replace(/\bA(?:类|份额|份)?\b/gi, ' ');
  compact = compact.replace(/([\u4e00-\u9fa5])A(?=$|[\s（(\-_/])/g, '$1');
  compact = compact.replace(/[（(]\s*[)）]/g, ' ');

  for (const company of FUND_COMPANY_PREFIXES) {
    const escaped = company.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    compact = compact.replace(new RegExp(`^${escaped}`), '');
    compact = compact.replace(new RegExp(`${escaped}$`), '');
  }

  compact = compact.replace(/[\s\-_/]+/g, ' ').replace(/[（(]\s*[)）]/g, ' ').trim();
  return withCategorySuffix(compact || baseName, pageCategory);
}

function withCategorySuffix(shortName: string, pageCategory: FundViewModel['runtime']['pageCategory']): string {
  const normalized = shortName.trim().replace(/(?:\s*(?:ETF|LOF))+\s*$/gi, '').trim();
  const base = normalized || shortName.trim();
  if (!base) {
    return base;
  }
  const suffix = pageCategory === 'etf' ? 'ETF' : 'LOF';
  return `${base}${suffix}`;
}

function getLatestError(fund: FundViewModel): number | undefined {
  const latest = fund.journal.errors[fund.journal.errors.length - 1];
  return latest?.error;
}

function getRecent30DayAvgAbsError(fund: FundViewModel): number | undefined {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const rows = fund.journal.errors.filter((item) => item.date >= cutoff);
  if (!rows.length) {
    return undefined;
  }

  return rows.reduce((sum, item) => sum + Math.abs(item.error), 0) / rows.length;
}

function getLimitClass(limit: string | undefined): string {
  if (!limit) return '';
  if (limit === '0元') return 'muted-text';
  // 匹配纯元单位的数值，如 10元、1000元；万元不在绿色范围内
  const m = limit.match(/^([0-9]+(?:\.[0-9]+)?)元$/);
  if (m) {
    const val = parseFloat(m[1]);
    if (val > 0 && val <= 1000) return 'tone-positive';
  }
  return '';
}

function getTrainingValidation30Error(
  fund: FundViewModel,
  trainingMetricsByCode: Record<string, { maeValidation30: number }>,
): number | undefined {
  const metric = trainingMetricsByCode[fund.runtime.code];
  if (!metric || !Number.isFinite(metric.maeValidation30)) {
    return undefined;
  }

  return metric.maeValidation30;
}