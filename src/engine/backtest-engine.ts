import type {
    BacktestConfig,
    BacktestEngineResult,
    BacktestEngineStats,
    BacktestTrade,
    EquityPoint,
    OhlcvBar,
    OpenTrade,
    EntryConditionGroup,
    PortfolioBacktestResult,
    ProjectionResult,
    SymbolBacktestResult,
    TradeDirection,
    WalkForwardConfig,
    WalkForwardResult,
    WalkForwardSegment,
    RuleNode,
} from "./types";
import { evaluateAllRules, evaluateEntryConditions } from "./rule-evaluator";
import {
    calculateTpSl,
    checkExit,
    shouldActivateTrailingStop,
} from "./exit-logic";
import { computeIndicator, IndicatorName } from "./indicators";
import type { IndicatorValues } from "./rule-evaluator";
import { LOCAL_ENGINE_TIMEFRAMES, isLocalEngineTimeframe } from "@/lib/backtest-capabilities";

// Commission and tick values — configured per-broker via BacktestConfig.
// Fallbacks match typical EURUSD broker costs; override via commissionPerLot/tickValue.
const COMMISSION_PER_LOT_DEFAULT = 7.0; // $7 per lot round-trip
const TICK_VALUE_DEFAULT = 10; // $10 per pip per lot

// Bars per day for each timeframe (based on 24h forex market, 5-day week)
// M5: 288 (12 per hour * 24 hours), M15: 96, M30: 48, H1: 24, H4: 6, D1: 1
const BARS_PER_DAY: Record<string, number> = {
    "M1": 1440, "M5": 288, "M15": 96, "M30": 48, "H1": 24, "H2": 12, "H4": 6, "D1": 1, "W1": 1 / 7,
};
const TRADING_DAYS_PER_YEAR = 252; // A-27: standard trading days for annualization

// Debug flag for development builds - guards expensive logging operations
const DEBUG = import.meta.env.DEV;

// Debug logging function - calls console.log in development, no-op in production
const debugLog = (...args: unknown[]): void => {
    if (DEBUG) console.log(...args);
};

/** Normalize call/put to long/short for PnL and trailing stop calculations.
 * call behaves like long (profit when price rises, TP up, SL down).
 * put behaves like short (profit when price falls, TP down, SL up). */
function normalizePnLDirection(direction: TradeDirection): "long" | "short" {
    if (direction === "call") return "long";
    if (direction === "put") return "short";
    return direction;
}

/** Returns the price increment that equals 1 pip for a given symbol.
 * JPY pairs (USDJPY, GBPJPY, etc.) quote to 2 decimal places: 1 pip = 0.01.
 * Others quote to 4-5 decimal places: 1 pip = 0.0001. */
function getPipSize(symbol: string): number {
    return symbol.endsWith("JPY") ? 0.01 : 0.0001;
}

/**
 * Compute total slippage in price units for a given direction.
 * Combines fixed slippage and ATR-volatility-scaled slippage.
 * Slippage worsens fill price: longs enter higher, shorts enter lower.
 *
 * NOTE (A-24): Slippage is currently independent of order size — no market impact
 * model is applied. To model market impact, scale by sqrt(lotSize / referenceLot).
 */
function computeSlippage(
    config: BacktestConfig,
    atrValue: number | null | undefined,
    pipSize: number
): number {
    const sc = config.slippage;
    if (!sc) return 0;
    const fixedPips = sc.fixedPips ?? 0;
    const atrMult = sc.atrMultiplier ?? 0;
    const atrSlipPips = atrMult > 0 && atrValue != null ? (atrValue / pipSize) * atrMult : 0;
    return (fixedPips + atrSlipPips) * pipSize;
}

/**
 * Compute spread cost in price units (applied as additional entry/exit cost per lot).
 * Spread is paid twice per round trip (entry + exit).
 */
function computeSpreadCost(
    config: BacktestConfig,
    pipSize: number
): number {
    const sp = config.spread;
    if (!sp || !sp.fixedPips) return 0;
    return sp.fixedPips * 2 * pipSize; // round-trip: entry + exit
}

export function generateId(): string {
    // Use crypto for cryptographically secure random IDs (works in browser/web worker contexts)
    const array = new Uint8Array(8);
    const global = globalThis as typeof globalThis & { crypto?: Crypto; msCrypto?: Crypto };
    const cryptoObj = global.crypto ?? global.msCrypto;
    if (!cryptoObj?.getRandomValues) {
        throw new Error("crypto.getRandomValues is not available — cannot generate deterministic backtest IDs");
    }
    cryptoObj.getRandomValues(array);
    return Array.from(array, (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 9);
}

function computeAllIndicators(
    bars: OhlcvBar[],
    config: BacktestConfig,
    currentSymbol?: string
): { indicators: IndicatorValues; incomplete: boolean } {
    const indicators: IndicatorValues = {};
    const seen = new Set<string>();
    let incomplete = false;

    // Collect all indicator names from ALL groups (no currentSymbol filtering).
    // This is needed for leader-follower strategies where a GBPUSD group contains
    // EURUSD operands — those EURUSD indicators must be collected when EURUSD
    // bars are being processed so resolveOperand can find them.
    function collectIndicators(entryConditions: EntryConditionGroup[]): void {
        for (const group of entryConditions) {
            for (const rule of group.rules) {
                collectFromNode(rule as Record<string, unknown>);
            }
        }
    }

    /** Serialize indicator params to a stable string key, e.g. "period=50" */
    function paramsKey(params: Record<string, number | string>): string {
        return Object.entries(params)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => `${k}=${v}`)
            .join("&");
    }

    /** Unique storage key for an indicator+params combo, e.g. "EURUSD_EMA_period=50" */
    function indicatorKey(name: string, params: Record<string, number | string>): string {
        const pk = paramsKey(params);
        // Always lowercase the indicator name to ensure consistent lookups
        const normalizedName = String(name || "").toLowerCase();
        // Include symbol in key to prevent cross-symbol cache collisions
        const symbolPrefix = currentSymbol ? `${currentSymbol}_` : "";
        return pk ? `${symbolPrefix}${normalizedName}_${pk}` : `${symbolPrefix}${normalizedName}`;
    }

    function collectFromNode(node: Record<string, unknown>, depth: number = 0): void {
        // Guard against deeply nested condition trees causing stack overflow
        if (depth > 100) {
            console.warn("[backtest] collectFromNode: max depth exceeded, skipping remaining conditions");
            incomplete = true;
            return;
        }
        if (node["operator"] === "and" || node["operator"] === "or") {
            for (const c of (node["conditions"] as Record<string, unknown>[])) collectFromNode(c, depth + 1);
        } else if (node["operator"] === "not") {
            collectFromNode(node["condition"] as Record<string, unknown>, depth + 1);
        } else {
            const left = node["left"] as Record<string, unknown> | undefined;
            const right = node["right"] as Record<string, unknown> | undefined;
            for (const op of [left, right]) {
                if (op && op["type"] === "indicator") {
                    const name = op["name"] as string;
                    const params = (op["parameters"] ?? {}) as Record<string, number | string>;
                    const key = indicatorKey(name, params);
                    if (!seen.has(key)) {
                        seen.add(key);
                        const result = computeIndicator(bars, name as IndicatorName, params);
                        indicators[key] = result.values;
                        if (result.outputs) {
                            for (const [outKey, vals] of Object.entries(result.outputs)) {
                                indicators[`${key}_${outKey}`] = vals;
                            }
                        }
                    }
                }
            }
        }
    }

    collectIndicators(config.entryConditions);
    return { indicators, incomplete };
}

/**
 * Aggregate lower timeframe bars into a higher timeframe.
 * For example, H1 bars -> H4 bars by grouping every 4 candles.
 * Returns bars aligned to the higher timeframe timestamps.
 */
function aggregateToHigherTimeframe(bars: OhlcvBar[], multiplier: number): OhlcvBar[] {
    if (bars.length < multiplier) return [];
    const result: OhlcvBar[] = [];

    for (let i = 0; i <= bars.length - multiplier; i += multiplier) {
        const group = bars.slice(i, i + multiplier);
        const open = group[0].open;
        // Use reduce loop instead of Math.max/min with spread to avoid dynamic allocation
        let high = group[0].high;
        let low = group[0].low;
        let volume = 0;
        for (const b of group) {
            if (b.high > high) high = b.high;
            if (b.low < low) low = b.low;
            volume += b.volume;
        }
        const close = group[group.length - 1].close;
        const time = group[0].time; // Use first bar's timestamp

        result.push({ time, open, high, low, close, volume });
    }

    return result;
}

/**
 * Validates that all timeframes specified in config and rules are supported
 * by the local engine, and that any non-primary timeframes aggregate cleanly
 * from the primary timeframe.
 */
