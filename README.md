# MetaQuant Backtest Demo

<img width="1477" height="944" alt="image" src="https://github.com/user-attachments/assets/a25a0fa3-6ade-4b1e-908e-8071f1df7839" />


Public React + TypeScript demo of MetaQuant's backtesting concepts, with OHLCV data handling, strategy simulation, technical indicators, equity curves, and trade visualization.

This repository is a small, browser-runnable proof project based on the local backtesting layer from MetaQuant. It is intentionally focused on the engine and user-facing backtest review flow rather than the full SaaS product.

## What This Demonstrates

- React + TypeScript interface for running local strategy simulations.
- OHLCV data handling with generated sample candles and CSV upload support.
- Strategy configuration using indicator-driven rule trees.
- MetaQuant-derived backtest engine, indicators, exit logic, and rule evaluator.
- Backtest metrics including net profit, win rate, max drawdown, profit factor, and Sharpe ratio.
- Candlestick chart with entry/exit markers.
- Toggleable entry/exit markers, hidden by default for cleaner chart review.
- Day/week/month/all chart range controls for quick visual zooming.
- Equity curve visualization.
- Trade table for reviewing recent closed trades.

## Tech Stack

- React
- TypeScript
- Vite
- lightweight-charts
- lucide-react
- Vitest-ready project structure

## Run Locally

```bash
npm install
npm run dev
```

Build:

```bash
npm run build
```

## OHLCV Data

The demo uses the same OHLCV bar shape as the MetaQuant engine:

```ts
type OhlcvBar = {
  time: number;   // Unix timestamp in seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};
```

The app starts with generated EURUSD-style H1 sample data. You can also upload a CSV with these columns:

```csv
time,open,high,low,close,volume
1735776000,1.085,1.087,1.083,1.086,1200
```

`time` may be a Unix timestamp, millisecond timestamp, ISO date, or ISO datetime.

## Strategy Examples

The interface includes three simple strategies:

- EMA crossover
- RSI mean reversion
- 36-bar breakout

These are intentionally small presets so the repository stays readable. The underlying engine supports richer rule trees, multiple indicators, position sizing settings, exit rules, spread/slippage assumptions, and higher-timeframe validation.

## What Is Not Included

This public demo does not include the private MetaQuant SaaS surface:

- Authentication and billing
- Stripe Connect marketplace flows
- AI strategy builder sessions
- MQL5 code generation
- MT5/mapi worker pool orchestration
- Cloudflare R2 market-data storage
- Production database schema and tRPC routers

Those pieces belong to the full product. This repo is a focused public demonstration of the local backtesting concepts and frontend review experience.

## Notes
I built this as a public, demo-safe version of backtesting concepts from a private trading SaaS project.
Backtests are simulations, not trading advice. The sample data is generated for demonstration and should not be used for financial decisions.
