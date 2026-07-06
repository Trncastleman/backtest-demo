import type { OhlcvBar, Operand, RuleNode } from "./types";
import { computeIndicator } from "./indicators";

export type IndicatorValues = Record<string, (number | null)[]>;

/** A-18: Cache for resolveOperand fallback results.
 * Outer key = indicator lookup key (e.g., "EMA_period=50"), inner key = bar index.
 * Prevents redundant O(n_indicators) fallback searches and on-the-fly computeIndicator calls
 * when the same unrecognized operand is evaluated across many bars × rules. */
type OperandCache = Map<string, Map<number, number | null>>;

/** Serialize params to a stable string, e.g. "period=50" → "period=50" */
function paramsKey(params: Record<string, number | string>): string {
    return Object.entries(params)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join("&");
}

/** Unique storage key for an indicator+params combo, e.g. "EMA_period=50" */
function indicatorKey(name: string, params: Record<string, number | string>): string {
    const pk = paramsKey(params);
    // Always lowercase the indicator name to ensure consistent lookups
    // regardless of how the LLM formats the name (e.g., "Highest" vs "highest")
    const normalizedName = String(name || "").toLowerCase();
    return pk ? `${normalizedName}_${pk}` : normalizedName;
}

/*
 * HTF INDEX MAPPING (A-22):
 * Higher timeframe indicators are pre-computed by backtest-engine.ts on aggregated bars.
 * The multiplier = primaryBarsPerDay / targetBarsPerDay (e.g., H1→D1 = 24).
 * In resolveOperand, primary bar index is converted to HTF bar index via:
 *   htfIdx = floor((barIdx - shift) / multiplier)
 * This maps a primary candle's position to its containing HTF candle.
 *
 * IMPORTANT: HTF indicators are computed on aggregated bars at backtest start.
 * See backtest-engine.ts computeHigherTimeframeIndicators() for the aggregation logic.
 */