export function validateTimeframes(config: BacktestConfig): void {
    // Helper to extract timeframes from a rule tree
    function extractTimeframes(rule: RuleNode, list: string[]): void {
        switch (rule.operator) {
            case "and":
            case "or":
                for (const condition of rule.conditions) {
                    extractTimeframes(condition, list);
                }
                return;
            case "not":
                extractTimeframes(rule.condition, list);
                return;
            default:
                if (rule.left.type === "indicator" && rule.left.timeframe) {
                    list.push(rule.left.timeframe);
                }
                if (rule.right.type === "indicator" && rule.right.timeframe) {
                    list.push(rule.right.timeframe);
                }
        }
    }

    if (!isLocalEngineTimeframe(config.timeframe)) {
        throw new Error(
            `Invalid primary timeframe: ${config.timeframe}. ` +
            `Supported local engine timeframes: ${LOCAL_ENGINE_TIMEFRAMES.join(", ")}`
        );
    }

    const timeframesToCheck: string[] = [config.timeframe];

    // 1. config.timeframes[]
    if (config.timeframes) {
        for (const tf of config.timeframes) {
            timeframesToCheck.push(tf);
        }
    }

    // 2. config.entryConditions[].timeframe and rules
    if (config.entryConditions) {
        for (const group of config.entryConditions) {
            if (group.timeframe) {
                timeframesToCheck.push(group.timeframe);
            }
            if (group.rules) {
                for (const rule of group.rules) {
                    extractTimeframes(rule, timeframesToCheck);
                }
            }
        }
    }

    // Check capability set
    for (const tf of timeframesToCheck) {
        if (!isLocalEngineTimeframe(tf)) {
            throw new Error(`Timeframe '${tf}' is not in the local engine capability set. Supported: ${LOCAL_ENGINE_TIMEFRAMES.join(", ")}`);
        }
    }

    // Check non-primary timeframe aggregation
    const primaryTf = config.timeframe;
    const primaryBarsPerDay = BARS_PER_DAY[primaryTf];
    if (primaryBarsPerDay === undefined) {
        throw new Error(`Invalid primary timeframe: ${primaryTf}`);
    }

    for (const tf of timeframesToCheck) {
        if (tf === primaryTf) continue;

        const targetBarsPerDay = BARS_PER_DAY[tf];
        const aggMul = primaryBarsPerDay / targetBarsPerDay;

        // If a non-primary timeframe is used locally:
        // - it must be higher than the primary timeframe (targetBarsPerDay < primaryBarsPerDay, which means aggMul > 1)
        // - and aggregate by an integer multiplier (aggMul must be an integer)
        if (aggMul < 1 || !Number.isInteger(aggMul)) {
            throw new Error(`Timeframe '${tf}' is not compatible with primary timeframe '${primaryTf}'. Non-primary timeframes must be higher than the primary timeframe and aggregate by an integer multiplier.`);
        }
    }
}

/**
 * Pre-compute indicators for all timeframes.
 * Returns a map of timeframe -> indicators.
 *
 * Uses a direct bars-per-day approach to handle any timeframe pair generically.
 * For example, H1 primary with D1 target: 24 H1 bars aggregate into 1 D1 bar.
 * For M15 primary with H4 target: 4 M15 bars aggregate into 1 H4 bar.
 */
function computeIndicatorsForTimeframes(
    primaryBars: OhlcvBar[],
    config: BacktestConfig
): Map<string, IndicatorValues> {
    const result = new Map<string, IndicatorValues>();

    // Always compute for primary timeframe
    const primaryResult = computeAllIndicators(primaryBars, config);
    if (primaryResult.incomplete) {
        throw new Error("[backtest] Primary timeframe indicator computation incomplete — entry conditions may be nested too deeply (max depth 100)");
    }
    result.set(config.timeframe, primaryResult.indicators);

    // Compute for additional timeframes if specified
    for (const tf of config.timeframes) {
        if (tf === config.timeframe) continue;

        const primaryBarsPerDay = BARS_PER_DAY[config.timeframe];
        const targetBarsPerDay = BARS_PER_DAY[tf];

        // Fail loudly on invalid timeframe — don't silently skip
        if (primaryBarsPerDay === undefined) throw new Error(`Invalid primary timeframe: ${config.timeframe}`);
        if (targetBarsPerDay === undefined) throw new Error(`Invalid timeframe: ${tf}`);

        // aggMul = how many primary bars aggregate into one target bar
        // If primary is finer (more bars/day) than target, aggMul > 1 (aggregate up)
        // If primary is coarser (fewer bars/day) than target, aggMul < 1 (aggregate down)
        const aggMul = primaryBarsPerDay / targetBarsPerDay;

        // Only aggregate when aggMul >= 1 and is a whole number (must group complete bars)
        // For aggMul < 1 (e.g., M15 primary + H1 target), we can't disaggregate
        if (aggMul < 1 || !Number.isInteger(aggMul)) continue;

        const aggregatedBars = aggregateToHigherTimeframe(primaryBars, aggMul);
        if (aggregatedBars.length > 0) {
            const aggConfig: BacktestConfig = {
                ...config,
                timeframe: tf,
            };
            const aggResult = computeAllIndicators(aggregatedBars, aggConfig);
            if (aggResult.incomplete) {
                throw new Error(`[backtest] HTF indicator computation incomplete for ${tf} — entry conditions may be nested too deeply (max depth 100)`);
            }
            result.set(tf, aggResult.indicators);
        }
    }

    return result;
}

function calculateLotSize(
    method: BacktestConfig["positionSizing"]["method"],
    value: number,
    equity: number,
    entryPrice: number,
    slDistance: number,
    pipSize: number,
    tickValue: number
): number {
    if (value <= 0) {
        if (value === 0 && method === "percentage_equity") {
            return 0; // intentionally risk 0% — no trade
        }
        console.warn(`[backtest] positionSizing.value=${value} is not positive — clamping to 0.01`);
        return 0.01;
    }

    switch (method) {
        case "fixed_lot":
            return value;
        case "percentage_equity": {
            // value is a fraction (0.01 = 1%), but AI may send 1 to mean "1%"
            // Treat values > 1 as percentages: value=1 → 0.01 fraction → 1% of equity
            if (value > 1) {
                console.warn(`[backtest] positionSizing.value=${value} > 1 — treating as ${value / 100} (fraction = ${value}% of equity). Use value=0.01 for 1% to avoid ambiguity.`);
            }
            const fraction = value > 1 ? value / 100 : value;
            const riskAmount = equity * fraction;
            // slDistance is in price units; convert to pips using pipSize.
            // $ risk per lot = slDistance_pips * tickValue = (slDistance / pipSize) * tickValue
            if (slDistance <= 0) return 0.01;
            const lotSize = riskAmount * pipSize / (slDistance * tickValue);
            return Math.max(0.01, Math.min(10, lotSize));
        }
        case "dynamic":
            return value; // fixed risk multiplier, use as lot
    }
}

