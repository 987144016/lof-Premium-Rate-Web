import type { ChangeEvent } from 'react';
import type { FundScenario } from '../types';

interface EditableHoldingsTableProps {
  scenario: FundScenario;
  onHoldingChange: (index: number, field: 'basePrice' | 'currentPrice', value: number) => void;
  onProxyChange: (index: number, field: 'baseLevel' | 'currentLevel', value: number) => void;
}

function toPercent(base: number, current: number): string {
  if (base <= 0 || current <= 0) {
    return '--';
  }

  return `${(((current / base) - 1) * 100).toFixed(2)}%`;
}

function readNumber(event: ChangeEvent<HTMLInputElement>): number {
  return Number(event.target.value);
}

export function EditableHoldingsTable({ scenario, onHoldingChange, onProxyChange }: EditableHoldingsTableProps) {
  return (
    <div className="table-stack">
      <div className="table-card">
        <div className="table-card__header">
          <h3>前十大持仓</h3>
          <p>默认值来自 2025 年 4 季报，可直接覆盖成你手头的 T-1 基准价和当前价。</p>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>标的</th>
                <th>权重</th>
                <th>T-1 基准价</th>
                <th>当前价</th>
                <th>涨跌</th>
              </tr>
            </thead>
            <tbody>
              {scenario.holdings.map((holding, index) => (
                <tr key={holding.ticker}>
                  <td>
                    <div className="symbol-cell">
                      <strong>{holding.ticker}</strong>
                      <span>{holding.name}</span>
                    </div>
                  </td>
                  <td>{holding.weight.toFixed(2)}%</td>
                  <td>
                    <input
                      type="number"
                      value={holding.basePrice}
                      step="0.01"
                      onChange={(event) => onHoldingChange(index, 'basePrice', readNumber(event))}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      value={holding.currentPrice}
                      step="0.01"
                      onChange={(event) => onHoldingChange(index, 'currentPrice', readNumber(event))}
                    />
                  </td>
                  <td>{toPercent(holding.basePrice, holding.currentPrice)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="table-card">
        <div className="table-card__header">
          <h3>代理篮子</h3>
          <p>承接未披露或未展开的成分股，初期可以用行业指数、夜盘 ETF 或你自己的替代组合。</p>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>篮子</th>
                <th>权重</th>
                <th>T-1 基准值</th>
                <th>当前值</th>
                <th>涨跌</th>
              </tr>
            </thead>
            <tbody>
              {scenario.proxyBuckets.map((bucket, index) => (
                <tr key={bucket.key}>
                  <td>
                    <div className="symbol-cell">
                      <strong>{bucket.name}</strong>
                      <span>{bucket.note}</span>
                    </div>
                  </td>
                  <td>{bucket.weight.toFixed(2)}%</td>
                  <td>
                    <input
                      type="number"
                      value={bucket.baseLevel}
                      step="0.01"
                      onChange={(event) => onProxyChange(index, 'baseLevel', readNumber(event))}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      value={bucket.currentLevel}
                      step="0.01"
                      onChange={(event) => onProxyChange(index, 'currentLevel', readNumber(event))}
                    />
                  </td>
                  <td>{toPercent(bucket.baseLevel, bucket.currentLevel)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