function resolveOperand(
    op: Operand,
    bars: OhlcvBar[],
    index: number,
    primaryIndicators: IndicatorValues,
    higherTimeframeIndicators?: Map<string, { indicators: IndicatorValues; multiplier: number }>,
    indicatorsBySymbol?: Record<string, IndicatorValues>,
    // A-18: cache for fallback results to avoid redundant on-the-fly computeIndicator calls
    _cache?: OperandCache,
    primaryTimeframe?: string
): number | null {
    switch (op.type) {
        case "price": {
            const bar = bars[index];
            if (!bar) return null;
            return bar[op.field] ?? null;
        }
        case "constant":
            return op.value;
        case "indicator": {
            // Support shift for lookback (e.g., "EMA crossed above 1 bar ago")
            const shift = (op as { shift?: number }).shift ?? 0;
            const params = (op.parameters ?? {}) as Record<string, number | string>;

            // Multi-symbol: use the indicator set for op.symbol if set and available,
            // otherwise fall back to the execution symbol's indicators.
            // This correctly handles leader-follower: EURUSD operand → EURUSD indicators (computed from EURUSD bars).
            let indicators = primaryIndicators;
            if (op.symbol && indicatorsBySymbol) {
                const symIndicators = indicatorsBySymbol[op.symbol];
                if (symIndicators && Object.keys(symIndicators).length > 0) {
                    indicators = symIndicators;
                }
                // If symIndicators is empty/undefined, fall through — don't use primaryIndicators
                // since those were computed from a different symbol's bars.
            }

            let tfMultiplier = 1;
            if (op.timeframe && op.timeframe !== primaryTimeframe) {
                if (higherTimeframeIndicators?.has(op.timeframe)) {
                    const tfData = higherTimeframeIndicators.get(op.timeframe)!;
                    indicators = tfData.indicators;
                    tfMultiplier = tfData.multiplier;
                } else {
                    throw new Error(`Timeframe '${op.timeframe}' is not resolved in higher timeframe indicators.`);
                }
            }

            // For higher timeframe indicators, map primary bar index to aggregated bar index.
            // E.g., H1 bar 48 → D1 bar floor(48/24) = 2 when multiplier=24.
            // Shift is applied in primary bar space before converting.
            const primaryIdx = Math.max(0, index - shift);
            const idx = tfMultiplier > 1 ? Math.floor(primaryIdx / tfMultiplier) : primaryIdx;

            // Build lookup key matching how computeAllIndicators stores them: "EMA_period=50"
            // For multi-output: "EMA_period=50_signal"
            const baseKey = indicatorKey(op.name, params);
            // Normalize output aliases (LLM may generate inconsistent names)
            let output = op.output;
            // Stochastic: "signal" (MT4/TradingView terminology) → "d" (%D line)
            if (op.name === "stochastic" && output === "signal") output = "d";
            // Multi-output indicators store %K as the base key (no suffix), %D as _d, etc.
            // For "main"/"k" output, look up the base key directly without suffix.
            const key = (output === "main" || output === "k") ? baseKey
                : output ? `${baseKey}_${output}` : baseKey;
            const arr = indicators[key];
            if (arr && arr[idx] !== undefined) return arr[idx];
            // Fallback for single-output indicators where LLM specified an unsupported output.
            // E.g., "highest" with output:"high" should still resolve to the main value.
            if (output && output !== "main" && output !== "k") {
                const baseArr = indicators[baseKey];
                if (baseArr && baseArr[idx] !== undefined) return baseArr[idx];
            }
            // Fallback to plain name (for indicators with no params)
            const mainArr = indicators[String(op.name).toLowerCase()];
            if (mainArr && mainArr[idx] !== undefined) return mainArr[idx];
            // A-18: Fallback — check cache before computing on the fly.
            // (do NOT use idx — idx is HTF-converted and computeIndicator operates on primary bars)
            if (_cache?.has(baseKey)) {
                const cached = _cache.get(baseKey)!.get(index);
                if (cached !== undefined) return cached;
            }
            const result = computeIndicator(bars, op.name as Parameters<typeof computeIndicator>[1], params);
            const values = result.outputs?.[output ?? "values"] ?? result.values;
            const fallbackResult = values[index] ?? null;
            if (_cache && !_cache.has(baseKey)) {
                _cache.set(baseKey, new Map());
            }
            _cache?.get(baseKey)?.set(index, fallbackResult);
            return fallbackResult;
        }
    }
}