function computeStats(trades: BacktestTrade[], initialDeposit: number, timeframe: string): BacktestEngineStats {
    if (trades.length === 0) {
        return {
            netProfit: 0,
            totalTrades: 0,
            winRate: 0,
            maxDrawdown: 0,
            sharpeRatio: 0,
            sortinoRatio: 0,
            cagr: 0,
            profitFactor: 0,
            avgWin: 0,
            avgLoss: 0,
            timeframe,
        };
    }

    // Single-pass accumulator: compute all stats in one iteration
    let totalTrades = 0, netProfit = 0, grossWins = 0, grossLosses = 0, maxDrawdown = 0;
    let winningTrades = 0, losingTrades = 0, largestWin = 0, largestLoss = 0;
    let peak = initialDeposit;
    let equity = initialDeposit;
    const returns: number[] = [];
    const downsideReturns: number[] = [];
    let firstTradeTime = 0;
    let lastTradeTime = 0;

    for (const t of trades) {
        if (firstTradeTime === 0) firstTradeTime = t.entryTime;
        lastTradeTime = t.exitTime;
        totalTrades++;
        netProfit += t.pnl;

        if (t.pnl > 0) {
            grossWins += t.pnl;
            winningTrades++;
            if (t.pnl > largestWin) largestWin = t.pnl;
        } else {
            grossLosses += Math.abs(t.pnl);
            losingTrades++;
            if (t.pnl < largestLoss) largestLoss = Math.abs(t.pnl);
        }

        // Equity curve for max drawdown and sharpe
        equity += t.pnl;
        if (equity > peak) peak = equity;
        // maxDrawdown stored as percentage (0-100) to match BacktestEngineStats contract
        const dd = ((peak - equity) / peak) * 100;
        if (dd > maxDrawdown) maxDrawdown = dd;
        if (t.pnl !== 0) {
            // A-10: Use log returns for Sharpe/Sortino (more accurate for large returns)
            const simpleReturn = t.pnl / equity;
            const ret = Math.log(1 + simpleReturn);
            returns.push(ret);
            if (simpleReturn < 0) downsideReturns.push(ret);
        }
    }

    const winRate = totalTrades > 0 ? winningTrades / totalTrades : 0;
    const avgWin = winningTrades > 0 ? grossWins / winningTrades : 0;
    const avgLoss = losingTrades > 0 ? grossLosses / losingTrades : 0;
    const profitFactor = grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? 999999 : 0;

    // Sharpe ratio: annualize using bars-per-year for the current timeframe
    const barsPerYear = (BARS_PER_DAY[timeframe] ?? 24) * TRADING_DAYS_PER_YEAR;
    const MAR = 0.02; // Minimum acceptable return — 2% risk-free rate (matches Python reference)
    let sharpeRatio = 0;
    let sortinoRatio = 0;
    if (returns.length > 0) {
        const meanReturn = returns.reduce((s, r) => s + r, 0) / returns.length;
        const variance = returns.reduce((s, r) => s + (r - meanReturn) ** 2, 0) / returns.length;
        const stdReturn = Math.sqrt(variance);
        sharpeRatio = stdReturn > 0 ? (meanReturn / stdReturn) * Math.sqrt(barsPerYear) : 0;

        // A-09: Sortino uses downside deviation with excess return over MAR
        if (downsideReturns.length > 0) {
            // B-01 fix: variance must apply MAR to each return, not just the numerator
            const downsideVariance = downsideReturns.reduce((s, r) => s + (r - MAR) * (r - MAR), 0) / downsideReturns.length;
            const downsideStd = Math.sqrt(downsideVariance);
            sortinoRatio = downsideStd > 0 ? ((meanReturn - MAR) / downsideStd) * Math.sqrt(barsPerYear) : 0;
        }
    }

    // CAGR: compound annual growth rate
    let cagr = 0;
    if (firstTradeTime > 0 && lastTradeTime > firstTradeTime) {
        const years = (lastTradeTime - firstTradeTime) / (365.25 * 24 * 3600);
        if (years > 0) {
            const endingEquity = initialDeposit + netProfit;
            // A-08: guard against non-positive ending equity
            if (endingEquity > 0) {
                cagr = Math.pow(endingEquity / initialDeposit, 1 / years) - 1;
            } else {
                // B-04 fix: sentinel -1 for failed/depleted strategies (not confusable with breakeven = 0)
                cagr = -1;
            }
        }
    }

    return {
        netProfit,
        totalTrades,
        winRate,
        maxDrawdown,
        sharpeRatio,
        sortinoRatio,
        cagr,
        profitFactor,
        avgWin,
        avgLoss,
        timeframe,
    };
}

/**
 * Run a backtest over OHLCV bars with the given configuration.
 *
 * Entry: all rules in the matching direction's group must pass (AND logic).
 * Only closed candles are used (no repainting).
 * One open position maximum at a time.
 *
 * Supports multi-timeframe: if config.timeframes has higher timeframes (e.g. H4),
 * their indicators are computed and checked during entry evaluation.
 */
