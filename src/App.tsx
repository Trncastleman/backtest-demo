import { useMemo, useState } from "react";
import { Download, FileUp, Play, RefreshCcw } from "lucide-react";
import { runBacktest } from "@/engine/backtest-engine";
import type { BacktestEngineResult, OhlcvBar } from "@/engine/types";
import { barsToCsv, parseOhlcvCsv } from "@/lib/ohlcv/csv";
import { generateSampleBars } from "@/data/sample-data";
import { createDemoConfig, type DemoStrategyId, strategyLabels } from "@/demo-strategies";
import { BacktestChart } from "@/components/BacktestChart";
import { EquityChart } from "@/components/EquityChart";

function formatMoney(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
}

function formatNumber(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return "0";
  return value.toFixed(digits);
}

function formatDate(seconds: number): string {
  return new Date(seconds * 1000).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function App() {
  const [bars, setBars] = useState<OhlcvBar[]>(() => generateSampleBars(1440));
  const [strategy, setStrategy] = useState<DemoStrategyId>("ema-crossover");
  const [initialDeposit, setInitialDeposit] = useState(10_000);
  const [dataLabel, setDataLabel] = useState("Generated EURUSD H1 sample");
  const [uploadError, setUploadError] = useState<string | null>(null);

  const config = useMemo(
    () => createDemoConfig(strategy, initialDeposit),
    [initialDeposit, strategy],
  );

  const run = useMemo<{ result: BacktestEngineResult; error: string | null }>(() => {
    try {
      return { result: runBacktest(config, bars), error: null };
    } catch (err) {
      const fallback = runBacktest(createDemoConfig("ema-crossover", initialDeposit), generateSampleBars(120));
      return {
        result: fallback,
        error: err instanceof Error ? err.message : "Backtest failed",
      };
    }
  }, [bars, config, initialDeposit]);

  const result = run.result;
  const error = uploadError ?? run.error;

  const firstBar = bars[0];
  const lastBar = bars[bars.length - 1];

  function resetSampleData() {
    setBars(generateSampleBars(1440));
      setDataLabel("Generated EURUSD H1 sample");
      setUploadError(null);
  }

  async function handleUpload(file: File | undefined) {
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = parseOhlcvCsv(text);
      if (parsed.length < 50) {
        throw new Error("Upload at least 50 OHLCV rows for a useful backtest.");
      }
      setBars(parsed);
      setDataLabel(file.name);
      setUploadError(null);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Could not parse CSV file.");
    }
  }

  function downloadSampleCsv() {
    const blob = new Blob([barsToCsv(generateSampleBars(1440))], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "sample-eurusd-h1.csv";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  const finalEquity = result.equityCurve[result.equityCurve.length - 1]?.equity ?? initialDeposit;
  const returnPct = ((finalEquity - initialDeposit) / initialDeposit) * 100;
  const avgTradePnl =
    result.trades.length > 0
      ? result.trades.reduce((total, trade) => total + trade.pnl, 0) / result.trades.length
      : 0;

  return (
    <main className="app-shell">
      <section className="hero">
        <div>
          <p className="eyebrow">MetaQuant backtesting concepts</p>
          <h1>React + TypeScript backtest engine demo</h1>
          <p className="hero-copy">
            A public browser demo showing OHLCV ingestion, indicator-driven entry rules,
            trade simulation, equity curves, and chart-based trade review.
          </p>
        </div>
        <div className="hero-panel">
          <span>{bars.length.toLocaleString()} bars</span>
          <strong>{dataLabel}</strong>
          <small>
            {firstBar && lastBar ? `${formatDate(firstBar.time)} - ${formatDate(lastBar.time)}` : "No data loaded"}
          </small>
        </div>
      </section>

      <section className="toolbar" aria-label="Backtest controls">
        <label>
          Strategy
          <select value={strategy} onChange={(event) => setStrategy(event.target.value as DemoStrategyId)}>
            {Object.entries(strategyLabels).map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </label>

        <label>
          Initial deposit
          <input
            min={1000}
            step={500}
            type="number"
            value={initialDeposit}
            onChange={(event) => setInitialDeposit(Number(event.target.value))}
          />
        </label>

        <button type="button" onClick={resetSampleData}>
          <RefreshCcw size={16} />
          Reset sample
        </button>

        <label className="file-button">
          <FileUp size={16} />
          Upload CSV
          <input
            accept=".csv,text/csv"
            type="file"
            onChange={(event) => void handleUpload(event.currentTarget.files?.[0])}
          />
        </label>

        <button type="button" onClick={downloadSampleCsv}>
          <Download size={16} />
          Sample CSV
        </button>

        <button className="primary-button" type="button">
          <Play size={16} />
          Runs instantly
        </button>
      </section>

      {error ? <p className="error">{error}</p> : null}

      <section className="metrics" aria-label="Backtest metrics">
        <Metric label="Final equity" value={formatMoney(finalEquity)} />
        <Metric label="Net profit" value={formatMoney(result.stats.netProfit)} />
        <Metric label="Return" value={`${formatNumber(returnPct)}%`} />
        <Metric label="Trades" value={String(result.stats.totalTrades)} />
        <Metric label="Win rate" value={`${formatNumber(result.stats.winRate * 100)}%`} />
        <Metric label="Max drawdown" value={`${formatNumber(result.stats.maxDrawdown)}%`} />
        <Metric
          label="Profit factor"
          value={result.stats.profitFactor > 999 ? "∞" : formatNumber(result.stats.profitFactor)}
        />
        <Metric label="Avg trade" value={formatMoney(avgTradePnl)} />
      </section>

      <section className="chart-grid">
        <div className="panel wide">
          <div className="panel-header">
            <div>
              <h2>Price and trades</h2>
              <p>Entries and exits are plotted from the MetaQuant-derived backtest engine.</p>
            </div>
          </div>
          <BacktestChart bars={bars} trades={result.trades} />
        </div>

        <div className="panel">
          <div className="panel-header">
            <div>
              <h2>Equity curve</h2>
              <p>Drawdown-aware equity points emitted by the simulation.</p>
            </div>
          </div>
          <EquityChart equityCurve={result.equityCurve} />
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <div>
            <h2>Recent trades</h2>
            <p>Closed trades include commission and configured spread/slippage assumptions.</p>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Entry</th>
                <th>Exit</th>
                <th>Direction</th>
                <th>Entry price</th>
                <th>Exit price</th>
                <th>PnL</th>
              </tr>
            </thead>
            <tbody>
              {result.trades.slice(-10).reverse().map((trade) => (
                <tr key={trade.id}>
                  <td>{formatDate(trade.entryTime)}</td>
                  <td>{formatDate(trade.exitTime)}</td>
                  <td>{trade.direction}</td>
                  <td>{trade.entryPrice.toFixed(5)}</td>
                  <td>{trade.exitPrice.toFixed(5)}</td>
                  <td className={trade.pnl >= 0 ? "positive" : "negative"}>{formatMoney(trade.pnl)}</td>
                </tr>
              ))}
              {result.trades.length === 0 ? (
                <tr>
                  <td colSpan={6}>No closed trades for this strategy/data combination.</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric-card">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
