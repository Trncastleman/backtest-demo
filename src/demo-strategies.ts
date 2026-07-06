import type { BacktestConfig, RuleNode } from "@/engine/types";

export type DemoStrategyId = "ema-crossover" | "rsi-reversion" | "breakout";

const emaCrossLong: RuleNode = {
  operator: "crosses_above",
  left: { type: "indicator", name: "ema", parameters: { period: 8 } },
  right: { type: "indicator", name: "ema", parameters: { period: 21 } },
};

const rsiLong: RuleNode = {
  operator: "less_than",
  left: { type: "indicator", name: "rsi", parameters: { period: 14 } },
  right: { type: "constant", value: 32 },
};

const breakoutLong: RuleNode = {
  operator: "crosses_above",
  left: { type: "price", field: "close" },
  right: { type: "indicator", name: "highest", parameters: { period: 36 }, shift: 1 },
};

export const strategyLabels: Record<DemoStrategyId, string> = {
  "ema-crossover": "EMA crossover",
  "rsi-reversion": "RSI mean reversion",
  breakout: "36-bar breakout",
};

export function createDemoConfig(strategy: DemoStrategyId, initialDeposit: number): BacktestConfig {
  const ruleByStrategy: Record<DemoStrategyId, RuleNode> = {
    "ema-crossover": emaCrossLong,
    "rsi-reversion": rsiLong,
    breakout: breakoutLong,
  };

  return {
    symbol: "EURUSD",
    symbols: ["EURUSD"],
    timeframe: "H1",
    timeframes: ["H1"],
    fromDate: "2025-01-02",
    toDate: "2025-02-01",
    initialDeposit,
    entryConditions: [
      {
        direction: "long",
        rules: [ruleByStrategy[strategy]],
      },
    ],
    exitRules: {
      takeProfit: 0.0025,
      stopLoss: 0.0018,
      trailingStop: strategy === "breakout" ? 0.0016 : undefined,
    },
    positionSizing: {
      method: "fixed_lot",
      value: 0.1,
    },
    commissionPerLot: 7,
    tickValue: 10,
    slippage: {
      fixedPips: 0.2,
    },
    spread: {
      fixedPips: 0.8,
    },
  };
}