export function runBacktest(
    config: BacktestConfig,
    bars: OhlcvBar[],
    onEquityPoint?: (point: EquityPoint) => void
): BacktestEngineResult {
    if (bars.length === 0) {
        debugLog("[backtest] ERROR: bars.length = 0");
        return {
            trades: [],
            equityCurve: [],
            stats: computeStats([], config.initialDeposit, config.timeframe),
        };
    }

    // Run timeframe/aggregation validation
    validateTimeframes(config);

    // Fail loudly on invalid primary timeframe up front
    if (BARS_PER_DAY[config.timeframe] === undefined) {
        throw new Error(`Invalid primary timeframe: ${config.timeframe}`);
    }

    if (DEBUG) {
        console.log("[backtest] Starting backtest:", {
            symbol: config.symbol,
            timeframe: config.timeframe,
            barCount: bars.length,
            entryConditionCount: config.entryConditions.length,
            exitRules: config.exitRules,
            positionSizing: config.positionSizing,
        });
    }

    // Precompute indicators for all timeframes
    const indicatorsByTimeframe = computeIndicatorsForTimeframes(bars, config);
    const primaryIndicators = indicatorsByTimeframe.get(config.timeframe) ?? {};

    if (DEBUG) {
        const allKeys = Object.keys(primaryIndicators);
        console.log("[backtest] Primary indicators keys:", allKeys.slice(0, 30));
        // Log stochastic values if present
        const stochKey = allKeys.find(k => k.toLowerCase().startsWith("stochastic"));
        if (stochKey) {
            const kVals = primaryIndicators[stochKey];
            const dKey = allKeys.find(k => k.startsWith(stochKey.split("_")[0]) && k.includes("_d"));
            const dVals = dKey ? primaryIndicators[dKey] : null;
            // Find bars where BOTH conditions of a long entry fire simultaneously
            let longSignalCount = 0;
            let sampleLogs = "";
            for (let i = 15; i < Math.min(bars.length, 500); i++) {
                const k = kVals?.[i];
                const d = dVals?.[i];
                const kPrev = kVals?.[i-1];
                const dPrev = dVals?.[i-1];
                if (k !== null && k !== undefined && d !== null && d !== undefined &&
                    kPrev !== null && kPrev !== undefined && dPrev !== null && dPrev !== undefined) {
                    const kLess20 = k < 20;
                    const crossUp = kPrev <= dPrev && k > d;
                    if (kLess20 && crossUp) {
                        longSignalCount++;
                        if (longSignalCount <= 5) {
                            sampleLogs += `\n  LONG bar ${i}: k=${k.toFixed(1)} d=${d.toFixed(1)} (oversold+crossover!)`;
                        }
                    }
                }
            }
            console.log(`[backtest] ${stochKey} LONG entry candidates (k<20 AND cross above d, bars 15-500): ${longSignalCount}${sampleLogs}`);
        }
        // Log entry conditions summary
        for (const group of config.entryConditions) {
            console.log(`[backtest] EntryGroup[${group.direction}]:`, JSON.stringify(group.rules).substring(0, 300));
        }
    }

    // ATR for exit rules — use the period from stopLossAtr or takeProfitAtr (default 14)
    // Use explicit !== undefined checks: period 0 is falsy but valid
    const atrPeriod = config.exitRules.stopLossAtr?.period !== undefined
        ? config.exitRules.stopLossAtr.period
        : config.exitRules.takeProfitAtr?.period !== undefined
        ? config.exitRules.takeProfitAtr.period
        : 14;
    const atrValues = computeIndicator(bars, "atr", { period: atrPeriod }).values;

    // Build index mapping for higher timeframe lookups
    const higherTimeframeIndicators = new Map<string, { indicators: IndicatorValues; multiplier: number }>();

    for (const tf of config.timeframes) {
        if (tf === config.timeframe) continue;
        const aggIndicators = indicatorsByTimeframe.get(tf);
        if (aggIndicators) {
            const primaryBarsPerDay = BARS_PER_DAY[config.timeframe];
            const targetBarsPerDay = BARS_PER_DAY[tf];
            // Fail loudly on invalid timeframe
            if (primaryBarsPerDay === undefined) throw new Error(`Invalid primary timeframe: ${config.timeframe}`);
            if (targetBarsPerDay === undefined) throw new Error(`Invalid timeframe: ${tf}`);
            // How many primary bars aggregate into one target bar
            // aggMul < 1 means target is higher timeframe — cannot aggregate down, skip
            const aggMul = primaryBarsPerDay / targetBarsPerDay;
            if (aggMul < 1) continue;
            higherTimeframeIndicators.set(tf, { indicators: aggIndicators, multiplier: aggMul });
        }
    }

    const trades: BacktestTrade[] = [];
    const equityCurve: EquityPoint[] = [];

    let equity = config.initialDeposit;
    let peak = equity;
    let maxDrawdown = 0;

    // Active open trade (single position at a time)
    let openTrade: OpenTrade | null = null;
    // Track if we exited on the current bar — prevents same-bar re-entry
    let justExited = false;

    for (let i = 0; i < bars.length; i++) {
        // Reset exit flag at start of each bar
        justExited = false;

        // ── Check exits first ─────────────────────────────────────────────
        if (openTrade) {
            const exitResult = checkExit(openTrade, bars, i, config.exitRules);
            const dir = normalizePnLDirection(openTrade.direction);

            // Update trailing stop tracking for long
            if (dir === "long" && bars[i].high > openTrade.highestPrice) {
                openTrade.highestPrice = bars[i].high;
            }
            if (dir === "short" && bars[i].low < openTrade.lowestPrice) {
                openTrade.lowestPrice = bars[i].low;
            }

            // Activate trailing stop
            if (
                !openTrade.trailingStopActivated &&
                shouldActivateTrailingStop(openTrade, bars[i])
            ) {
                openTrade.trailingStopActivated = true;
            }

            // ── Accrue borrow cost for short positions ─────────────────────────
            if (openTrade.borrowRate > 0 && i > 0) {
                const barDurationSeconds = bars[i].time - bars[i - 1]!.time;
                const notionalValue = openTrade.entryPrice * openTrade.lotSize * 100_000;
                openTrade.borrowCost += notionalValue * openTrade.borrowRate * (barDurationSeconds / (365.25 * 24 * 3600));
            }

            if (exitResult.hit) {
                const exitPrice =
                    exitResult.reason === "tp"
                        ? openTrade.tp!
                        : exitResult.reason === "sl"
                        ? openTrade.sl!
                        : dir === "long"
                        ? openTrade.highestPrice - (openTrade.trailingStop ?? 0)
                        : openTrade.lowestPrice + (openTrade.trailingStop ?? 0);

                const pipSize = getPipSize(config.symbol);
                // A-04: Apply directional slippage to exit prices — longs exit lower, shorts exit higher
                const exitSlippage = computeSlippage(config, null, pipSize);
                const slippedExitPrice = dir === "long" ? exitPrice - exitSlippage : exitPrice + exitSlippage;
                const priceDiff = dir === "long"
                    ? slippedExitPrice - openTrade.entryPrice
                    : openTrade.entryPrice - slippedExitPrice;
                const pnl = (priceDiff / pipSize) * openTrade.lotSize * openTrade.tickValue - openTrade.commission - openTrade.spreadCost - openTrade.borrowCost;

                equity += pnl;
                equity = Math.round(equity * 100) / 100;
                if (equity > peak) peak = equity;
                const dd = ((peak - equity) / peak) * 100;
                if (dd > maxDrawdown) maxDrawdown = dd;

                trades.push({
                    id: openTrade.id,
                    entryTime: openTrade.entryTime,
                    exitTime: bars[i].time,
                    direction: openTrade.direction,
                    entryPrice: openTrade.entryPrice,
                    exitPrice: slippedExitPrice,
                    lotSize: openTrade.lotSize,
                    pnl,
                    commission: openTrade.commission,
                });

                if (DEBUG) {
                    const pipValue = dir === "long"
                        ? (slippedExitPrice - openTrade.entryPrice) * 10000
                        : (openTrade.entryPrice - slippedExitPrice) * 10000;
                    console.log(`[backtest] EXIT ${exitResult.reason?.toUpperCase()} bar ${i} (${new Date(bars[i].time * 1000).toISOString()}): ${openTrade.direction} ${pipValue.toFixed(1)} pips, entry=${openTrade.entryPrice.toFixed(5)} exit=${slippedExitPrice.toFixed(5)} tp=${openTrade.tp?.toFixed(5)} sl=${openTrade.sl?.toFixed(5)} pnl=${pnl.toFixed(2)}`);
                }

                openTrade = null;
                justExited = true;
            }
        }

        // ── Check entries ──────────────────────────────────────────────────
        // Skip entry check if we just exited on this bar — prevents same-bar re-entry
        if (!openTrade && !justExited) {
            // Evaluate direction-aware entry signals, using per-group timeframe indicators
            // Pass config.symbol as currentSymbol to filter to groups matching this symbol
            const pipSize = getPipSize(config.symbol);
            const signals = evaluateEntryConditions(
                config.entryConditions,
                bars,
                i,
                primaryIndicators,
                higherTimeframeIndicators,
                undefined, // indicatorsBySymbol (not used in single-symbol mode)
                config.symbol, // currentSymbol for multi-symbol filtering
                pipSize,
                config.timeframe
            );

            // Determine which direction(s) are signalled
            // call is like long, put is like short — call takes precedence over long,
            // put takes precedence over short (more specific direction wins)
            let direction: TradeDirection | null = null;
            if (signals.call) direction = "call";
            else if (signals.long && !signals.put) direction = "long";
            else if (signals.put) direction = "put";
            else if (signals.short) direction = "short";

            if (i > 0 && i % 100 === 0) {
                debugLog(`[backtest] bar ${i} signals: long=${signals.long} short=${signals.short} call=${signals.call} put=${signals.put} direction=${direction}`);
            }

            if (direction) {
                const pipSize = getPipSize(config.symbol);
                const slippage = computeSlippage(config, atrValues[i], pipSize);
                const normalizedDir = normalizePnLDirection(direction);
                const entryPrice = bars[i].close + (normalizedDir === "long" ? slippage : -slippage);
                debugLog(`[backtest] ENTRY at bar ${i} (${new Date(bars[i].time * 1000).toISOString()}): ${direction} @ ${bars[i].close} slippage=${slippage.toFixed(5)} => ${entryPrice.toFixed(5)}`);
                // Use ATR-based SL if available; during warmup (null ATR), use the first
                // available ATR value as a conservative estimate.
                // If no ATR is available at all, throw — the 2% fallback silently corrupts results.
                const slDistance = config.exitRules.stopLoss ?? (() => {
                    if (atrValues[i] !== null && atrValues[i] !== undefined) {
                        return atrValues[i]!;
                    }
                    const firstValidAtr = atrValues.find((v) => v !== null && v !== undefined);
                    if (firstValidAtr !== undefined) return firstValidAtr;
                    throw new Error(
                        `[backtest] No ATR available during warmup at index ${i} ` +
                        `(${bars[i].time}). Provide explicit stopLoss or ensure bar history ` +
                        `exceeds ATR period (${atrPeriod}) before the first entry signal.`
                    );
                })();
                if (DEBUG) {
                    const atrVal = atrValues[i];
                    console.log(`[backtest]   atrValues[${i}]=${atrVal != null ? atrVal.toFixed(5) : "null/undefined"}, slDistance=${slDistance.toFixed(5)}, method=${config.positionSizing.method}, value=${config.positionSizing.value}`);
                }
                const lotSize = calculateLotSize(
                    config.positionSizing.method,
                    config.positionSizing.value,
                    equity,
                    entryPrice,
                    slDistance,
                    getPipSize(config.symbol),
                    config.tickValue ?? TICK_VALUE_DEFAULT
                );

                // ── Volume-aware fill check ─────────────────────────────────────
                const effectiveLotSize = (() => {
                    const fm = config.fillModel;
                    if (!fm || fm.fillRatio <= 0) return lotSize;
                    const MAX_LOTS_PER_BAR = bars[i].volume * fm.fillRatio / 100_000;
                    if (lotSize > MAX_LOTS_PER_BAR) {
                        console.warn(`[backtest] bar ${i}: lotSize ${lotSize.toFixed(2)} exceeds volume-cap ${MAX_LOTS_PER_BAR.toFixed(2)} (vol=${bars[i].volume}, fillRatio=${fm.fillRatio}), scaling down`);
                        return Math.max(0.01, MAX_LOTS_PER_BAR);
                    }
                    return lotSize;
                })();

                const commission = (config.commissionPerLot ?? COMMISSION_PER_LOT_DEFAULT) * effectiveLotSize;
                const spreadCost = computeSpreadCost(config, pipSize) * effectiveLotSize;
                debugLog(`[backtest]   lotSize=${lotSize}, commission=${commission.toFixed(2)}, spreadCost=${spreadCost.toFixed(2)}`);

                const { tp, sl } = calculateTpSl(
                    entryPrice,
                    normalizePnLDirection(direction),
                    config.exitRules,
                    // A-07: Use slDistance (fallback ATR) when atrValues[i] is null during warmup
                    atrValues[i] ?? (slDistance > 0 ? slDistance : null)
                );
                debugLog(`[backtest]   TP=${tp?.toFixed(5) ?? "none"}, SL=${sl?.toFixed(5) ?? "none"}, TS=${config.exitRules.trailingStop}`);

                openTrade = {
                    id: generateId(),
                    entryTime: bars[i].time,
                    direction,
                    entryPrice,
                    lotSize: effectiveLotSize,
                    commission,
                    spreadCost,
                    tickValue: config.tickValue ?? TICK_VALUE_DEFAULT,
                    borrowCost: 0,
                    borrowRate: config.shortConfig?.borrowRate ?? 0,
                    tp,
                    sl,
                    trailingStop: config.exitRules.trailingStop,
                    trailingStopActivated: false,
                    highestPrice: entryPrice,
                    lowestPrice: entryPrice,
                };
            }
        }

        // Record equity point at bar close
        const dd = equity > 0 ? ((peak - equity) / peak) * 100 : 0;
        const point = { time: bars[i].time, equity, drawdown: dd };
        equityCurve.push(point);
        onEquityPoint?.(point);
    }

    // ── EOF: Close any open trade at last bar's close with unrealized PnL ──────
    if (openTrade) {
        const lastBar = bars[bars.length - 1];
        const exitPrice = lastBar.close;
        const pipSize = getPipSize(config.symbol);
        const dir = normalizePnLDirection(openTrade.direction);
        const priceDiff = dir === "long"
            ? exitPrice - openTrade.entryPrice
            : openTrade.entryPrice - exitPrice;
        const pnl = (priceDiff / pipSize) * openTrade.lotSize * openTrade.tickValue - openTrade.commission - openTrade.spreadCost - openTrade.borrowCost;

        equity += pnl;
        equity = Math.round(equity * 100) / 100;
        if (equity > peak) peak = equity;
        const dd = ((peak - equity) / peak) * 100;
        if (dd > maxDrawdown) maxDrawdown = dd;

        // B-05 fix: replace last equity point if same timestamp (trade closed on same bar it opened)
        const lastPoint = equityCurve[equityCurve.length - 1];
        if (lastPoint && lastPoint.time === lastBar.time) {
            lastPoint.equity = equity;
            lastPoint.drawdown = dd;
        } else {
            equityCurve.push({ time: lastBar.time, equity, drawdown: dd });
        }
        onEquityPoint?.({ time: lastBar.time, equity, drawdown: dd });

        trades.push({
            id: openTrade.id,
            entryTime: openTrade.entryTime,
            exitTime: lastBar.time,
            direction: openTrade.direction,
            entryPrice: openTrade.entryPrice,
            exitPrice,
            lotSize: openTrade.lotSize,
            pnl,
            commission: openTrade.commission,
        });

        if (DEBUG) {
            const pipValue = dir === "long"
                ? (exitPrice - openTrade.entryPrice) * 10000
                : (openTrade.entryPrice - exitPrice) * 10000;
            console.log(`[backtest] EOF EXIT ${openTrade.direction} ${pipValue.toFixed(1)} pips, entry=${openTrade.entryPrice.toFixed(5)} exit=${exitPrice.toFixed(5)} unrealized_pnl=${pnl.toFixed(2)}`);
        }
    }

    if (DEBUG) {
        const stats = {
            ...computeStats(trades, config.initialDeposit, config.timeframe),
            maxDrawdown,
        };
        const wins = trades.filter(t => t.pnl > 0).length;
        const losses = trades.filter(t => t.pnl <= 0).length;
        console.log(`[backtest] COMPLETE: ${trades.length} trades, wins=${wins} losses=${losses}, netProfit=${stats.netProfit.toFixed(2)}, winRate=${(stats.winRate * 100).toFixed(1)}%, maxDD=${stats.maxDrawdown.toFixed(2)}%`);
        console.log("[backtest] Sample exits:", trades.slice(0, 5).map(t => {
            const dir = normalizePnLDirection(t.direction);
            const pips = dir === "long" ? (t.exitPrice - t.entryPrice) * 10000 : (t.entryPrice - t.exitPrice) * 10000;
            return `${t.direction} ${pips.toFixed(1)}pips $${t.pnl.toFixed(2)}`;
        }));
    }

    return {
        trades,
        equityCurve,
        stats: computeStats(trades, config.initialDeposit, config.timeframe),
    };
}

