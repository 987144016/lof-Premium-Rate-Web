import { useEffect, useMemo, useRef, useState } from 'react';
import type { FundViewModel } from '../types';

type SortKey = 'code' | 'premiumRate' | 'estimatedNav' | 'marketPrice' | 'officialNavT1' | 'meanAbsError' | 'latestError' | 'error30d' | 'changeRate';

interface FundTableProps {
  funds: FundViewModel[];
  trainingMetricsByCode: Record<string, { maeValidation30: number }>;
  formatCurrency: (value: number) => string;
  formatPercent: (value: number) => string;
  title: string;
  description: string;
  pagePath: string;
}

export function FundTable({ funds, trainingMetricsByCode, formatCurrency, formatPercent, title, description, pagePath }: FundTableProps) {
    const SORT_LABEL_HINTS: Partial<Record<SortKey, string>> = {
      meanAbsError: '离线训练验证集近30天 MAE（鲁棒口径：剔除最近30天最大单日误差后计算），优先用于看模型是否训练到位。',
      latestError: '线上最近一个交易日误差（估值相对后续真实净值）。',
      error30d: '线上最近30天平均误差（随日常波动变化）。',
    };

  const [sortKey, setSortKey] = useState<SortKey>('premiumRate');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
  const tableRef = useRef<HTMLTableElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [floatingHeaderState, setFloatingHeaderState] = useState({
    visible: false,
    left: 0,
    width: 0,
  });

  const sortedFunds = useMemo(() => {
    const next = [...funds];
    next.sort((left, right) => {
      const multiplier = sortDirection === 'asc' ? 1 : -1;

      if (sortKey === 'code') {
        return multiplier * left.runtime.code.localeCompare(right.runtime.code, 'zh-CN');
      }

      const leftValue =
        sortKey === 'premiumRate'
          ? left.estimate.premiumRate
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
          ? right.estimate.premiumRate
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

  useEffect(() => {
    const updateFloatingHeader = () => {
      if (window.innerWidth <= 720 || !tableRef.current || !scrollRef.current) {
        setFloatingHeaderState((current) => (current.visible ? { visible: false, left: 0, width: 0 } : current));
        return;
      }

      const tableRect = tableRef.current.getBoundingClientRect();
      const scrollRect = scrollRef.current.getBoundingClientRect();
      const shouldShow = tableRect.top < 0 && tableRect.bottom > 72;

      setFloatingHeaderState({
        visible: shouldShow,
        left: scrollRect.left,
        width: scrollRect.width,
      });
    };

    updateFloatingHeader();
    window.addEventListener('scroll', updateFloatingHeader, { passive: true });
    window.addEventListener('resize', updateFloatingHeader);

    return () => {
      window.removeEventListener('scroll', updateFloatingHeader);
      window.removeEventListener('resize', updateFloatingHeader);
    };
  }, []);

  const renderHeaderCells = () => (
    <>
      <div>{renderSortLabel('代码', 'code')}</div>
      <div>名称</div>
      <div>{renderSortLabel('现价', 'marketPrice')}</div>
      <div>{renderSortLabel('涨跌幅', 'changeRate')}</div>
      <div>{renderSortLabel('估值', 'estimatedNav')}</div>
      <div>{renderSortLabel('溢价率', 'premiumRate')}</div>
      <div>{renderSortLabel('净值', 'officialNavT1')}</div>
      <div>净值日期</div>
      <div>现价时间</div>
      <div>{renderSortLabel('训练误差', 'meanAbsError')}</div>
      <div>{renderSortLabel('最近误差', 'latestError')}</div>
      <div>{renderSortLabel('30d误差', 'error30d')}</div>
      <div>限购</div>
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
        {renderHeaderCells()}
      </div>

      <div className="table-scroll" ref={scrollRef}>
        <table className="fund-table" ref={tableRef}>
          <colgroup>
            <col className="fund-table__col fund-table__col--code" />
            <col className="fund-table__col fund-table__col--name" />
            <col className="fund-table__col fund-table__col--market" />
            <col className="fund-table__col fund-table__col--change" />
            <col className="fund-table__col fund-table__col--estimate" />
            <col className="fund-table__col fund-table__col--premium" />
            <col className="fund-table__col fund-table__col--nav" />
            <col className="fund-table__col fund-table__col--nav-date" />
            <col className="fund-table__col fund-table__col--market-time" />
            <col className="fund-table__col fund-table__col--error" />
            <col className="fund-table__col fund-table__col--recent-error" />
            <col className="fund-table__col fund-table__col--error-30d" />
            <col className="fund-table__col fund-table__col--limit" />
          </colgroup>
          <thead>
            <tr>
              <th>{renderSortLabel('代码', 'code')}</th>
              <th>名称</th>
              <th>{renderSortLabel('现价', 'marketPrice')}</th>
              <th>{renderSortLabel('涨跌幅', 'changeRate')}</th>
              <th>{renderSortLabel('估值', 'estimatedNav')}</th>
              <th>{renderSortLabel('溢价率', 'premiumRate')}</th>
              <th>{renderSortLabel('净值', 'officialNavT1')}</th>
              <th>净值日期</th>
              <th>现价时间</th>
              <th>{renderSortLabel('训练误差', 'meanAbsError')}</th>
              <th>{renderSortLabel('最近误差', 'latestError')}</th>
              <th>{renderSortLabel('30d误差', 'error30d')}</th>
              <th>限购</th>
            </tr>
          </thead>
          <tbody>
            {sortedFunds.map((fund) => {
              const premiumTone = fund.estimate.premiumRate > 0 ? 'positive' : 'negative';
              const changeRate = getChangeRate(fund.runtime.marketPrice, fund.runtime.previousClose);
              const latestError = getLatestError(fund);
              const avg30dError = getRecent30DayAvgAbsError(fund);
              const training30Error = getTrainingValidation30Error(fund, trainingMetricsByCode);

              return (
                <tr key={fund.runtime.code}>
                  <td>
                    <a className="fund-table__link" href={`#/fund/${fund.runtime.code}?from=${pagePath}`}>
                      {fund.runtime.code}
                    </a>
                  </td>
                  <td>
                    <span className="fund-table__name" title={fund.runtime.name}>{fund.runtime.name}</span>
                  </td>
                  <td>{formatCurrency(fund.runtime.marketPrice)}</td>
                  <td className={changeRate >= 0 ? 'tone-positive' : 'tone-negative'}>{formatPercent(changeRate)}</td>
                  <td>{formatCurrency(fund.estimate.estimatedNav)}</td>
                  <td className={`tone-${premiumTone}`}>{formatPercent(fund.estimate.premiumRate)}</td>
                  <td>{formatCurrency(fund.runtime.officialNavT1)}</td>
                  <td>{fund.runtime.navDate || '--'}</td>
                  <td>{`${fund.runtime.marketDate || '--'} ${fund.runtime.marketTime || ''}`.trim()}</td>
                  <td className={typeof training30Error === 'number' ? (training30Error > 0.02 ? 'tone-positive' : 'tone-negative') : 'muted-text'}>
                    {typeof training30Error === 'number' ? formatPercent(training30Error) : '未训练'}
                  </td>
                  <td className={typeof latestError === 'number' ? (latestError >= 0 ? 'tone-positive' : 'tone-negative') : 'muted-text'}>
                    {typeof latestError === 'number' ? formatPercent(latestError) : '--'}
                  </td>
                  <td>{typeof avg30dError === 'number' ? formatPercent(avg30dError) : '--'}</td>
                  <td className={getLimitClass(fund.runtime.purchaseLimit)}>
                    {fund.runtime.purchaseLimit || '待校验'}
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