export function evaluateRule(
    rule: RuleNode,
    bars: OhlcvBar[],
    index: number,
    primaryIndicators: IndicatorValues,
    higherTimeframeIndicators?: Map<string, { indicators: IndicatorValues; multiplier: number }>,
    indicatorsBySymbol?: Record<string, IndicatorValues>,
    _depth: number = 0,
    _pipSize: number = 0.0001,
    // A-18: operand fallback cache — must be passed through from evaluateEntryConditions
    _cache?: OperandCache,
    primaryTimeframe?: string
): boolean {
    // Guard against stack overflow in deeply nested rule trees (e.g., 100+ levels of and/or/not)
    if (_depth > 100) {
        console.warn(`[evaluateRule] max depth exceeded (${_depth}), returning false to fail safely`);
        return false;
    }
    switch (rule.operator) {
        case "and": {
            for (const cond of rule.conditions) {
                if (!evaluateRule(cond, bars, index, primaryIndicators, higherTimeframeIndicators, indicatorsBySymbol, _depth + 1, _pipSize, _cache, primaryTimeframe)) return false;
            }
            return true;
        }
        case "or": {
            for (const cond of rule.conditions) {
                if (evaluateRule(cond, bars, index, primaryIndicators, higherTimeframeIndicators, indicatorsBySymbol, _depth + 1, _pipSize, _cache, primaryTimeframe)) return true;
            }
            return false;
        }
        case "not":
            return !evaluateRule(rule.condition, bars, index, primaryIndicators, higherTimeframeIndicators, indicatorsBySymbol, _depth + 1, _pipSize, _cache, primaryTimeframe);
        case "crosses_above": {
            if (index < 1) return false;
            const left = resolveOperand(rule.left, bars, index, primaryIndicators, higherTimeframeIndicators, indicatorsBySymbol, _cache, primaryTimeframe);
            const right = resolveOperand(rule.right, bars, index, primaryIndicators, higherTimeframeIndicators, indicatorsBySymbol, _cache, primaryTimeframe);
            const prevLeft = resolveOperand(rule.left, bars, index - 1, primaryIndicators, higherTimeframeIndicators, indicatorsBySymbol, _cache, primaryTimeframe);
            const prevRight = resolveOperand(rule.right, bars, index - 1, primaryIndicators, higherTimeframeIndicators, indicatorsBySymbol, _cache, primaryTimeframe);
            if (left === null || right === null || prevLeft === null || prevRight === null) return false;
            return prevLeft <= prevRight && left > right;
        }
        case "crosses_below": {
            if (index < 1) return false;
            const left = resolveOperand(rule.left, bars, index, primaryIndicators, higherTimeframeIndicators, indicatorsBySymbol, _cache, primaryTimeframe);
            const right = resolveOperand(rule.right, bars, index, primaryIndicators, higherTimeframeIndicators, indicatorsBySymbol, _cache, primaryTimeframe);
            const prevLeft = resolveOperand(rule.left, bars, index - 1, primaryIndicators, higherTimeframeIndicators, indicatorsBySymbol, _cache, primaryTimeframe);
            const prevRight = resolveOperand(rule.right, bars, index - 1, primaryIndicators, higherTimeframeIndicators, indicatorsBySymbol, _cache, primaryTimeframe);
            if (left === null || right === null || prevLeft === null || prevRight === null) return false;
            return prevLeft >= prevRight && left < right;
        }
        case "greater_than": {
            const left = resolveOperand(rule.left, bars, index, primaryIndicators, higherTimeframeIndicators, indicatorsBySymbol, _cache, primaryTimeframe);
            const right = resolveOperand(rule.right, bars, index, primaryIndicators, higherTimeframeIndicators, indicatorsBySymbol, _cache, primaryTimeframe);
            if (left === null || right === null) return false;
            return left > right;
        }
        case "less_than": {
            const left = resolveOperand(rule.left, bars, index, primaryIndicators, higherTimeframeIndicators, indicatorsBySymbol, _cache, primaryTimeframe);
            const right = resolveOperand(rule.right, bars, index, primaryIndicators, higherTimeframeIndicators, indicatorsBySymbol, _cache, primaryTimeframe);
            if (left === null || right === null) return false;
            return left < right;
        }
        case "greater_than_or_equal": {
            const left = resolveOperand(rule.left, bars, index, primaryIndicators, higherTimeframeIndicators, indicatorsBySymbol, _cache, primaryTimeframe);
            const right = resolveOperand(rule.right, bars, index, primaryIndicators, higherTimeframeIndicators, indicatorsBySymbol, _cache, primaryTimeframe);
            if (left === null || right === null) return false;
            return left >= right;
        }
        case "less_than_or_equal": {
            const left = resolveOperand(rule.left, bars, index, primaryIndicators, higherTimeframeIndicators, indicatorsBySymbol, _cache, primaryTimeframe);
            const right = resolveOperand(rule.right, bars, index, primaryIndicators, higherTimeframeIndicators, indicatorsBySymbol, _cache, primaryTimeframe);
            if (left === null || right === null) return false;
            return left <= right;
        }
        case "equals": {
            const left = resolveOperand(rule.left, bars, index, primaryIndicators, higherTimeframeIndicators, indicatorsBySymbol, _cache, primaryTimeframe);
            const right = resolveOperand(rule.right, bars, index, primaryIndicators, higherTimeframeIndicators, indicatorsBySymbol, _cache, primaryTimeframe);
            if (left === null || right === null) return false;
            // Use pipSize/10 as epsilon: 0.1 pip (0.00001 for non-JPY, 0.001 for JPY)
            return Math.abs(left - right) < _pipSize / 10;
        }
    }
}