/**
 * Variant of runBacktest that accepts pre-computed per-symbol indicators.
 * Used by runPortfolioBacktest to correctly evaluate cross-symbol conditions
 * like [EURUSD.RSI < 30 AND GBPUSD.RSI < 30].
 */
function runBacktestWithIndicators(
    config: BacktestConfig,
    bars: OhlcvBar[],
    indicatorsBySymbol: Record<string, IndicatorValues>
): BacktestEngineResult {
    validateTimeframes(config);

    if (bars.length === 0) {
        return {
            trades: [],
            equityCurve: [],
            stats: computeStats([], config.initialDeposit, config.timeframe),
        };
    }

    // Use the provided indicators for the primary symbol
    const primaryIndicators = indicatorsBySymbol[config.symbol] ?? {};

    // Build higher timeframe indicators map (same as runBacktest)
    const higherTimeframeIndicators = new Map<string, { indicators: IndicatorValues; multiplier: number }>();

    for (const tf of config.timeframes) {
        if (tf === config.timeframe) continue;
        const primaryBarsPerDay = BARS_PER_DAY[config.timeframe];
        const targetBarsPerDay = BARS_PER_DAY[tf];
        // Fail loudly on invalid timeframe
        if (primaryBarsPerDay === undefined) throw new Error(`Invalid primary timeframe: ${config.timeframe}`);
        if (targetBarsPerDay === undefined) throw new Error(`Invalid timeframe: ${tf}`);
        const aggMul = primaryBarsPerDay / targetBarsPerDay;
        if (aggMul < 1) continue;

        // Aggregate primary bars to the higher timeframe and compute indicators on aggregated bars
        const aggregatedBars = aggregateToHigherTimeframe(bars, aggMul);
        // Fail loudly if aggregation produces no bars (indicates insufficient data)
        if (aggregatedBars.length === 0) throw new Error(`Cannot aggregate bars for timeframe ${tf}: insufficient data (${bars.length} bars, multiplier ${aggMul})`);

        const aggConfig: BacktestConfig = { ...config, timeframe: tf };
        const aggResult = computeAllIndicators(aggregatedBars, aggConfig);
        if (aggResult.incomplete) {
            throw new Error(`[backtest] HTF indicator computation incomplete for ${tf} — entry conditions may be nested too deeply (max depth 100)`);
        }
        higherTimeframeIndicators.set(tf, { indicators: aggResult.indicators, multiplier: aggMul });
    }

    // ATR for exits
    const atrPeriod = config.exitRules.stopLossAtr?.period
        ?? config.exitRules.takeProfitAtr?.period
        ?? 14;
    const atrValues = computeIndicator(bars, "atr", { period: atrPeriod }).values;

    const trades: BacktestTrade[] = [];
    const equityCurve: EquityPoint[] = [];

    let equity = config.initialDeposit;
    let peak = equity;
    let maxDrawdown = 0;

    let openTrade: OpenTrade | null = null;
    // Track if we exited on the current bar — prevents same-bar re-entry
    let justExited = false;

    for (let i = 0; i < bars.length; i++) {
        // Reset exit flag at start of each bar
        justExited = false;

        // ── Accrue borrow cost for short positions (A-01) ─────────────────────
        if (openTrade && openTrade.borrowRate > 0 && i > 0) {
            const barDurationSeconds = bars[i].time - bars[i - 1]!.time;
            const notionalValue = openTrade.entryPrice * openTrade.lotSize * 100_000;
            openTrade.borrowCost += notionalValue * openTrade.borrowRate * (barDurationSeconds / (365.25 * 24 * 3600));
        }

        // Check exits
        if (openTrade) {
            const exitResult = checkExit(openTrade, bars, i, config.exitRules);
            const dir = normalizePnLDirection(openTrade.direction);

            if (dir === "long" && bars[i].high > openTrade.highestPrice) {
                openTrade.highestPrice = bars[i].high;
            }
            if (dir === "short" && bars[i].low < openTrade.lowestPrice) {
                openTrade.lowestPrice = bars[i].low;
            }

            if (
                !openTrade.trailingStopActivated &&
                shouldActivateTrailingStop(openTrade, bars[i])
            ) {
                openTrade.trailingStopActivated = true;
            }

            if (exitResult.hit) {
                const exitPrice =
                    exitResult.reason === "tp"
                        ? openTrade.tp!
                        : exitResult.reason === "sl"
                        ? openTrade.sl!
                        : dir === "long"
                        ? openTrade.highestPrice - (openTrade.trailingStop ?? 0)
                        : openTrade.lowestPrice + (openTrade.trailingStop ?? 0);

                const pipSize = getPipSize(config.symbol);
                // A-04: Apply directional slippage to exit prices — longs exit lower, shorts exit higher
                const exitSlippage = computeSlippage(config, null, pipSize);
                const slippedExitPrice = dir === "long" ? exitPrice - exitSlippage : exitPrice + exitSlippage;
                const priceDiff = dir === "long"
                    ? slippedExitPrice - openTrade.entryPrice
                    : openTrade.entryPrice - slippedExitPrice;
                const pnl = (priceDiff / pipSize) * openTrade.lotSize * openTrade.tickValue - openTrade.commission - openTrade.spreadCost - openTrade.borrowCost;

                equity += pnl;
                equity = Math.round(equity * 100) / 100;
                if (equity > peak) peak = equity;
                const dd = ((peak - equity) / peak) * 100;
                if (dd > maxDrawdown) maxDrawdown = dd;

                trades.push({
                    id: openTrade.id,
                    entryTime: openTrade.entryTime,
                    exitTime: bars[i].time,
                    direction: openTrade.direction,
                    entryPrice: openTrade.entryPrice,
                    exitPrice: slippedExitPrice,
                    lotSize: openTrade.lotSize,
                    pnl,
                    commission: openTrade.commission,
                });

                openTrade = null;
                justExited = true;
            }
        }

        // Check entries - skip if we just exited on this bar to prevent same-bar re-entry
        // Also use indicatorsBySymbol for cross-symbol conditions
        if (!openTrade && !justExited) {
            const pipSize = getPipSize(config.symbol);
            const signals = evaluateEntryConditions(
                config.entryConditions,
                bars,
                i,
                primaryIndicators,
                higherTimeframeIndicators,
                indicatorsBySymbol, // NEW: pass per-symbol indicators
                config.symbol,       // currentSymbol for filtering
                pipSize,
                config.timeframe
            );

            let direction: TradeDirection | null = null;
            if (signals.call) direction = "call";
            else if (signals.long && !signals.put) direction = "long";
            else if (signals.put) direction = "put";
            else if (signals.short) direction = "short";

            if (direction) {
                // A-03: Apply directional slippage to entry price (mirrors runBacktest)
                const slippage = computeSlippage(config, atrValues[i], pipSize);
                const normalizedDir = normalizePnLDirection(direction);
                const entryPrice = bars[i].close + (normalizedDir === "long" ? slippage : -slippage);
                const slDistance = config.exitRules.stopLoss ?? (() => {
                    if (atrValues[i] !== null && atrValues[i] !== undefined) {
                        return atrValues[i]!;
                    }
                    const firstValidAtr = atrValues.find((v) => v !== null && v !== undefined);
                    if (firstValidAtr !== undefined) return firstValidAtr;
                    throw new Error(
                        `[backtest] No ATR available during warmup at index ${i} ` +
                        `(${bars[i].time}). Provide explicit stopLoss or ensure bar history ` +
                        `exceeds ATR period (${atrPeriod}) before the first entry signal.`
                    );
                })();

                const lotSize = calculateLotSize(
                    config.positionSizing.method,
                    config.positionSizing.value,
                    equity,
                    entryPrice,
                    slDistance,
                    getPipSize(config.symbol),
                    config.tickValue ?? TICK_VALUE_DEFAULT
                );

                // ── Volume-aware fill check ─────────────────────────────────────
                const effectiveLotSize = (() => {
                    const fm = config.fillModel;
                    if (!fm || fm.fillRatio <= 0) return lotSize;
                    const MAX_LOTS_PER_BAR = bars[i].volume * fm.fillRatio / 100_000;
                    if (lotSize > MAX_LOTS_PER_BAR) {
                        console.warn(`[backtest] bar ${i}: lotSize ${lotSize.toFixed(2)} exceeds volume-cap ${MAX_LOTS_PER_BAR.toFixed(2)} (vol=${bars[i].volume}, fillRatio=${fm.fillRatio}), scaling down`);
                        return Math.max(0.01, MAX_LOTS_PER_BAR);
                    }
                    return lotSize;
                })();

                const commission = (config.commissionPerLot ?? COMMISSION_PER_LOT_DEFAULT) * effectiveLotSize;
                const spreadCost = computeSpreadCost(config, pipSize) * effectiveLotSize;

                const { tp, sl } = calculateTpSl(
                    entryPrice,
                    normalizePnLDirection(direction),
                    config.exitRules,
                    // A-07: Use slDistance (fallback ATR) when atrValues[i] is null during warmup
                    atrValues[i] ?? (slDistance > 0 ? slDistance : null)
                );

                openTrade = {
                    id: generateId(),
                    entryTime: bars[i].time,
                    direction,
                    entryPrice,
                    lotSize: effectiveLotSize,
                    commission,
                    spreadCost,
                    tickValue: config.tickValue ?? TICK_VALUE_DEFAULT,
                    borrowCost: 0,
                    borrowRate: config.shortConfig?.borrowRate ?? 0,
                    tp,
                    sl,
                    trailingStop: config.exitRules.trailingStop,
                    trailingStopActivated: false,
                    highestPrice: entryPrice,
                    lowestPrice: entryPrice,
                };
            }
        }

        // Record equity
        const dd = equity > 0 ? ((peak - equity) / peak) * 100 : 0;
        equityCurve.push({
            time: bars[i].time,
            equity,
            drawdown: dd,
        });
    }

    // ── EOF: Close any open trade at last bar's close with unrealized PnL ──────
    if (openTrade) {
        const lastBar = bars[bars.length - 1];
        const exitPrice = lastBar.close;
        const pipSize = getPipSize(config.symbol);
        const dir = normalizePnLDirection(openTrade.direction);
        const priceDiff = dir === "long"
            ? exitPrice - openTrade.entryPrice
            : openTrade.entryPrice - exitPrice;
        const pnl = (priceDiff / pipSize) * openTrade.lotSize * openTrade.tickValue - openTrade.commission - openTrade.spreadCost - openTrade.borrowCost;

        equity += pnl;
        equity = Math.round(equity * 100) / 100;
        if (equity > peak) peak = equity;
        const dd = ((peak - equity) / peak) * 100;
        if (dd > maxDrawdown) maxDrawdown = dd;

        // B-05 fix: replace last equity point if same timestamp (trade closed on same bar it opened)
        const lastPoint = equityCurve[equityCurve.length - 1];
        if (lastPoint && lastPoint.time === lastBar.time) {
            lastPoint.equity = equity;
            lastPoint.drawdown = dd;
        } else {
            equityCurve.push({ time: lastBar.time, equity, drawdown: dd });
        }

        trades.push({
            id: openTrade.id,
            entryTime: openTrade.entryTime,
            exitTime: lastBar.time,
            direction: openTrade.direction,
            entryPrice: openTrade.entryPrice,
            exitPrice,
            lotSize: openTrade.lotSize,
            pnl,
            commission: openTrade.commission,
        });
    }

    return {
        trades,
        equityCurve,
        stats: computeStats(trades, config.initialDeposit, config.timeframe),
    };
}

