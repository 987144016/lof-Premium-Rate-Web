import { Link } from 'react-router-dom';
import type { FundViewModel } from '../types';

interface FundCardProps {
  fund: FundViewModel;
  formatCurrency: (value: number) => string;
  formatPercent: (value: number) => string;
}

export function FundCard({ fund, formatCurrency, formatPercent }: FundCardProps) {
  const premiumTone = fund.estimate.premiumRate > 0 ? 'positive' : 'negative';

  return (
    <Link className="fund-card" to={`/fund/${fund.runtime.code}`}>
      <div className="fund-card__topline">
        <span>{fund.runtime.code}</span>
        <span className={`pill pill--${premiumTone}`}>{fund.runtime.detailMode === 'holdings' ? '精细模式' : '独立模型'}</span>
      </div>
      <h3>{fund.runtime.name}</h3>
      <p>{fund.runtime.benchmark || '已接入自动同步，等待基准文本更新。'}</p>
      <div className="fund-card__metrics">
        <div>
          <span>溢价率</span>
          <strong className={`tone-${premiumTone}`}>{formatPercent(fund.estimate.premiumRate)}</strong>
        </div>
        <div>
          <span>估值</span>
          <strong>{formatCurrency(fund.estimate.estimatedNav)}</strong>
        </div>
        <div>
          <span>现价</span>
          <strong>{formatCurrency(fund.runtime.marketPrice)}</strong>
        </div>
        <div>
          <span>误差 MAE</span>
          <strong>{formatPercent(fund.model.meanAbsError)}</strong>
        </div>
      </div>
    </Link>
  );
}
