import type { ExitConfig, OhlcvBar, OpenTrade, TradeDirection } from "./types";

export type ExitReason = "tp" | "sl" | "ts";

export interface ExitCheckResult {
    hit: boolean;
    reason?: ExitReason;
}

/** Normalize call/put to long/short for exit logic.
 * call behaves like long (TP up, SL down).
 * put behaves like short (TP down, SL up). */
function normalizeDirection(direction: TradeDirection): "long" | "short" {
    if (direction === "call") return "long";
    if (direction === "put") return "short";
    return direction;
}

/**
 * Check if any exit condition is hit for an open trade at the current bar.
 *
 * Trailing stop activates once price moves in favor by the trailingStop distance.
 * Once activated, it tracks the highest/lowest price and exits when price
 * reverses by the trailingStop distance from that extreme.
 */
export function checkExit(
    trade: OpenTrade,
    bars: OhlcvBar[],
    index: number,
    exitConfig: ExitConfig
): ExitCheckResult {
    const bar = bars[index];
    if (!bar) return { hit: false };

    const { direction, entryPrice, trailingStop, tp, sl } = trade;
    const dir = normalizeDirection(direction);

    // ── Skip TP/SL on the entry bar ─────────────────────────────────────────
    // A market order fills at bar.close. A stop placed at entry-slop cannot also
    // be triggered by bar.low/high of the SAME bar — those are mutually exclusive.
    // TP/SL can only act on the NEXT bar after entry (bar+1 onwards).
    if (bar.time === trade.entryTime) {
        // Trailing stop is evaluated separately below; skip TP/SL on entry bar.
    } else {
        // ── Fixed TP / SL ────────────────────────────────────────────────────
        if (dir === "long") {
            if (sl !== undefined && bar.low <= sl) return { hit: true, reason: "sl" };
            if (tp !== undefined && bar.high >= tp) return { hit: true, reason: "tp" };
        } else {
            if (sl !== undefined && bar.high >= sl) return { hit: true, reason: "sl" };
            if (tp !== undefined && bar.low <= tp) return { hit: true, reason: "tp" };
        }
    }

    // ── Trailing Stop ────────────────────────────────────────────────────────
    if (trailingStop !== undefined && trade.trailingStopActivated) {
        if (dir === "long") {
            // TS level is tracked from highestPrice (updated by caller on new extremes)
            const tsLevel = trade.highestPrice - trailingStop;
            if (tsLevel > entryPrice && bar.low <= tsLevel) {
                return { hit: true, reason: "ts" };
            }
        } else {
            const tsLevel = trade.lowestPrice + trailingStop;
            if (tsLevel < entryPrice && bar.high >= tsLevel) {
                return { hit: true, reason: "ts" };
            }
        }
    }

    return { hit: false };
}

/**
 * Calculate TP and SL price levels from a trade entry.
 * All prices are absolute (not percentages).
 * Uses ATR-based exits when atrValue is provided and exitConfig has ATR fields.
 */
export function calculateTpSl(
    entryPrice: number,
    direction: "long" | "short",
    exitConfig: ExitConfig,
    atrValue?: number | null
): { tp?: number; sl?: number } {
    const result: { tp?: number; sl?: number } = {};

    if (exitConfig.takeProfit !== undefined) {
        result.tp = direction === "long"
            ? entryPrice + exitConfig.takeProfit
            : entryPrice - exitConfig.takeProfit;
    } else if (exitConfig.takeProfitAtr && atrValue != null && atrValue > 0) {
        const distance = exitConfig.takeProfitAtr.multiplier * atrValue;
        result.tp = direction === "long"
            ? entryPrice + distance
            : entryPrice - distance;
    }

    if (exitConfig.stopLoss !== undefined) {
        result.sl = direction === "long"
            ? entryPrice - exitConfig.stopLoss
            : entryPrice + exitConfig.stopLoss;
    } else if (exitConfig.stopLossAtr && atrValue != null && atrValue > 0) {
        const distance = exitConfig.stopLossAtr.multiplier * atrValue;
        result.sl = direction === "long"
            ? entryPrice - distance
            : entryPrice + distance;
    }

    return result;
}

/**
 * Whether to activate trailing stop: price must move at least `trailingStop` in favor.
 *
 * NOTE: trailingStop is used for BOTH activation threshold AND trail distance.
 * - Activation threshold: price must move `trailingStop` in favor before TS activates
 * - Trail distance: once activated, TS trails by `trailingStop` from the extreme price
 *
 * call behaves like long, put behaves like short.
 */
export function shouldActivateTrailingStop(
    trade: OpenTrade,
    bar: OhlcvBar
): boolean {
    if (trade.trailingStop === undefined) return false;
    const threshold = trade.trailingStop;
    const dir = normalizeDirection(trade.direction);

    if (dir === "long") {
        return bar.high - trade.entryPrice >= threshold;
    } else {
        return trade.entryPrice - bar.low >= threshold;
    }
}