// ── Multi-Symbol Portfolio Backtest ───────────────────────────────────────────

/**
 * Build a timestamp-to-index Map for O(1) bar lookup by timestamp.
 * Handles missing bars due to holidays/feed gaps.
 */
function buildTimeIndexMap(bars: OhlcvBar[]): Map<number, number> {
    const map = new Map<number, number>();
    for (let i = 0; i < bars.length; i++) {
        map.set(bars[i].time, i);
    }
    return map;
}

/**
 * Get bar index by timestamp using binary search fallback if exact match not found.
 * Returns null if no matching bar exists within one bar tolerance (data gap).
 */
function getBarIndexByTime(map: Map<number, number>, bars: OhlcvBar[], targetTime: number): number | null {
    // Exact match
    if (map.has(targetTime)) return map.get(targetTime)!;

    // Binary search for nearest bar
    let left = 0;
    let right = bars.length - 1;
    while (left <= right) {
        const mid = Math.floor((left + right) / 2);
        if (bars[mid].time === targetTime) return mid;
        if (bars[mid].time < targetTime) left = mid + 1;
        else right = mid - 1;
    }
    return null; // No matching bar (gap in data)
}

/**
 * Run backtest for a single symbol (used internally by runPortfolioBacktest).
 * Returns trades, equity curve, and stats for one symbol.
 *
 * When indicatorsBySymbol is provided (portfolio mode), cross-symbol conditions
 * are evaluated correctly using each symbol's pre-computed indicators.
 */
function runSingleSymbolBacktest(
    symbol: string,
    config: BacktestConfig,
    bars: OhlcvBar[],
    indicatorsBySymbol?: Record<string, IndicatorValues>
): SymbolBacktestResult {
    // In portfolio mode with indicatorsBySymbol, we need to evaluate entry conditions
    // using the provided per-symbol indicators. This handles cross-symbol conditions
    // like [EURUSD.RSI < 30 AND GBPUSD.RSI < 30] where both symbols' RSI
    // values are needed at the same timestamp.
    if (indicatorsBySymbol) {
        const result = runBacktestWithIndicators({ ...config, symbol }, bars, indicatorsBySymbol);
        return {
            symbol,
            trades: result.trades,
            equityCurve: result.equityCurve,
            stats: result.stats,
        };
    }
    const result = runBacktest({ ...config, symbol }, bars);
    return {
        symbol,
        trades: result.trades,
        equityCurve: result.equityCurve,
        stats: result.stats,
    };
}

/**
 * Compute combined stats across multiple symbol results.
 * Aggregates trades, equity curves, and computes overall stats.
 */
function computeCombinedStats(symbolResults: SymbolBacktestResult[]): BacktestEngineStats {
    if (symbolResults.length === 0) {
        return {
            netProfit: 0,
            totalTrades: 0,
            winRate: 0,
            maxDrawdown: 0,
            sharpeRatio: 0,
            sortinoRatio: 0,
            cagr: 0,
            profitFactor: 0,
            avgWin: 0,
            avgLoss: 0,
            timeframe: "portfolio",
        };
    }

    // Combine all trades
    const allTrades = symbolResults.flatMap(r => r.trades);
    const netProfit = allTrades.reduce((sum, t) => sum + t.pnl, 0);
    const wins = allTrades.filter(t => t.pnl > 0);
    const losses = allTrades.filter(t => t.pnl <= 0);
    const totalTrades = allTrades.length;
    const winRate = totalTrades > 0 ? wins.length / totalTrades : 0;
    const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
    const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s, t) => s + t.pnl, 0)) / losses.length : 0;

    const grossWins = wins.reduce((s, t) => s + t.pnl, 0);
    const grossLosses = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
    const profitFactor = grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? 999999 : 0;

    return {
        netProfit,
        totalTrades,
        winRate,
        maxDrawdown: 0, // computed from equity curve below
        sharpeRatio: 0,
        sortinoRatio: 0,
        cagr: 0,
        profitFactor,
        avgWin,
        avgLoss,
        timeframe: "portfolio",
    };
}

