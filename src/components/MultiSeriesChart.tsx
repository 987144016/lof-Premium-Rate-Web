interface ChartPoint {
  label: string;
  value: number;
}

interface ChartSeries {
  key: string;
  label: string;
  points: ChartPoint[];
  tone: 'primary' | 'secondary' | 'tertiary' | 'quaternary';
  dashed?: boolean;
}

interface MultiSeriesChartProps {
  title: string;
  series: ChartSeries[];
  valueFormatter?: (value: number) => string;
  splitLabel?: string;
  splitLabelText?: string;
}

function buildPath(points: ChartPoint[], width: number, height: number, min: number, max: number, labelIndexMap: Map<string, number>, domainSize: number) {
  if (!points.length) {
    return '';
  }

  const range = max - min || 1;
  return points
    .map((point, index) => {
      const labelIndex = labelIndexMap.get(point.label) ?? index;
      const x = 52 + (labelIndex / Math.max(domainSize - 1, 1)) * (width - 64);
      const y = 12 + (height - 24) - ((point.value - min) / range) * (height - 24);
      return `${index === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(' ');
}

function buildPoints(points: ChartPoint[], width: number, height: number, min: number, max: number, labelIndexMap: Map<string, number>, domainSize: number) {
  const range = max - min || 1;
  return points.map((point, index) => ({
    key: `${point.label}-${index}`,
    x: 52 + ((labelIndexMap.get(point.label) ?? index) / Math.max(domainSize - 1, 1)) * (width - 64),
    y: 12 + (height - 24) - ((point.value - min) / range) * (height - 24),
  }));
}

function buildTicks(min: number, max: number) {
  const middle = (min + max) / 2;
  return [max, middle, min];
}

function buildDefaultLabels(domainLabels: string[]) {
  if (!domainLabels.length) {
    return [];
  }

  const maxTicks = 6;
  if (domainLabels.length <= maxTicks) {
    return domainLabels;
  }

  const ticks: string[] = [];
  for (let i = 0; i < maxTicks; i += 1) {
    const index = Math.round((i / (maxTicks - 1)) * (domainLabels.length - 1));
    ticks.push(domainLabels[index]);
  }

  return [...new Set(ticks)];
}

export function MultiSeriesChart({ title, series, valueFormatter, splitLabel, splitLabelText }: MultiSeriesChartProps) {
  const values = series.flatMap((item) => item.points.map((point) => point.value));
  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values) : 1;
  const width = 640;
  const height = 220;
  const ticks = buildTicks(min, max);
  const formatTick = valueFormatter ?? ((value: number) => value.toFixed(4));
  const hasData = series.some((item) => item.points.length > 0);
  const domainLabels = [...new Set(series.flatMap((item) => item.points.map((point) => point.label)))].sort((left, right) => left.localeCompare(right));
  const domainSize = Math.max(1, domainLabels.length);
  const labelIndexMap = new Map(domainLabels.map((label, index) => [label, index]));
  const splitIndex = splitLabel ? labelIndexMap.get(splitLabel) : undefined;
  const splitX = typeof splitIndex === 'number'
    ? 52 + (splitIndex / Math.max(domainSize - 1, 1)) * (width - 64)
    : null;
  const labels = buildDefaultLabels(domainLabels).slice(0, 8);

  return (
    <div className="chart-card">
      <div className="chart-card__header">
        <h3>{title}</h3>
        <div className="chart-legend">
          {series.map((item) => (
            <span key={item.key} className="chart-legend__item">
              <i className={`chart-dot chart-dot--${item.tone}${item.dashed ? ' chart-dot--dashed' : ''}`} />
              {item.label}
            </span>
          ))}
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
                    {formatTick(tick)}
                  </text>
                </g>
              );
            })}

            {splitX !== null ? (
              <g>
                <line x1={splitX} y1={12} x2={splitX} y2={height - 12} className="chart-split-line" />
                <text x={splitX + 4} y={20} className="chart-split-label">{splitLabelText || '验证开始'}</text>
              </g>
            ) : null}

            {series.map((item) => {
              const points = buildPoints(item.points, width, height, min, max, labelIndexMap, domainSize);
              return (
                <g key={item.key}>
                  <path
                    d={buildPath(item.points, width, height, min, max, labelIndexMap, domainSize)}
                    className={`chart-line chart-line--${item.tone}${item.dashed ? ' chart-line--dashed' : ''}`}
                  />
                  {points.map((point) => (
                    <circle key={point.key} cx={point.x} cy={point.y} r="3" className={`chart-point chart-point--${item.tone}`} />
                  ))}
                </g>
              );
            })}
          </svg>
          {labels.length ? (
            <div className="chart-labels chart-labels--dates">
              {labels.map((label, index) => (
                <span key={`${label}-${index}`}>{label}</span>
              ))}
            </div>
          ) : null}
        </>
      ) : (
        <div className="chart-empty-state">样本不足，暂时无法绘图。</div>
      )}
    </div>
  );
}
