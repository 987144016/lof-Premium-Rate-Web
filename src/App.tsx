import { useEffect, useState } from 'react';
import { Link, Navigate, Route, Routes, useParams } from 'react-router-dom';
import { FundTable } from './components/FundTable';
import { EditableHoldingsTable } from './components/EditableHoldingsTable';
import { LineChart } from './components/LineChart';
import { MetricCard } from './components/MetricCard';
import { cloneInitialScenario, defaultCalibration } from './data/funds';
import { estimateScenario, trainCalibration } from './lib/estimator';
import { readFundJournal, readWatchlistModel, writeFundJournal, writeWatchlistModel } from './lib/storage';
import { estimateWatchlistFund, reconcileJournal, recordEstimateSnapshot } from './lib/watchlist';
import type { CalibrationModel, FundRuntimeData, FundScenario, FundViewModel, RuntimePayload } from './types';

const DETAIL_CALIBRATION_PREFIX = 'premium-estimator:detailed-calibration:';

function formatCurrency(value: number): string {
  return value.toFixed(4);
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function formatBps(value: number): string {
  return `${(value * 10000).toFixed(1)} bp`;
}

function getMarketChangeRate(runtime: FundRuntimeData): number {
  return runtime.previousClose > 0 ? runtime.marketPrice / runtime.previousClose - 1 : 0;
}

function formatOptionalCurrency(value?: number): string {
  return typeof value === 'number' && Number.isFinite(value) ? formatCurrency(value) : '--';
}

function formatDateTime(value: string): string {
  if (!value) {
    return '--';
  }

  return new Date(value).toLocaleString();
}

function formatRuntimeTime(date: string, time: string): string {
  const merged = `${date || '--'} ${time || ''}`.trim();
  return merged || '--';
}

function readStoredCalibration(code: string): CalibrationModel {
  if (typeof window === 'undefined') {
    return defaultCalibration;
  }

  const raw = window.localStorage.getItem(`${DETAIL_CALIBRATION_PREFIX}${code}`);
  if (!raw) {
    return defaultCalibration;
  }

  try {
    return { ...defaultCalibration, ...JSON.parse(raw) } as CalibrationModel;
  } catch {
    return defaultCalibration;
  }
}

function writeStoredCalibration(code: string, calibration: CalibrationModel) {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.setItem(`${DETAIL_CALIBRATION_PREFIX}${code}`, JSON.stringify(calibration));
}

function DetailedEstimatorPanel({ fund }: { fund: FundViewModel }) {
  const [scenario, setScenario] = useState<FundScenario>(() => cloneInitialScenario(fund.runtime));
  const [calibration, setCalibration] = useState<CalibrationModel>(() => readStoredCalibration(fund.runtime.code));
  const [actualNavInput, setActualNavInput] = useState('');
  const result = estimateScenario(scenario, calibration);
  const premiumTone = result.premiumRate > 0 ? 'positive' : 'negative';

  useEffect(() => {
    setScenario(cloneInitialScenario(fund.runtime));
  }, [fund.runtime]);

  useEffect(() => {
    writeStoredCalibration(fund.runtime.code, calibration);
  }, [calibration, fund.runtime.code]);

  const updateScenario = (updater: (current: FundScenario) => FundScenario) => {
    setScenario((current) => updater(current));
  };

  const handleHoldingChange = (index: number, field: 'basePrice' | 'currentPrice', value: number) => {
    updateScenario((current) => {
      const next = structuredClone(current);
      next.holdings[index][field] = Number.isFinite(value) && value > 0 ? value : 0;
      return next;
    });
  };

  const handleProxyChange = (index: number, field: 'baseLevel' | 'currentLevel', value: number) => {
    updateScenario((current) => {
      const next = structuredClone(current);
      next.proxyBuckets[index][field] = Number.isFinite(value) && value > 0 ? value : 0;
      return next;
    });
  };

  const handleLearn = () => {
    const actualNav = Number(actualNavInput);
    if (!Number.isFinite(actualNav) || actualNav <= 0) {
      return;
    }

    setCalibration((current) => trainCalibration(current, scenario, actualNav));
    setActualNavInput('');
  };

  return (
    <section className="detail-stack">
      <section className="metrics-grid">
        <MetricCard
          label="持仓模式估值"
          value={formatCurrency(result.correctedEstimatedNav)}
          hint={`基于 ${scenario.officialNavT1.toFixed(4)} 的细颗粒度估值`}
          tone="neutral"
        />
        <MetricCard
          label="场内价格"
          value={formatCurrency(scenario.latestMarketPrice)}
          hint={formatRuntimeTime(fund.runtime.marketDate, fund.runtime.marketTime)}
          tone="neutral"
        />
        <MetricCard
          label="持仓模式溢价率"
          value={formatPercent(result.premiumRate)}
          hint={result.premiumRate >= 0 ? '价格高于持仓模式估值' : '价格低于持仓模式估值'}
          tone={premiumTone}
        />
        <MetricCard
          label="细模型修正"
          value={formatBps(result.learnedBiasReturn)}
          hint={`样本数 ${calibration.sampleCount}，平均绝对误差 ${formatBps(calibration.meanAbsError)}`}
          tone={result.learnedBiasReturn >= 0 ? 'positive' : 'negative'}
        />
      </section>

      <section className="panel summary-strip summary-strip--stacked detail-time-strip">
        <div>
          <span>估值锚定净值日期</span>
          <strong>{scenario.navDate || '--'}</strong>
        </div>
        <div>
          <span>场内价格时间</span>
          <strong>{formatRuntimeTime(fund.runtime.marketDate, fund.runtime.marketTime)}</strong>
        </div>
        <div>
          <span>USD/CNY 时间</span>
          <strong>{fund.runtime.fx ? formatRuntimeTime(fund.runtime.fx.quoteDate, fund.runtime.fx.quoteTime) : '--'}</strong>
        </div>
        <div>
          <span>持仓报价时间</span>
          <strong>{formatRuntimeTime(fund.runtime.holdingsQuoteDate || '', fund.runtime.holdingsQuoteTime || '')}</strong>
        </div>
      </section>

      <section className="panel control-panel">
        <div className="panel__header">
          <h2>161128 细颗粒度估值实验室</h2>
          <p>主页日常只看自动溢价率。点进来后再用持仓、代理篮子和汇率细调 161128 的估值。</p>
        </div>
        <div className="control-grid">
          <label>
            <span>官方 T-1 净值</span>
            <input
              type="number"
              value={scenario.officialNavT1}
              step="0.0001"
              onChange={(event) =>
                updateScenario((current) => ({
                  ...current,
                  officialNavT1: Number(event.target.value) || 0,
                }))
              }
            />
          </label>
          <label>
            <span>场内现价</span>
            <input
              type="number"
              value={scenario.latestMarketPrice}
              step="0.0001"
              onChange={(event) =>
                updateScenario((current) => ({
                  ...current,
                  latestMarketPrice: Number(event.target.value) || 0,
                }))
              }
            />
          </label>
          <label>
            <span>USD/CNY 基准汇率</span>
            <input
              type="number"
              value={scenario.fx.baseRate}
              step="0.0001"
              onChange={(event) =>
                updateScenario((current) => ({
                  ...current,
                  fx: { ...current.fx, baseRate: Number(event.target.value) || 0 },
                }))
              }
            />
          </label>
          <label>
            <span>USD/CNY 当前汇率</span>
            <input
              type="number"
              value={scenario.fx.currentRate}
              step="0.0001"
              onChange={(event) =>
                updateScenario((current) => ({
                  ...current,
                  fx: { ...current.fx, currentRate: Number(event.target.value) || 0 },
                }))
              }
            />
          </label>
          <label>
            <span>人工修正</span>
            <input
              type="number"
              value={scenario.manualBiasBps}
              step="1"
              onChange={(event) =>
                updateScenario((current) => ({
                  ...current,
                  manualBiasBps: Number(event.target.value) || 0,
                }))
              }
            />
            <small>单位 bp，用来覆盖已知但尚未建模的偏差。</small>
          </label>
        </div>

        <div className="summary-strip">
          <div>
            <span>股票篮子收益</span>
            <strong>{formatPercent(result.stockBasketReturn)}</strong>
          </div>
          <div>
            <span>汇率变化</span>
            <strong>{formatPercent(result.fxReturn)}</strong>
          </div>
          <div>
            <span>日费用拖累</span>
            <strong>{formatBps(-result.feeDrag)}</strong>
          </div>
          <div>
            <span>人工修正</span>
            <strong>{formatBps(result.manualBiasReturn)}</strong>
          </div>
        </div>
      </section>

      <EditableHoldingsTable
        scenario={scenario}
        onHoldingChange={handleHoldingChange}
        onProxyChange={handleProxyChange}
      />

      <section className="panel split-panel">
        <div className="split-panel__column">
          <div className="panel__header">
            <h2>贡献拆解</h2>
            <p>每一项都是按净值权重贡献到整体估值，而不是只做简单平均。</p>
          </div>
          <div className="contribution-list">
            {result.contributions.map((item) => (
              <div className="contribution-row" key={item.key}>
                <div>
                  <strong>{item.label}</strong>
                  <span>{item.weight.toFixed(2)}% 权重</span>
                </div>
                <div>
                  <strong>{formatPercent(item.contributionReturn)}</strong>
                  <span>本地涨跌 {formatPercent(item.localReturn)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="split-panel__column">
          <div className="panel__header">
            <h2>细模型自学习</h2>
            <p>这里是 161128 单独的持仓模型，不和其他基金混用参数。</p>
          </div>

          <div className="learning-card">
            <label>
              <span>真实净值回填</span>
              <input
                type="number"
                value={actualNavInput}
                placeholder="例如 5.5128"
                step="0.0001"
                onChange={(event) => setActualNavInput(event.target.value)}
              />
            </label>
            <button type="button" onClick={handleLearn}>
              记录真实值并训练
            </button>
          </div>

          <div className="coefficient-grid">
            <div>
              <span>alpha</span>
              <strong>{formatBps(calibration.alpha)}</strong>
            </div>
            <div>
              <span>betaBasket</span>
              <strong>{calibration.betaBasket.toFixed(4)}</strong>
            </div>
            <div>
              <span>betaFx</span>
              <strong>{calibration.betaFx.toFixed(4)}</strong>
            </div>
            <div>
              <span>最近训练</span>
              <strong>{calibration.lastUpdatedAt ? new Date(calibration.lastUpdatedAt).toLocaleString() : '暂无'}</strong>
            </div>
          </div>
        </div>
      </section>
    </section>
  );
}

function HomePage({ funds, syncedAt, loading, error }: { funds: FundViewModel[]; syncedAt: string; loading: boolean; error: string }) {
  return (
    <main className="page">
      <section className="hero panel hero--wide">
        <div className="hero__copy">
          <span className="eyebrow">本地缓存 + 免费行情 + 每基金独立模型</span>
          <h1>溢价率日常看板</h1>
          <p>
            自动估值不是 T-1 原值本身，而是“以最近官方净值为锚、叠加场内当日涨跌幅修正”的当日指示估值。日净值与基础资料按天缓存，场内价格与汇率走免费接口；如果你通过主入口启动，后台会每 60 秒重抓一次数据。
          </p>
        </div>
        <div className="hero__facts hero__facts--single">
          <div>
            <span>跟踪基金数</span>
            <strong>{funds.length}</strong>
          </div>
          <div>
            <span>累计访客</span>
            <strong id="busuanzi_value_site_uv">--</strong>
          </div>
          <div>
            <span>页面浏览</span>
            <strong id="busuanzi_value_site_pv">--</strong>
          </div>
          <div>
            <span>最近同步</span>
            <strong>{syncedAt ? formatDateTime(syncedAt) : '等待同步'}</strong>
          </div>
          <div>
            <span>状态</span>
            <strong>{loading ? '同步中' : error ? '同步异常' : '可用'}</strong>
          </div>
        </div>
      </section>

      {error ? <section className="panel notice-panel">{error}</section> : null}

      <section className="panel notice-panel">
        首页展示的累计访客和页面浏览是匿名粗略计数。页面浏览会随着刷新增加；如果只是想粗看有没有人持续来用，应优先参考累计访客，而不是页面浏览。严格口径的当日去重访客、留存或付费意愿，当前这套纯静态免费方案并不能准确给出。
      </section>

      <section className="panel notice-panel">
        免责声明：本页面仅用于基金溢价率观察与估值研究，不构成任何投资建议，也不保证数据实时、完整或绝对准确。页面打开后会每 60 秒自动拉取一次最新运行时数据；但如果站点本身刚发布了新功能、新样式或新代码，通常仍需要你手动刷新页面一次，浏览器才会拿到最新版本。
      </section>

      <FundTable funds={funds} formatCurrency={formatCurrency} formatPercent={formatPercent} />

      <section className="panel notice-panel">
        首页显示的是列表主看板。自动估值口径是最近官方净值锚定后的当日指示值，主要参考场内当日涨跌幅，而不是直接把场内溢价喂回估值。点击基金代码进入详情页后，可以看误差折线、独立修正模型；161128 还会额外显示持仓级估值实验室、USD/CNY 时间和夜间美股持仓报价。
      </section>
    </main>
  );
}

function DetailPage({ funds, syncedAt, loading }: { funds: FundViewModel[]; syncedAt: string; loading: boolean }) {
  const params = useParams();
  const fund = funds.find((item) => item.runtime.code === params.code);

  if (loading) {
    return (
      <main className="page">
        <section className="panel notice-panel">基金数据加载中...</section>
      </main>
    );
  }

  if (!fund) {
    return <Navigate to="/" replace />;
  }

  const historyPoints = fund.journal.errors.slice(-20);
  const estimatedSeries = historyPoints.map((item) => ({ label: item.date, value: item.estimatedNav }));
  const actualSeries = historyPoints.map((item) => ({ label: item.date, value: item.actualNav }));
  const errorSeries = historyPoints.map((item) => ({ label: item.date, value: item.error }));
  const premiumTone = fund.estimate.premiumRate > 0 ? 'positive' : 'negative';
  const actualNavByDate = new Map(fund.runtime.navHistory.map((item) => [item.date, item.nav]));
  const recentSnapshots = [...fund.journal.snapshots].slice(-5).reverse();
  const recentNavHistory = fund.runtime.navHistory.slice(0, 5);

  return (
    <main className="page">
      <section className="detail-header panel">
        <div>
          <Link className="back-link" to="/">
            返回看板
          </Link>
          <span className="eyebrow">{fund.runtime.code} 详情</span>
          <h1>{fund.runtime.name}</h1>
          <p>{fund.runtime.benchmark || '该基金已纳入自动同步，但基准文本暂未抓取到。'}</p>
        </div>
        <div className="hero__facts hero__facts--single">
          <div>
            <span>最新净值日期</span>
            <strong>{fund.runtime.navDate || '--'}</strong>
          </div>
          <div>
            <span>场内现价时间</span>
            <strong>{formatRuntimeTime(fund.runtime.marketDate, fund.runtime.marketTime)}</strong>
          </div>
          <div>
            <span>自动估值日期</span>
            <strong>{fund.runtime.marketDate || fund.runtime.navDate || '--'}</strong>
          </div>
          <div>
            <span>自动同步时间</span>
            <strong>{syncedAt ? formatDateTime(syncedAt) : '--'}</strong>
          </div>
        </div>
      </section>

      <section className="metrics-grid">
        <MetricCard label="自动估值" value={formatCurrency(fund.estimate.estimatedNav)} hint={`估值日期 ${fund.runtime.marketDate || fund.runtime.navDate || '--'}`} tone="neutral" />
        <MetricCard
          label="场内价格"
          value={formatCurrency(fund.runtime.marketPrice)}
          hint={formatRuntimeTime(fund.runtime.marketDate, fund.runtime.marketTime)}
          tone="neutral"
        />
        <MetricCard
          label="场内涨跌幅"
          value={formatPercent(getMarketChangeRate(fund.runtime))}
          hint={`昨收 ${formatCurrency(fund.runtime.previousClose)}`}
          tone={getMarketChangeRate(fund.runtime) >= 0 ? 'positive' : 'negative'}
        />
        <MetricCard
          label="自动溢价率"
          value={formatPercent(fund.estimate.premiumRate)}
          hint={fund.estimate.premiumRate >= 0 ? '价格高于自动估值' : '价格低于自动估值'}
          tone={premiumTone}
        />
      </section>

      <section className="panel summary-strip summary-strip--stacked">
        <div>
          <span>模型 MAE</span>
          <strong>{formatBps(fund.model.meanAbsError)}</strong>
        </div>
        <div>
          <span>模型样本数</span>
          <strong>{fund.model.sampleCount}</strong>
        </div>
      </section>

      <section className="panel split-panel">
        <div className="split-panel__column">
          <div className="panel__header">
            <h2>自动模型说明</h2>
            <p>当前自动模型按该基金自己的场内当日涨跌幅和误差历史单独学习，不和其他基金混参。它估的是“以最近官方净值为锚的当日指示估值”，不是已经公布的真实净值。</p>
          </div>
          <div className="coefficient-grid">
            <div>
              <span>alpha</span>
              <strong>{formatBps(fund.model.alpha)}</strong>
            </div>
            <div>
              <span>betaLead</span>
              <strong>{fund.model.betaLead.toFixed(4)}</strong>
            </div>
            <div>
              <span>场内领先收益</span>
              <strong>{formatPercent(fund.estimate.leadReturn)}</strong>
            </div>
            <div>
              <span>最近训练</span>
              <strong>{fund.model.lastUpdatedAt ? formatDateTime(fund.model.lastUpdatedAt) : '暂无'}</strong>
            </div>
          </div>
        </div>
        <div className="split-panel__column">
          <div className="panel__header">
            <h2>误差入口</h2>
            <p>这里可以直接看昨天估值和后来真实净值之间的差距。样本会持续累积，方便你判断模型是否靠谱。</p>
          </div>
          <div className="summary-strip summary-strip--stacked">
            <div>
              <span>历史已结算样本</span>
              <strong>{fund.journal.errors.length}</strong>
            </div>
            <div>
              <span>最近误差</span>
              <strong>{historyPoints.length > 0 ? formatBps(historyPoints[historyPoints.length - 1].error) : '--'}</strong>
            </div>
          </div>
        </div>
      </section>

      <section className="mini-data-grid">
        <section className="chart-card">
          <div className="chart-card__header">
            <h3>最近估值记录</h3>
            <div className="muted-text">先展示已记录的估值快照，真实净值到位后自动结算误差</div>
          </div>
          {recentSnapshots.length > 0 ? (
            <div className="table-scroll">
              <table className="mini-data-table">
                <thead>
                  <tr>
                    <th>估值日期</th>
                    <th>估值</th>
                    <th>场内价</th>
                    <th>对应真实净值</th>
                    <th>状态</th>
                  </tr>
                </thead>
                <tbody>
                  {recentSnapshots.map((item) => {
                    const actualNav = actualNavByDate.get(item.estimateDate);
                    const hasActual = typeof actualNav === 'number';

                    return (
                      <tr key={item.estimateDate}>
                        <td>{item.estimateDate}</td>
                        <td>{formatCurrency(item.estimatedNav)}</td>
                        <td>{formatCurrency(item.marketPrice)}</td>
                        <td>{formatOptionalCurrency(actualNav)}</td>
                        <td className={hasActual ? 'tone-positive' : 'muted-text'}>{hasActual ? '已结算' : '待净值'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="mini-data-empty">还没有历史估值记录。</div>
          )}
        </section>

        <section className="chart-card">
          <div className="chart-card__header">
            <h3>最近抓到的官方净值</h3>
            <div className="muted-text">这里展示同步脚本当前抓到的最近几天净值</div>
          </div>
          <div className="table-scroll">
            <table className="mini-data-table">
              <thead>
                <tr>
                  <th>净值日期</th>
                  <th>官方净值</th>
                </tr>
              </thead>
              <tbody>
                {recentNavHistory.map((item) => (
                  <tr key={item.date}>
                    <td>{item.date}</td>
                    <td>{formatCurrency(item.nav)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </section>

      <section className="chart-grid">
        <LineChart title="估值与真实净值" primary={estimatedSeries} secondary={actualSeries} primaryLabel="昨日估值" secondaryLabel="后续真实净值" />
        <LineChart title="误差折线" primary={errorSeries} primaryLabel="误差" />
      </section>

      {fund.runtime.detailMode === 'holdings' ? <DetailedEstimatorPanel fund={fund} /> : null}
    </main>
  );
}

export default function App() {
  const [funds, setFunds] = useState<FundViewModel[]>([]);
  const [syncedAt, setSyncedAt] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;

    async function loadRuntime() {
      setLoading(true);
      setError('');

      try {
        const response = await fetch(`generated/funds-runtime.json?ts=${Date.now()}`);
        if (!response.ok) {
          throw new Error(`同步文件读取失败: ${response.status}`);
        }

        const payload = (await response.json()) as RuntimePayload;
        const nextFunds = payload.funds.map((runtime: FundRuntimeData) => {
          const persistedState = payload.stateByCode?.[runtime.code];
          const initialModel = persistedState?.model ?? readWatchlistModel(runtime.code);
          const initialJournal = persistedState?.journal ?? readFundJournal(runtime.code);
          const reconciled = reconcileJournal(runtime, initialModel, initialJournal);
          const estimate = estimateWatchlistFund(runtime, reconciled.model);
          const journal = recordEstimateSnapshot(reconciled.journal, runtime, estimate);

          writeWatchlistModel(runtime.code, reconciled.model);
          writeFundJournal(runtime.code, journal);

          return {
            runtime,
            model: reconciled.model,
            journal,
            estimate,
          };
        });

        nextFunds.sort((left, right) => left.runtime.priority - right.runtime.priority);

        if (!active) {
          return;
        }

        setFunds(nextFunds);
        setSyncedAt(payload.syncedAt);
      } catch (loadError) {
        if (!active) {
          return;
        }

        setError(loadError instanceof Error ? loadError.message : '同步失败');
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }

    void loadRuntime();

    const timer = window.setInterval(() => {
      void loadRuntime();
    }, 60_000);

    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  return (
    <div className="app-shell">
      <div className="background-orb background-orb--amber" />
      <div className="background-orb background-orb--teal" />
      <Routes>
        <Route path="/" element={<HomePage funds={funds} syncedAt={syncedAt} loading={loading} error={error} />} />
        <Route path="/fund/:code" element={<DetailPage funds={funds} syncedAt={syncedAt} loading={loading} />} />
      </Routes>
    </div>
  );
}
