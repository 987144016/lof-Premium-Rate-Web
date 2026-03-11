interface ChartPoint {
  label: string;
  value: number;
}

interface LineChartProps {
  title: string;
  primary: ChartPoint[];
  secondary?: ChartPoint[];
  primaryLabel: string;
  secondaryLabel?: string;
}

function buildPoints(points: ChartPoint[], width: number, height: number, min: number, max: number) {
  const range = max - min || 1;
  return points.map((point, index) => ({
    key: `${point.label}-${index}`,
    x: 52 + (index / Math.max(points.length - 1, 1)) * (width - 64),
    y: 12 + (height - 24) - ((point.value - min) / range) * (height - 24),
  }));
}

function buildPath(points: ChartPoint[], width: number, height: number, min: number, max: number) {
  if (points.length === 0) {
    return '';
  }

  const range = max - min || 1;
  return points
    .map((point, index) => {
      const x = 52 + (index / Math.max(points.length - 1, 1)) * (width - 64);
      const y = 12 + (height - 24) - ((point.value - min) / range) * (height - 24);
      return `${index === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(' ');
}

function buildTicks(min: number, max: number) {
  const middle = (min + max) / 2;
  return [max, middle, min];
}

export function LineChart({ title, primary, secondary, primaryLabel, secondaryLabel }: LineChartProps) {
  const allValues = [...primary, ...(secondary ?? [])].map((item) => item.value);
  const min = allValues.length > 0 ? Math.min(...allValues) : 0;
  const max = allValues.length > 0 ? Math.max(...allValues) : 1;
  const width = 640;
  const height = 220;
  const labels = primary.map((item) => item.label);
  const hasData = primary.length > 0 || (secondary?.length ?? 0) > 0;
  const primaryPoints = buildPoints(primary, width, height, min, max);
  const secondaryPoints = buildPoints(secondary ?? [], width, height, min, max);
  const ticks = buildTicks(min, max);

  return (
    <div className="chart-card">
      <div className="chart-card__header">
        <h3>{title}</h3>
        <div className="chart-legend">
          <span className="chart-legend__item">
            <i className="chart-dot chart-dot--primary" />
            {primaryLabel}
          </span>
          {secondary && secondaryLabel ? (
            <span className="chart-legend__item">
              <i className="chart-dot chart-dot--secondary" />
              {secondaryLabel}
            </span>
          ) : null}
        </div>
      </div>
      {hasData ? (
        <>
          <svg viewBox={`0 0 ${width} ${height}`} className="chart-svg" role="img" aria-label={title}>
            {ticks.map((tick, index) => {
              const y = 12 + (height - 24) - ((tick - min) / (max - min || 1)) * (height - 24);
              return (
                <g key={`${title}-tick-${index}`}>
                  <line x1="52" y1={y} x2={width - 12} y2={y} className="chart-grid-line" />
                  <text x="0" y={y + 4} className="chart-axis-label">
                    {tick.toFixed(4)}
                  </text>
                </g>
              );
            })}
            <path d={buildPath(primary, width, height, min, max)} className="chart-line chart-line--primary" />
            {secondary ? <path d={buildPath(secondary, width, height, min, max)} className="chart-line chart-line--secondary" /> : null}
            {primaryPoints.map((point) => (
              <circle key={point.key} cx={point.x} cy={point.y} r="4" className="chart-point chart-point--primary" />
            ))}
            {secondaryPoints.map((point) => (
              <circle key={point.key} cx={point.x} cy={point.y} r="4" className="chart-point chart-point--secondary" />
            ))}
          </svg>
          <div className="chart-labels">
            {labels.map((label) => (
              <span key={label}>{label.slice(5)}</span>
            ))}
          </div>
        </>
      ) : (
        <div className="chart-empty-state">暂无已结算样本。等官方净值覆盖到已记录的估值日期后，这里会自动补齐。</div>
      )}
    </div>
  );
}
