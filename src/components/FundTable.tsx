import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { FundViewModel } from '../types';

type SortKey = 'code' | 'premiumRate' | 'estimatedNav' | 'marketPrice' | 'officialNavT1' | 'meanAbsError' | 'changeRate';

interface FundTableProps {
  funds: FundViewModel[];
  formatCurrency: (value: number) => string;
  formatPercent: (value: number) => string;
}

export function FundTable({ funds, formatCurrency, formatPercent }: FundTableProps) {
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
          : sortKey === 'changeRate'
            ? getChangeRate(left.runtime.marketPrice, left.runtime.previousClose)
          : sortKey === 'estimatedNav'
            ? left.estimate.estimatedNav
            : sortKey === 'marketPrice'
              ? left.runtime.marketPrice
              : sortKey === 'officialNavT1'
                ? left.runtime.officialNavT1
                : left.model.meanAbsError;
      const rightValue =
        sortKey === 'premiumRate'
          ? right.estimate.premiumRate
          : sortKey === 'changeRate'
            ? getChangeRate(right.runtime.marketPrice, right.runtime.previousClose)
          : sortKey === 'estimatedNav'
            ? right.estimate.estimatedNav
            : sortKey === 'marketPrice'
              ? right.runtime.marketPrice
              : sortKey === 'officialNavT1'
                ? right.runtime.officialNavT1
                : right.model.meanAbsError;

      return multiplier * (leftValue - rightValue);
    });

    return next;
  }, [funds, sortDirection, sortKey]);

  const toggleSort = (nextKey: SortKey) => {
    setSortKey((currentKey) => {
      if (currentKey === nextKey) {
        setSortDirection((currentDirection) => (currentDirection === 'asc' ? 'desc' : 'asc'));
        return currentKey;
      }

      setSortDirection(nextKey === 'code' ? 'asc' : 'desc');
      return nextKey;
    });
  };

  const renderSortLabel = (label: string, key: SortKey) => {
    const active = sortKey === key;
    const suffix = active ? (sortDirection === 'desc' ? ' ↓' : ' ↑') : '';

    return (
      <button className={`table-sort-button${active ? ' table-sort-button--active' : ''}`} type="button" onClick={() => toggleSort(key)}>
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
      <div>{renderSortLabel('模型误差', 'meanAbsError')}</div>
      <div>限购</div>
    </>
  );

  return (
    <section className="table-card fund-table-card">
      <div className="table-card__header">
        <h3>基金溢价率列表</h3>
        <p>自动估值口径：以最近官方净值为锚，结合场内当日涨跌幅和该基金自己的历史误差修正。点击表头可排序。</p>
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
              <th>{renderSortLabel('模型误差', 'meanAbsError')}</th>
              <th>限购</th>
            </tr>
          </thead>
          <tbody>
            {sortedFunds.map((fund) => {
              const premiumTone = fund.estimate.premiumRate > 0 ? 'positive' : 'negative';
              const changeRate = getChangeRate(fund.runtime.marketPrice, fund.runtime.previousClose);

              return (
                <tr key={fund.runtime.code}>
                  <td>
                    <Link className="fund-table__link" to={`/fund/${fund.runtime.code}`}>
                      {fund.runtime.code}
                    </Link>
                  </td>
                  <td>
                    {fund.runtime.name}
                  </td>
                  <td>{formatCurrency(fund.runtime.marketPrice)}</td>
                  <td className={changeRate >= 0 ? 'tone-positive' : 'tone-negative'}>{formatPercent(changeRate)}</td>
                  <td>{formatCurrency(fund.estimate.estimatedNav)}</td>
                  <td className={`tone-${premiumTone}`}>{formatPercent(fund.estimate.premiumRate)}</td>
                  <td>{formatCurrency(fund.runtime.officialNavT1)}</td>
                  <td>{fund.runtime.navDate || '--'}</td>
                  <td>{`${fund.runtime.marketDate || '--'} ${fund.runtime.marketTime || ''}`.trim()}</td>
                  <td>{formatBpsFromPercent(fund.model.meanAbsError)}</td>
                  <td>{fund.runtime.purchaseLimit || fund.runtime.purchaseStatus || '待校验'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function formatBpsFromPercent(value: number) {
  return `${(value * 10000).toFixed(1)} bp`;
}

function getChangeRate(marketPrice: number, previousClose: number) {
  return previousClose > 0 ? marketPrice / previousClose - 1 : 0;
}