/** Evaluate all rules as AND — entry is valid only when all rules pass */
export function evaluateAllRules(
    rules: RuleNode[],
    bars: OhlcvBar[],
    index: number,
    primaryIndicators: IndicatorValues,
    higherTimeframeIndicators?: Map<string, { indicators: IndicatorValues; multiplier: number }>,
    indicatorsBySymbol?: Record<string, IndicatorValues>,
    _pipSize?: number,
    _cache?: OperandCache,
    primaryTimeframe?: string
): boolean {
    const cache = _cache ?? new Map();
    for (const rule of rules) {
        if (!evaluateRule(rule, bars, index, primaryIndicators, higherTimeframeIndicators, indicatorsBySymbol, 0, _pipSize, cache, primaryTimeframe)) return false;
    }
    return true;
}

/**
 * Direction-aware entry signal result.
 * Evaluates rules for long, short, call, and put directions.
 */
export interface DirectionSignals {
    long: boolean;
    short: boolean;
    call: boolean;
    put: boolean;
}

/**
 * Evaluate entry conditions grouped by direction and timeframe.
 * Returns which direction(s) have valid entry signals at the given bar.
 *
 * Each group may have its own timeframe (e.g., H4 for a trend filter).
 * The correct indicator set is selected per group.
 *
 * For multi-symbol backtests, `currentSymbol` filters to only evaluate
 * groups that match the given symbol. Groups with a different symbol are skipped.
 * `indicatorsBySymbol` provides per-symbol indicator sets.
 *
 * call behaves like long (profit when price rises).
 * put behaves like short (profit when price falls).
 */
export function evaluateEntryConditions(
    entryConditions: { direction: "long" | "short" | "call" | "put"; rules: RuleNode[]; timeframe?: string; symbol?: string }[],
    bars: OhlcvBar[],
    index: number,
    primaryIndicators: IndicatorValues,
    higherTimeframeIndicators?: Map<string, { indicators: IndicatorValues; multiplier: number }>,
    indicatorsBySymbol?: Record<string, IndicatorValues>,
    currentSymbol?: string,
    _pipSize?: number,
    primaryTimeframe?: string,
    _cache?: OperandCache
): DirectionSignals {
    let long = false;
    let short = false;
    let call = false;
    let put = false;

    // A-18: create cache once per bar to avoid redundant fallback computeIndicator calls
    const cache = _cache ?? new Map();

    for (const group of entryConditions) {
        // Multi-symbol: skip groups that don't match the current symbol
        // "ALL_SYMBOLS" is a wildcard — include it for every symbol
        if (currentSymbol && group.symbol && group.symbol !== "ALL_SYMBOLS" && group.symbol !== currentSymbol) {
            continue;
        }

        // Select the correct indicator set for this group's timeframe
        let indicators = primaryIndicators;
        if (group.timeframe && group.timeframe !== primaryTimeframe) {
            if (higherTimeframeIndicators?.has(group.timeframe)) {
                indicators = higherTimeframeIndicators.get(group.timeframe)!.indicators;
            } else {
                throw new Error(`Timeframe '${group.timeframe}' is not resolved in higher timeframe indicators.`);
            }
        }

        const allPass = evaluateAllRules(group.rules, bars, index, indicators, higherTimeframeIndicators, indicatorsBySymbol, _pipSize, cache, primaryTimeframe);
        if (allPass) {
            switch (group.direction) {
                case "long": long = true; break;
                case "short": short = true; break;
                case "call": call = true; break;
                case "put": put = true; break;
            }
        }
    }

    return { long, short, call, put };
}
