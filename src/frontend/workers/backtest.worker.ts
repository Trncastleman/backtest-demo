/// <reference lib="webworker" />

import type { BacktestConfig, BacktestEngineResult, EquityPoint, OhlcvBar, PortfolioBacktestResult, ProjectionResult } from "@/engine/types";
import { runBacktest, runPortfolioBacktest, runForwardTest } from "@/engine/backtest-engine";

// Debug flag - logs are stripped in production
const DEBUG = import.meta.env.DEV;

export interface WorkerStartMessage {
    type: "start";
    id: string;
    config: BacktestConfig;
    bars: OhlcvBar[];
    barsBySymbol?: Record<string, OhlcvBar[]>; // multi-symbol mode
    isForwardTest?: boolean; // if true, run 80/20 forward test
}

export interface WorkerProgressMessage {
    type: "progress";
    id: string;
    percent: number;
    message: string;
}

export interface WorkerResultMessage {
    type: "result";
    id: string;
    result: BacktestEngineResult | PortfolioBacktestResult;
}

export interface WorkerErrorMessage {
    type: "error";
    id: string;
    message: string;
}

export interface WorkerForwardTestResultMessage {
    type: "forwardTestResult";
    id: string;
    result: ProjectionResult;
}

export interface WorkerEquityPointMessage {
    type: "equityPoint";
    id: string;
    point: EquityPoint;
}

export type WorkerOutMessage = WorkerProgressMessage | WorkerResultMessage | WorkerForwardTestResultMessage | WorkerErrorMessage | WorkerEquityPointMessage;

declare const self: DedicatedWorkerGlobalScope;

// Assert no prior handler exists before setting (prevents silent overwrites)
if (self.onmessage !== null) {
    throw new Error("backtest.worker: prior onmessage handler already exists");
}

self.onmessage = (event: MessageEvent<WorkerStartMessage>) => {
    const { type, id, config, bars, barsBySymbol, isForwardTest } = event.data;
    if (type !== "start") return;

    try {
        self.postMessage({ type: "progress", id, percent: 10, message: "Starting engine..." } satisfies WorkerOutMessage);

        const isMultiSymbol = barsBySymbol && Object.keys(barsBySymbol).length > 1;

        if (DEBUG) console.log("[backtest worker] isForwardTest:", isForwardTest, "isMultiSymbol:", isMultiSymbol, "bars length:", bars?.length);

        // Forward test mode: run 80/20 split on single symbol
        if (isForwardTest && !isMultiSymbol) {
            if (bars.length === 0) {
                self.postMessage({
                    type: "error",
                    id,
                    message: "No market data provided",
                } satisfies WorkerOutMessage);
                return;
            }

            self.postMessage({ type: "progress", id, percent: 30, message: "Running historical simulation (80%)..." } satisfies WorkerOutMessage);
            self.postMessage({ type: "progress", id, percent: 60, message: "Running projection simulation (20%)..." } satisfies WorkerOutMessage);

            if (DEBUG) console.log("[backtest worker] ENTERING FORWARD TEST PATH");
            const result = runForwardTest(config, bars);
            if (DEBUG) console.log("[backtest worker] FORWARD TEST RESULT:", result);

            self.postMessage({ type: "progress", id, percent: 90, message: "Finalizing results..." } satisfies WorkerOutMessage);

            if (DEBUG) console.log("[backtest worker] forward test historical stats:", result.historicalStats);
            if (DEBUG) console.log("[backtest worker] forward test projected stats:", result.projectedStats);

            self.postMessage({ type: "forwardTestResult", id, result } satisfies WorkerOutMessage);
            return;
        }

        if (!isMultiSymbol) {
            // Single-symbol mode
            if (bars.length === 0) {
                self.postMessage({
                    type: "error",
                    id,
                    message: "No market data provided",
                } satisfies WorkerOutMessage);
                return;
            }

            self.postMessage({ type: "progress", id, percent: 30, message: "Pre-computing indicators..." } satisfies WorkerOutMessage);
            self.postMessage({ type: "progress", id, percent: 60, message: "Running simulation..." } satisfies WorkerOutMessage);

            // Throttle equity point updates to every 10 bars to avoid flooding the main thread
            let pointCount = 0;
            const result = runBacktest(config, bars, (point) => {
                pointCount++;
                if (pointCount % 10 === 0) {
                    self.postMessage({ type: "equityPoint", id, point } satisfies WorkerOutMessage);
                }
            });
            // Always send the final point to ensure the curve is complete
            if (pointCount > 0 && result.equityCurve.length > 0) {
                const lastPoint = result.equityCurve[result.equityCurve.length - 1];
                if (lastPoint) {
                    self.postMessage({ type: "equityPoint", id, point: lastPoint } satisfies WorkerOutMessage);
                }
            }

            self.postMessage({ type: "progress", id, percent: 90, message: "Finalizing results..." } satisfies WorkerOutMessage);

            if (DEBUG) console.log("[backtest worker] result stats:", result.stats);
            if (DEBUG) console.log("[backtest worker] first trade commission:", result.trades[0]?.commission);

            self.postMessage({ type: "result", id, result } satisfies WorkerOutMessage);
        } else {
            // Multi-symbol portfolio mode
            const totalBars = Object.values(barsBySymbol).reduce((sum, b) => sum + b.length, 0);
            if (totalBars === 0) {
                self.postMessage({
                    type: "error",
                    id,
                    message: "No market data provided for any symbol",
                } satisfies WorkerOutMessage);
                return;
            }

            self.postMessage({ type: "progress", id, percent: 20, message: "Running per-symbol simulations..." } satisfies WorkerOutMessage);

            const result = runPortfolioBacktest(config, barsBySymbol);

            self.postMessage({ type: "progress", id, percent: 90, message: "Finalizing results..." } satisfies WorkerOutMessage);

            if (DEBUG) console.log("[backtest worker] portfolio result combined stats:", result.combinedStats);

            self.postMessage({ type: "result", id, result } satisfies WorkerOutMessage);
        }
    } catch (err) {
        // Always log errors since they indicate serious issues
        console.error("[backtest worker] runBacktest threw:", err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : err);
        self.postMessage({
            type: "error",
            id,
            message: err instanceof Error ? err.message : "Unknown backtest error",
        } satisfies WorkerOutMessage);
    }
};

export {};