/**
 * Aggregate multiple equity curves by timestamp.
 * For timestamps present in only some curves, use that curve's value.
 * For missing values, forward-fill from last known value.
 */
function aggregateEquityCurves(
    curves: EquityPoint[][],
    initialDeposit: number
): EquityPoint[] {
    if (curves.length === 0) return [];

    // Collect all unique timestamps
    const allTimestamps = new Set<number>();
    for (const curve of curves) {
        for (const point of curve) {
            allTimestamps.add(point.time);
        }
    }

    const sortedTimes = Array.from(allTimestamps).sort((a, b) => a - b);

    // Forward pointer per curve — O(T×C) instead of O(T×C×P)
    const curvePointers = new Array<number>(curves.length).fill(0);
    const lastValues = new Array<number>(curves.length).fill(initialDeposit);
    const result: EquityPoint[] = [];

    for (const time of sortedTimes) {
        let totalEquity = 0;
        for (let i = 0; i < curves.length; i++) {
            const curve = curves[i];
            // Advance pointer while the curve's next point is at or before this timestamp
            while (
                curvePointers[i] < curve.length &&
                curve[curvePointers[i]]!.time <= time
            ) {
                lastValues[i] = curve[curvePointers[i]!]!.equity;
                curvePointers[i]++;
            }
            totalEquity += lastValues[i];
        }

        result.push({ time, equity: totalEquity, drawdown: 0 });
    }

    // Compute drawdowns in a second pass
    let peak = result[0]?.equity ?? initialDeposit;
    for (const point of result) {
        if (point.equity > peak) peak = point.equity;
        point.drawdown = peak > 0 ? ((peak - point.equity) / peak) * 100 : 0;
    }

    return result;
}

/**
 * Run a portfolio backtest across multiple symbols.
 * Each symbol is backtested independently and results are aggregated.
 *
 * Uses timestamp-aligned iteration: the primary symbol's bars drive the main loop,
 * but each symbol's own bars are used for condition evaluation (via time-index lookup).
 */
export function runPortfolioBacktest(
    config: BacktestConfig,
    barsBySymbol: Record<string, OhlcvBar[]>
): PortfolioBacktestResult {
    validateTimeframes(config);

    debugLog("[portfolio] Starting portfolio backtest:", {
        symbols: Object.keys(barsBySymbol),
        timeframe: config.timeframe,
        entryConditions: config.entryConditions.length,
    });

    // Build timestamp indexes for each symbol
    const timeIndexMaps: Record<string, Map<number, number>> = {};
    for (const [symbol, bars] of Object.entries(barsBySymbol)) {
        timeIndexMaps[symbol] = buildTimeIndexMap(bars);
    }

    // Determine primary symbol (longest/most complete dataset)
    const primarySymbol = config.symbol;
    const primaryBars = barsBySymbol[primarySymbol];
    const primaryTimeIndex = timeIndexMaps[primarySymbol];

    if (!primaryBars || primaryBars.length === 0) {
        // Validate config.symbol exists in barsBySymbol — mismatch silently uses wrong symbol
        if (!(primarySymbol in barsBySymbol)) {
            throw new Error(
                `[portfolio] config.symbol "${primarySymbol}" not found in barsBySymbol keys: ` +
                `${Object.keys(barsBySymbol).join(", ")}. Set config.symbol to a key in barsBySymbol.`
            );
        }
        console.error("[portfolio] ERROR: primary symbol has no bars");
        return {
            symbolResults: [],
            combinedStats: computeCombinedStats([]),
            totalEquityCurve: [],
        };
    }

    if (DEBUG) {
        console.log("[portfolio] Primary symbol:", primarySymbol, "bars:", primaryBars.length);
        for (const [sym, bars] of Object.entries(barsBySymbol)) {
            console.log(`[portfolio]   ${sym}: ${bars.length} bars`);
        }
    }

    // Pre-compute indicators for ALL symbols.
    // This is needed for cross-symbol conditions like [EURUSD.RSI < 30 AND GBPUSD.RSI < 30]
    // where each symbol's RSI needs to be available when evaluating the other symbol's condition.
    const indicatorsBySymbol: Record<string, IndicatorValues> = {};
    for (const [sym, bars] of Object.entries(barsBySymbol)) {
        if (bars.length > 0) {
            const result = computeAllIndicators(bars, config, sym);
            if (result.incomplete) {
                throw new Error(`[backtest] Indicator computation incomplete for symbol ${sym} — entry conditions may be nested too deeply (max depth 100)`);
            }
            indicatorsBySymbol[sym] = result.indicators;
        }
    }

    if (DEBUG) {
        for (const [sym, inds] of Object.entries(indicatorsBySymbol)) {
            console.log(`[portfolio] ${sym} indicators:`, Object.keys(inds).slice(0, 5));
        }
    }

    // Run backtest for each symbol independently, passing indicatorsBySymbol
    // so cross-symbol conditions resolve correctly
    const symbolResults: SymbolBacktestResult[] = [];

    for (const [symbol, bars] of Object.entries(barsBySymbol)) {
        if (bars.length === 0) {
            debugLog(`[portfolio] Skipping ${symbol} - no bars`);
            continue;
        }

        debugLog(`[portfolio] Running backtest for ${symbol}...`);
        const result = runSingleSymbolBacktest(symbol, config, bars, indicatorsBySymbol);
        symbolResults.push(result);

        debugLog(`[portfolio] ${symbol}: ${result.trades.length} trades, netProfit=${result.stats.netProfit.toFixed(2)}`);
    }

    // Aggregate equity curves
    const curvesBySymbol = symbolResults.map(r => r.equityCurve);
    const totalEquityCurve = aggregateEquityCurves(curvesBySymbol, config.initialDeposit);

    // Compute combined stats from aggregated equity curve
    const combinedStats = computeCombinedStats(symbolResults);

    // Compute max drawdown from aggregated equity curve
    let peak = config.initialDeposit;
    let maxDrawdown = 0;
    for (const point of totalEquityCurve) {
        if (point.equity > peak) peak = point.equity;
        const dd = ((peak - point.equity) / peak) * 100;
        if (dd > maxDrawdown) maxDrawdown = dd;
    }
    combinedStats.maxDrawdown = maxDrawdown;

    // Compute Sharpe from combined equity curve
    const portfolioReturns: number[] = [];
    for (let i = 1; i < totalEquityCurve.length; i++) {
        const prev = totalEquityCurve[i - 1].equity;
        if (prev > 0) {
            // B-02 fix: use log returns for consistency with computeStats Sharpe
            const simpleReturn = (totalEquityCurve[i].equity - prev) / prev;
            portfolioReturns.push(Math.log(1 + simpleReturn));
        }
    }
    if (portfolioReturns.length > 0) {
        const barsPerYear = (BARS_PER_DAY[config.timeframe] ?? 24) * 252;
        const mean = portfolioReturns.reduce((s, r) => s + r, 0) / portfolioReturns.length;
        const variance = portfolioReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / portfolioReturns.length;
        const std = Math.sqrt(variance);
        combinedStats.sharpeRatio = std > 0 ? (mean / std) * Math.sqrt(barsPerYear) : 0;

        // Sortino: downside deviation only — B-01/B-03 fix: apply MAR to variance, use excess return in numerator
        const MAR = 0.02;
        const downsideReturns = portfolioReturns.filter(r => r < 0);
        if (downsideReturns.length > 0) {
            const downsideVariance = downsideReturns.reduce((s, r) => s + (r - MAR) * (r - MAR), 0) / downsideReturns.length;
            const downsideStd = Math.sqrt(downsideVariance);
            combinedStats.sortinoRatio = downsideStd > 0 ? ((mean - MAR) / downsideStd) * Math.sqrt(barsPerYear) : 0;
        }
    }

    // CAGR from combined equity curve time span
    if (totalEquityCurve.length >= 2) {
        const startTime = totalEquityCurve[0]!.time;
        const endTime = totalEquityCurve[totalEquityCurve.length - 1]!.time;
        const years = (endTime - startTime) / (365.25 * 24 * 3600);
        if (years > 0) {
            const startEquity = totalEquityCurve[0]!.equity;
            const endEquity = totalEquityCurve[totalEquityCurve.length - 1]!.equity;
            if (startEquity > 0) {
                combinedStats.cagr = Math.pow(endEquity / startEquity, 1 / years) - 1;
            }
        }
    }

    if (DEBUG) {
        const totalTrades = symbolResults.reduce((sum, r) => sum + r.trades.length, 0);
        console.log(`[portfolio] COMPLETE: ${symbolResults.length} symbols, ${totalTrades} total trades, combined netProfit=${combinedStats.netProfit.toFixed(2)}, maxDD=${maxDrawdown.toFixed(2)}%`);
    }

    return { symbolResults, combinedStats, totalEquityCurve };
}

/**
 * Run a forward test projection on historical data.
 * Splits data at the 80% mark: first 80% is historical, last 20% is projected.
 * Uses the same strategy parameters but evaluates on unseen future data.
 *
 * Fixed 20% projection window — no user configuration per TigerStyle principles.
 */
export function runForwardTest(
    config: BacktestConfig,
    bars: OhlcvBar[]
): ProjectionResult {
    // Fixed 80/20 split — no configuration needed
    const splitIndex = Math.floor(bars.length * 0.8);
    const historicalBars = bars.slice(0, splitIndex);
    const projectionBars = bars.slice(splitIndex);

    // Warn if OOS segment is too short for reliable HTF indicator computation
    if (config.timeframes && config.timeframes.length > 0) {
        for (const tf of config.timeframes) {
            const primaryBarsPerDay = BARS_PER_DAY[config.timeframe];
            const targetBarsPerDay = BARS_PER_DAY[tf];
            if (primaryBarsPerDay && targetBarsPerDay) {
                const aggMul = primaryBarsPerDay / targetBarsPerDay;
                if (aggMul > 1 && Number.isInteger(aggMul) && projectionBars.length < aggMul * 2) {
                    console.warn(
                        `[forward-test] OOS segment has only ${projectionBars.length} bars ` +
                        `but HTF ${tf} needs at least ${aggMul * 2} bars for reliable aggregation. ` +
                        `HTF indicators may silently fall back to primary timeframe in OOS.`
                    );
                }
            }
        }
    }

    // Run backtest on historical portion
    const historicalResult = runBacktest(config, historicalBars);

    // Run backtest on projection portion with adjusted dates
    const projectionConfig: BacktestConfig = {
        ...config,
        fromDate: new Date(projectionBars[0].time * 1000).toISOString().split("T")[0],
        toDate: new Date(projectionBars[projectionBars.length - 1].time * 1000).toISOString().split("T")[0],
    };
    const projectionResult = runBacktest(projectionConfig, projectionBars);

    // Adjust projected equity curve to continue from where historical ended
    const historicalEndingEquity = historicalResult.equityCurve.length > 0
        ? historicalResult.equityCurve[historicalResult.equityCurve.length - 1].equity
        : config.initialDeposit ?? 10000;
    const adjustedProjectedEquityCurve = projectionResult.equityCurve.map(point => ({
        ...point,
        equity: point.equity + historicalEndingEquity - (config.initialDeposit ?? 10000),
    }));

    return {
        historicalStats: historicalResult.stats,
        projectedStats: projectionResult.stats,
        projectionStartIndex: splitIndex,
        projectionEndIndex: bars.length,
        historicalEquityCurve: historicalResult.equityCurve,
        projectedEquityCurve: adjustedProjectedEquityCurve,
    };
}

/**
 * Rolling walk-forward analysis: train on a sliding window, test on the subsequent window.
 * Produces multiple in-sample / out-of-sample segment results for statistical robustness.
 *
 * Config defaults (per TigerStyle — no unnecessary configuration):
 *   trainRatio = 0.8  (80% training, 20% testing per step)
 *   stepRatio  = 0.2  (advance 20% of bars each iteration)
 *
 * Each segment's OOS equity curve is anchored to the train-ending equity so segments
 * can be chained or averaged meaningfully.
 */
export function runWalkForwardTest(
    config: BacktestConfig,
    bars: OhlcvBar[],
    walkForwardConfig?: WalkForwardConfig
): WalkForwardResult {
    const trainRatio = walkForwardConfig?.trainRatio ?? 0.8;
    const stepRatio = walkForwardConfig?.stepRatio ?? 0.2;

    // A-20: Validate WalkForwardConfig
    if (trainRatio <= 0 || trainRatio >= 1) {
        throw new Error(`WalkForwardConfig.trainRatio must be in (0, 1), got ${trainRatio}`);
    }
    if (stepRatio <= 0 || stepRatio >= 1) {
        throw new Error(`WalkForwardConfig.stepRatio must be in (0, 1), got ${stepRatio}`);
    }

    if (bars.length < 20) {
        debugLog("[walk-forward] insufficient bars for walk-forward analysis");
        return { segments: [], avgInSampleSharpe: 0, avgOutOfSampleSharpe: 0, avgSharpeDecay: 0 };
    }

    // A-13: Validate train window is large enough for a meaningful backtest.
    // A rough minimum: 50 bars accommodates most indicator warmups (e.g., SMA-200 needs 200,
    // but in practice train window should be >> max indicator period). If trainBars < 50,
    // the in-sample result is unreliable — skip the segment.
    const MIN_TRAIN_BARS = 50;
    const MIN_TEST_BARS = 5;

    const segments: WalkForwardSegment[] = [];
    let inSampleSharpeSum = 0;
    let outOfSampleSharpeSum = 0;

    // Sliding window: advance by stepSize bars each iteration
    // Train: [0, trainEndIndex], Test: [trainEndIndex+1, testEndIndex]
    // Stop when test window would have fewer than MIN_TEST_BARS bars
    let trainEndIndex = Math.floor(bars.length * trainRatio) - 1;

    /*
     * A-12 NOTE — HTF indicator gap in walk-forward:
     * runBacktest computes HTF indicators ONCE from the full primary bar array before the
     * backtest loop. In walk-forward, each segment calls runBacktest with only the
     * in-sample or out-of-sample bar slice — so the HTF indicators are computed only
     * from that slice's bars. This means:
     *   - In-sample: HTF indicators reflect only train-period data (correct)
     *   - Out-of-sample: HTF indicators reflect only test-period data (potentially
     *     incorrect if a test bar's HTF candle requires preceding primary bars that
     *     are absent from the test slice)
     * Full fix requires passing a pre-built HTF indicator map with per-bar time offsets
     * into runBacktest so each bar's HTF lookup uses the correct historical window.
     */
    while (trainEndIndex < bars.length - (MIN_TEST_BARS + 1)) {
        const testEndIndex = Math.min(
            Math.floor(trainEndIndex + (bars.length - trainEndIndex) * (1 - trainRatio)),
            bars.length - 1
        );

        const trainBars = bars.slice(0, trainEndIndex + 1);
        const testBars = bars.slice(trainEndIndex + 1, testEndIndex + 1);

        // A-13: Skip segments where train or test windows are too small for indicator warmup
        if (trainBars.length < MIN_TRAIN_BARS || testBars.length < MIN_TEST_BARS) {
            debugLog(`[walk-forward] skipping segment: trainBars=${trainBars.length} (min ${MIN_TRAIN_BARS}), testBars=${testBars.length} (min ${MIN_TEST_BARS})`);
            const stepSize = Math.max(1, Math.floor(bars.length * stepRatio));
            trainEndIndex += stepSize;
            continue;
        }

        debugLog(`[walk-forward] train[0-${trainEndIndex}] (${trainBars.length} bars), test[${trainEndIndex + 1}-${testEndIndex}] (${testBars.length} bars)`);

        // In-sample backtest
        const inSampleResult = runBacktest(config, trainBars);
        const trainEndingEquity = inSampleResult.equityCurve.length > 0
            ? inSampleResult.equityCurve[inSampleResult.equityCurve.length - 1]!.equity
            : config.initialDeposit;

        // Out-of-sample backtest
        const outOfSampleResult = runBacktest(config, testBars);

        // Anchor OOS equity curve to train-ending equity
        const oosEquityCurve = outOfSampleResult.equityCurve.map((point) => ({
            ...point,
            equity: point.equity + trainEndingEquity - config.initialDeposit,
        }));

        segments.push({
            trainEndIndex,
            testEndIndex,
            trainEndingEquity,
            inSampleStats: inSampleResult.stats,
            outOfSampleStats: outOfSampleResult.stats,
            inSampleEquityCurve: inSampleResult.equityCurve,
            outOfSampleEquityCurve: oosEquityCurve,
        });

        inSampleSharpeSum += inSampleResult.stats.sharpeRatio;
        outOfSampleSharpeSum += outOfSampleResult.stats.sharpeRatio;

        // Advance: move forward by stepSize bars
        const stepSize = Math.max(1, Math.floor(bars.length * stepRatio));
        trainEndIndex += stepSize;
    }

    const n = segments.length;
    const avgInSampleSharpe = n > 0 ? inSampleSharpeSum / n : 0;
    const avgOutOfSampleSharpe = n > 0 ? outOfSampleSharpeSum / n : 0;

    if (DEBUG) {
        console.log(`[walk-forward] ${n} segments, avg IS Sharpe=${avgInSampleSharpe.toFixed(2)}, avg OOS Sharpe=${avgOutOfSampleSharpe.toFixed(2)}, decay=${(avgInSampleSharpe - avgOutOfSampleSharpe).toFixed(2)}`);
    }

    return {
        segments,
        avgInSampleSharpe,
        avgOutOfSampleSharpe,
        avgSharpeDecay: avgInSampleSharpe - avgOutOfSampleSharpe,
    };
}
