import type { OhlcvBar } from "./types";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Extract close prices from bars */
function closes(bars: OhlcvBar[]): number[] {
    return bars.map((b) => b.close);
}

/** Extract highs from bars */
function highs(bars: OhlcvBar[]): number[] {
    return bars.map((b) => b.high);
}

/** Extract lows from bars */
function lows(bars: OhlcvBar[]): number[] {
    return bars.map((b) => b.low);
}

/** Extract volumes from bars */
function volumes(bars: OhlcvBar[]): number[] {
    return bars.map((b) => b.volume);
}

// ── SMA ─────────────────────────────────────────────────────────────────────

export function sma(bars: OhlcvBar[], period: number): (number | null)[] {
    const result: (number | null)[] = new Array(bars.length).fill(null);
    if (period < 1 || bars.length < period) return result;
    let sum = 0;
    for (let i = 0; i < period; i++) sum += bars[i].close;
    result[period - 1] = sum / period;
    for (let i = period; i < bars.length; i++) {
        sum = sum - bars[i - period].close + bars[i].close;
        result[i] = sum / period;
    }
    return result;
}

// ── EMA ─────────────────────────────────────────────────────────────────────

export function ema(bars: OhlcvBar[], period: number): (number | null)[] {
    const result: (number | null)[] = new Array(bars.length).fill(null);
    if (period < 1 || bars.length < period) return result;
    const multiplier = 2 / (period + 1);
    let sum = 0;
    for (let i = 0; i < period; i++) sum += bars[i].close;
    let prev = sum / period;
    result[period - 1] = prev;
    for (let i = period; i < bars.length; i++) {
        const curr = (bars[i].close - prev) * multiplier + prev;
        result[i] = curr;
        prev = curr;
    }
    return result;
}

// ── WMA ─────────────────────────────────────────────────────────────────────

export function wma(bars: OhlcvBar[], period: number): (number | null)[] {
    const result: (number | null)[] = new Array(bars.length).fill(null);
    if (period < 1 || bars.length < period) return result;
    const denominator = (period * (period + 1)) / 2;
    for (let i = period - 1; i < bars.length; i++) {
        let sum = 0;
        for (let j = 0; j < period; j++) {
            sum += bars[i - j].close * (period - j);
        }
        result[i] = sum / denominator;
    }
    return result;
}

// ── DEMA ────────────────────────────────────────────────────────────────────

export function dema(bars: OhlcvBar[], period: number): (number | null)[] {
    const e1 = ema(bars, period);
    // Reuse e1 values directly — avoid O(n²) bars.indexOf lookup per bar
    const e2 = ema(e1.map((v, i) => ({ ...bars[i], close: v ?? bars[i].close })), period);
    // e2 is aligned with bars but may have nulls where e1 was null
    const result: (number | null)[] = new Array(bars.length).fill(null);
    for (let i = 0; i < bars.length; i++) {
        if (e1[i] !== null && e2[i] !== null) {
            result[i] = 2 * e1[i]! - e2[i]!;
        }
    }
    return result;
}

// ── TEMA ────────────────────────────────────────────────────────────────────

export function tema(bars: OhlcvBar[], period: number): (number | null)[] {
    const e1 = ema(bars, period);
    // Reuse e1/e2 values directly — avoid O(n²) bars.indexOf lookup per bar
    const e2 = ema(e1.map((v, i) => ({ ...bars[i], close: v ?? bars[i].close })), period);
    const e3 = ema(e2.map((v, i) => ({ ...bars[i], close: v ?? bars[i].close })), period);
    const result: (number | null)[] = new Array(bars.length).fill(null);
    for (let i = 0; i < bars.length; i++) {
        if (e1[i] !== null && e2[i] !== null && e3[i] !== null) {
            result[i] = 3 * e1[i]! - 3 * e2[i]! + e3[i]!;
        }
    }
    return result;
}

// ── HMA ─────────────────────────────────────────────────────────────────────

export function hma(bars: OhlcvBar[], period: number): (number | null)[] {
    const halfPeriod = Math.floor(period / 2);
    const sqrtPeriod = Math.floor(Math.sqrt(period));
    const wmaHalf = wma(bars, halfPeriod > 0 ? halfPeriod : 1);
    const wmaFull = wma(bars, period);
    // HMA = WMA(2*WMA(period/2) - WMA(period), sqrt(period))
    const diffBars = bars.map((b, i) => ({
        ...b,
        close: wmaHalf[i] !== null && wmaFull[i] !== null
            ? 2 * wmaHalf[i]! - wmaFull[i]!
            : 0,
    }));
    return wma(diffBars, sqrtPeriod);
}

// ── RSI ─────────────────────────────────────────────────────────────────────

export function rsi(bars: OhlcvBar[], period: number): (number | null)[] {
    const result: (number | null)[] = new Array(bars.length).fill(null);
    if (period < 1 || bars.length < period) return result;

    const changes: number[] = [];
    for (let i = 1; i < bars.length; i++) {
        changes.push(bars[i].close - bars[i - 1].close);
    }

    let avgGain = 0;
    let avgLoss = 0;
    for (let i = 0; i < period; i++) {
        const change = changes[i];
        if (change > 0) avgGain += change;
        else avgLoss -= change;
    }
    avgGain /= period;
    avgLoss /= period;

    // avgLoss === 0 means no losing bars in the first period — RSI = 100
    if (avgLoss === 0) {
        result[period] = 100;
    } else {
        result[period] = 100 - 100 / (1 + avgGain / avgLoss);
    }

    for (let i = period; i < changes.length; i++) {
        const change = changes[i];
        const gain = change > 0 ? change : 0;
        const loss = change < 0 ? -change : 0;
        avgGain = (avgGain * (period - 1) + gain) / period;
        avgLoss = (avgLoss * (period - 1) + loss) / period;
        if (avgLoss === 0) {
            result[i + 1] = 100;
        } else {
            result[i + 1] = 100 - 100 / (1 + avgGain / avgLoss);
        }
    }
    return result;
}

// ── MACD ────────────────────────────────────────────────────────────────────

export interface MacdOutput {
    macd: (number | null)[];
    signal: (number | null)[];
    histogram: (number | null)[];
}

export function macd(
    bars: OhlcvBar[],
    fastPeriod = 12,
    slowPeriod = 26,
    signalPeriod = 9
): MacdOutput {
    const fastEma = ema(bars, fastPeriod);
    const slowEma = ema(bars, slowPeriod);
    const macdLine: (number | null)[] = new Array(bars.length).fill(null);
    for (let i = 0; i < bars.length; i++) {
        if (fastEma[i] !== null && slowEma[i] !== null) {
            macdLine[i] = fastEma[i]! - slowEma[i]!;
        }
    }
    // Compute signal EMA on the macdLine values
    const signalBars = bars.map((b, i) => ({ ...b, close: macdLine[i] ?? 0 }));
    const signalEma = ema(signalBars, signalPeriod);
    const histogram: (number | null)[] = new Array(bars.length).fill(null);
    for (let i = 0; i < bars.length; i++) {
        if (macdLine[i] !== null && signalEma[i] !== null) {
            histogram[i] = macdLine[i]! - signalEma[i]!;
        }
    }
    return { macd: macdLine, signal: signalEma, histogram };
}

// ── Stochastic / Williams%R helpers ──────────────────────────────────────────

/**
 * Monotonic deque for O(n) rolling window min/max.
 * Returns arrays of rolling lowest-low and highest-high for the given period.
 * Deque invariant: indices in decreasing high / increasing low order.
 * Out-of-window indices are evicted from the front before each step's read.
 */
function rollingMinMax(
    bars: OhlcvBar[],
    period: number
): { lows: (number | null)[]; highs: (number | null)[] } {
    const lows: (number | null)[] = new Array(bars.length).fill(null);
    const highs: (number | null)[] = new Array(bars.length).fill(null);
    if (period < 1 || bars.length < period) return { lows, highs };

    // max deque: decreasing high — front = highest-high index
    const maxDeque: number[] = [];
    // min deque: increasing low — front = lowest-low index
    const minDeque: number[] = [];

    for (let i = 0; i < bars.length; i++) {
        // Evict indices that have left the window
        while (maxDeque.length > 0 && maxDeque[0] <= i - period) maxDeque.shift();
        while (minDeque.length > 0 && minDeque[0] <= i - period) minDeque.shift();

        // Insert current bar: evict from back while it ruins monotonicity
        while (maxDeque.length > 0 && bars[i].high >= bars[maxDeque[maxDeque.length - 1]]!.high) {
            maxDeque.pop();
        }
        maxDeque.push(i);

        while (minDeque.length > 0 && bars[i].low <= bars[minDeque[minDeque.length - 1]]!.low) {
            minDeque.pop();
        }
        minDeque.push(i);

        // Read results once the window is full
        if (i >= period - 1) {
            highs[i] = bars[maxDeque[0]!].high;
            lows[i] = bars[minDeque[0]!].low;
        }
    }
    return { lows, highs };
}

// ── Stochastic ──────────────────────────────────────────────────────────────

export interface StochasticOutput {
    k: (number | null)[];
    d: (number | null)[];
}

export function stochastic(bars: OhlcvBar[], kPeriod = 14, dPeriod = 3): StochasticOutput {
    const k: (number | null)[] = new Array(bars.length).fill(null);
    const { lows, highs } = rollingMinMax(bars, kPeriod);
    for (let i = kPeriod - 1; i < bars.length; i++) {
        const lowestLow = lows[i];
        const highestHigh = highs[i];
        if (lowestLow !== null && highestHigh !== null && highestHigh !== lowestLow) {
            k[i] = ((bars[i].close - lowestLow) / (highestHigh - lowestLow)) * 100;
        }
    }
    const d = sma(bars.map((b, i) => ({ ...b, close: k[i] ?? 0 })), dPeriod);
    return { k, d };
}

// ── CCI ─────────────────────────────────────────────────────────────────────

export function cci(bars: OhlcvBar[], period: number): (number | null)[] {
    const result: (number | null)[] = new Array(bars.length).fill(null);
    if (period < 1 || bars.length < period) return result;
    for (let i = period - 1; i < bars.length; i++) {
        let sum = 0;
        // Single pass: compute sum and collect typical prices for mean-deviation
        const typicals: number[] = [];
        for (let j = 0; j < period; j++) {
            const typical = (bars[i - j].high + bars[i - j].low + bars[i - j].close) / 3;
            typicals.push(typical);
            sum += typical;
        }
        const smaVal = sum / period;
        let meanDev = 0;
        for (let j = 0; j < period; j++) {
            meanDev += Math.abs(typicals[j] - smaVal);
        }
        meanDev /= period;
        if (meanDev === 0) {
            result[i] = null;
        } else {
            result[i] = (typicals[0] - smaVal) / (0.015 * meanDev);
        }
    }
    return result;
}

// ── Williams %R ─────────────────────────────────────────────────────────────

export function williamsR(bars: OhlcvBar[], period: number): (number | null)[] {
    const result: (number | null)[] = new Array(bars.length).fill(null);
    const { lows, highs } = rollingMinMax(bars, period);
    for (let i = period - 1; i < bars.length; i++) {
        const lowestLow = lows[i];
        const highestHigh = highs[i];
        if (lowestLow !== null && highestHigh !== null && highestHigh !== lowestLow) {
            result[i] = ((highestHigh - bars[i].close) / (highestHigh - lowestLow)) * -100;
        }
    }
    return result;
}

// ── ROC ─────────────────────────────────────────────────────────────────────

export function roc(bars: OhlcvBar[], period: number): (number | null)[] {
    const result: (number | null)[] = new Array(bars.length).fill(null);
    if (period < 1 || bars.length <= period) return result;
    // A-26: Use period-1 for warmup to be consistent with other indicators
    for (let i = period - 1; i < bars.length; i++) {
        const prev = bars[i - (period - 1)].close;
        if (prev !== 0) {
            result[i] = ((bars[i].close - prev) / prev) * 100;
        }
    }
    return result;
}

// ── MFI ─────────────────────────────────────────────────────────────────────

export function mfi(bars: OhlcvBar[], period: number): (number | null)[] {
    const result: (number | null)[] = new Array(bars.length).fill(null);
    if (period < 1 || bars.length < period + 1) return result;
    for (let i = period; i < bars.length; i++) {
        let posFlow = 0;
        let negFlow = 0;
        for (let j = 0; j < period; j++) {
            const typical = bars[i - j].high + bars[i - j].low + bars[i - j].close;
            const prevTypical = bars[i - j - 1].high + bars[i - j - 1].low + bars[i - j - 1].close;
            const flow = typical * bars[i - j].volume;
            if (typical > prevTypical) posFlow += flow;
            else negFlow += flow;
        }
        if (negFlow !== 0) {
            const ratio = posFlow / negFlow;
            result[i] = 100 - 100 / (1 + ratio);
        } else {
            result[i] = 100;
        }
    }
    return result;
}

// ── Bollinger Bands ──────────────────────────────────────────────────────────

export interface BollingerBandsOutput {
    upper: (number | null)[];
    middle: (number | null)[];
    lower: (number | null)[];
}

export function bollingerBands(
    bars: OhlcvBar[],
    period: number = 20,
    stdDevMultiplier: number = 2
): BollingerBandsOutput {
    const middle = sma(bars, period);
    const upper: (number | null)[] = new Array(bars.length).fill(null);
    const lower: (number | null)[] = new Array(bars.length).fill(null);
    for (let i = period - 1; i < bars.length; i++) {
        if (middle[i] !== null) {
            let sumSq = 0;
            for (let j = 0; j < period; j++) {
                const diff = bars[i - j].close - middle[i]!;
                sumSq += diff * diff;
            }
            const stdDev = Math.sqrt(sumSq / period);
            upper[i] = middle[i]! + stdDevMultiplier * stdDev;
            lower[i] = middle[i]! - stdDevMultiplier * stdDev;
        }
    }
    return { upper, middle, lower };
}

// ── ATR ─────────────────────────────────────────────────────────────────────

export function atr(bars: OhlcvBar[], period: number): (number | null)[] {
    const result: (number | null)[] = new Array(bars.length).fill(null);
    if (period < 1 || bars.length < period + 1) return result;
    const tr: number[] = new Array(bars.length).fill(0);
    tr[0] = bars[0].high - bars[0].low;
    for (let i = 1; i < bars.length; i++) {
        const hl = bars[i].high - bars[i].low;
        const hc = Math.abs(bars[i].high - bars[i - 1].close);
        const lc = Math.abs(bars[i].low - bars[i - 1].close);
        tr[i] = Math.max(hl, hc, lc);
    }
    // ATR is Wilder's smoothed TR (same as EMA but with period, not multiplier 2/(n+1))
    let atrVal = 0;
    for (let i = 0; i < period; i++) atrVal += tr[i];
    atrVal /= period;
    result[period - 1] = atrVal;
    for (let i = period; i < bars.length; i++) {
        atrVal = (atrVal * (period - 1) + tr[i]) / period;
        result[i] = atrVal;
    }
    return result;
}

// ── Keltner Channels ─────────────────────────────────────────────────────────

export interface KeltnerChannelsOutput {
    upper: (number | null)[];
    middle: (number | null)[];
    lower: (number | null)[];
}

export function keltnerChannels(
    bars: OhlcvBar[],
    emaPeriod: number = 20,
    atrPeriod: number = 10,
    multiplier: number = 2
): KeltnerChannelsOutput {
    const middle = ema(bars, emaPeriod);
    const atrVals = atr(bars, atrPeriod);
    const upper: (number | null)[] = new Array(bars.length).fill(null);
    const lower: (number | null)[] = new Array(bars.length).fill(null);
    for (let i = 0; i < bars.length; i++) {
        if (middle[i] !== null && atrVals[i] !== null) {
            upper[i] = middle[i]! + multiplier * atrVals[i]!;
            lower[i] = middle[i]! - multiplier * atrVals[i]!;
        }
    }
    return { upper, middle, lower };
}

// ── StdDev ──────────────────────────────────────────────────────────────────

export function stdDev(bars: OhlcvBar[], period: number): (number | null)[] {
    const result: (number | null)[] = new Array(bars.length).fill(null);
    if (period < 1 || bars.length < period) return result;
    for (let i = period - 1; i < bars.length; i++) {
        let sum = 0;
        for (let j = 0; j < period; j++) sum += bars[i - j].close;
        const mean = sum / period;
        let sumSq = 0;
        for (let j = 0; j < period; j++) {
            const diff = bars[i - j].close - mean;
            sumSq += diff * diff;
        }
        result[i] = Math.sqrt(sumSq / period);
    }
    return result;
}

// ── OBV ─────────────────────────────────────────────────────────────────────

export function obv(bars: OhlcvBar[]): (number | null)[] {
    const result: (number | null)[] = new Array(bars.length).fill(null);
    if (bars.length === 0) return result;
    result[0] = bars[0].volume;
    for (let i = 1; i < bars.length; i++) {
        if (bars[i].close > bars[i - 1].close) {
            result[i] = (result[i - 1] ?? 0) + bars[i].volume;
        } else if (bars[i].close < bars[i - 1].close) {
            result[i] = (result[i - 1] ?? 0) - bars[i].volume;
        } else {
            result[i] = result[i - 1];
        }
    }
    return result;
}

// ── VWAP ─────────────────────────────────────────────────────────────────────

export function vwap(bars: OhlcvBar[]): (number | null)[] {
    const result: (number | null)[] = new Array(bars.length).fill(null);
    let cumulativeTPV = 0;
    let cumulativeVolume = 0;
    for (let i = 0; i < bars.length; i++) {
        const tp = (bars[i].high + bars[i].low + bars[i].close) / 3;
        cumulativeTPV += tp * bars[i].volume;
        cumulativeVolume += bars[i].volume;
        result[i] = cumulativeVolume !== 0 ? cumulativeTPV / cumulativeVolume : null;
    }
    return result;
}

// ── Volume SMA ───────────────────────────────────────────────────────────────

export function volumeSma(bars: OhlcvBar[], period: number): (number | null)[] {
    const result: (number | null)[] = new Array(bars.length).fill(null);
    if (period < 1 || bars.length < period) return result;
    let sum = 0;
    for (let i = 0; i < period; i++) sum += bars[i].volume;
    result[period - 1] = sum / period;
    for (let i = period; i < bars.length; i++) {
        sum = sum - bars[i - period].volume + bars[i].volume;
        result[i] = sum / period;
    }
    return result;
}

// ── Pivot Points ─────────────────────────────────────────────────────────────

export interface PivotPointsOutput {
    pivot: (number | null)[];
    r1: (number | null)[];
    r2: (number | null)[];
    r3: (number | null)[];
    s1: (number | null)[];
    s2: (number | null)[];
    s3: (number | null)[];
}

export function pivotPoints(bars: OhlcvBar[]): PivotPointsOutput {
    const result: PivotPointsOutput = {
        pivot: new Array(bars.length).fill(null),
        r1: new Array(bars.length).fill(null),
        r2: new Array(bars.length).fill(null),
        r3: new Array(bars.length).fill(null),
        s1: new Array(bars.length).fill(null),
        s2: new Array(bars.length).fill(null),
        s3: new Array(bars.length).fill(null),
    };
    for (let i = 1; i < bars.length; i++) {
        const prev = bars[i - 1];
        const p = (prev.high + prev.low + prev.close) / 3;
        result.pivot[i] = p;
        result.r1[i] = 2 * p - prev.low;
        result.s1[i] = 2 * p - prev.high;
        result.r2[i] = p + (prev.high - prev.low);
        result.s2[i] = p - (prev.high - prev.low);
        result.r3[i] = prev.high + 2 * (p - prev.low);
        result.s3[i] = prev.low - 2 * (prev.high - p);
    }
    return result;
}

// ── Donchian Channels ─────────────────────────────────────────────────────────

export interface DonchianChannelsOutput {
    upper: (number | null)[];
    middle: (number | null)[];
    lower: (number | null)[];
}

export function donchianChannels(bars: OhlcvBar[], period: number): DonchianChannelsOutput {
    const upper: (number | null)[] = new Array(bars.length).fill(null);
    const middle: (number | null)[] = new Array(bars.length).fill(null);
    const lower: (number | null)[] = new Array(bars.length).fill(null);
    if (period < 1 || bars.length < period) return { upper, middle, lower };
    for (let i = period - 1; i < bars.length; i++) {
        let highest = -Infinity;
        let lowest = Infinity;
        for (let j = 0; j < period; j++) {
            if (bars[i - j].high > highest) highest = bars[i - j].high;
            if (bars[i - j].low < lowest) lowest = bars[i - j].low;
        }
        upper[i] = highest;
        lower[i] = lowest;
        middle[i] = (highest + lowest) / 2;
    }
    return { upper, middle, lower };
}

// ── Highest / Lowest ──────────────────────────────────────────────────────────

/** Highest high over a lookback period. Equivalent to TradingView's highest(). */
export function highest(bars: OhlcvBar[], period: number): (number | null)[] {
    const result: (number | null)[] = new Array(bars.length).fill(null);
    if (period < 1 || bars.length < period) return result;
    for (let i = period - 1; i < bars.length; i++) {
        let max = -Infinity;
        for (let j = 0; j < period; j++) {
            if (bars[i - j].high > max) max = bars[i - j].high;
        }
        result[i] = max;
    }
    return result;
}

/** Lowest low over a lookback period. Equivalent to TradingView's lowest(). */
export function lowest(bars: OhlcvBar[], period: number): (number | null)[] {
    const result: (number | null)[] = new Array(bars.length).fill(null);
    if (period < 1 || bars.length < period) return result;
    for (let i = period - 1; i < bars.length; i++) {
        let min = Infinity;
        for (let j = 0; j < period; j++) {
            if (bars[i - j].low < min) min = bars[i - j].low;
        }
        result[i] = min;
    }
    return result;
}

// ── Ichimoku ─────────────────────────────────────────────────────────────────

export interface IchimokuOutput {
    tenkan: (number | null)[];
    kijun: (number | null)[];
    senkouA: (number | null)[];
    senkouB: (number | null)[];
    chikou: (number | null)[];
}

export function ichimoku(
    bars: OhlcvBar[],
    tenkanPeriod = 9,
    kijunPeriod = 26,
    senkouBPeriod = 52
): IchimokuOutput {
    const tenkan: (number | null)[] = new Array(bars.length).fill(null);
    const kijun: (number | null)[] = new Array(bars.length).fill(null);
    const senkouA: (number | null)[] = new Array(bars.length).fill(null);
    const senkouB: (number | null)[] = new Array(bars.length).fill(null);
    const chikou: (number | null)[] = new Array(bars.length).fill(null);

    const maxPeriod = Math.max(tenkanPeriod, kijunPeriod, senkouBPeriod);

    function highestHigh(idx: number, period: number): number {
        let h = -Infinity;
        for (let j = 0; j < period; j++) {
            if (idx - j >= 0 && bars[idx - j].high > h) h = bars[idx - j].high;
        }
        return h;
    }
    function lowestLow(idx: number, period: number): number {
        let l = Infinity;
        for (let j = 0; j < period; j++) {
            if (idx - j >= 0 && bars[idx - j].low < l) l = bars[idx - j].low;
        }
        return l;
    }

    for (let i = maxPeriod - 1; i < bars.length; i++) {
        tenkan[i] = (highestHigh(i, tenkanPeriod) + lowestLow(i, tenkanPeriod)) / 2;
        kijun[i] = (highestHigh(i, kijunPeriod) + lowestLow(i, kijunPeriod)) / 2;
        senkouA[i] = (tenkan[i]! + kijun[i]!) / 2;
        senkouB[i] = (highestHigh(i, senkouBPeriod) + lowestLow(i, senkouBPeriod)) / 2;
        chikou[i] = bars[i].close; // lagged by kijunPeriod in proper use
    }
    return { tenkan, kijun, senkouA, senkouB, chikou };
}

// ── ADX ─────────────────────────────────────────────────────────────────────

export interface AdxOutput {
    adx: (number | null)[];
    plusDi: (number | null)[];
    minusDi: (number | null)[];
}

export function adx(bars: OhlcvBar[], period: number = 14): AdxOutput {
    const result: AdxOutput = {
        adx: new Array(bars.length).fill(null),
        plusDi: new Array(bars.length).fill(null),
        minusDi: new Array(bars.length).fill(null),
    };
    if (bars.length < period + 1) return result;

    const tr: number[] = new Array(bars.length).fill(0);
    const plusDm: number[] = new Array(bars.length).fill(0);
    const minusDm: number[] = new Array(bars.length).fill(0);

    for (let i = 1; i < bars.length; i++) {
        const hl = bars[i].high - bars[i].low;
        const hc = Math.abs(bars[i].high - bars[i - 1].close);
        const lc = Math.abs(bars[i].low - bars[i - 1].close);
        tr[i] = Math.max(hl, hc, lc);
        const upMove = bars[i].high - bars[i - 1].high;
        const downMove = bars[i - 1].low - bars[i].low;
        plusDm[i] = upMove > downMove && upMove > 0 ? upMove : 0;
        minusDm[i] = downMove > upMove && downMove > 0 ? downMove : 0;
    }

    // Wilder smoothing
    let atrVal = 0;
    for (let i = 1; i <= period; i++) atrVal += tr[i];
    atrVal /= period;
    let plusDiSmooth = 0;
    let minusDiSmooth = 0;
    for (let i = 1; i <= period; i++) {
        plusDiSmooth += plusDm[i];
        minusDiSmooth += minusDm[i];
    }
    plusDiSmooth /= period;
    minusDiSmooth /= period;

    for (let i = period; i < bars.length; i++) {
        atrVal = (atrVal * (period - 1) + tr[i]) / period;
        plusDiSmooth = (plusDiSmooth * (period - 1) + plusDm[i]) / period;
        minusDiSmooth = (minusDiSmooth * (period - 1) + minusDm[i]) / period;
        const plusDi = atrVal !== 0 ? (plusDiSmooth / atrVal) * 100 : 0;
        const minusDi = atrVal !== 0 ? (minusDiSmooth / atrVal) * 100 : 0;
        result.plusDi[i] = plusDi;
        result.minusDi[i] = minusDi;
        const dx = (plusDi + minusDi) !== 0 ? (Math.abs(plusDi - minusDi) / (plusDi + minusDi)) * 100 : 0;
        // ADX is smoothed DX
        if (i === period) {
            result.adx[i] = dx;
        } else {
            result.adx[i] = (result.adx[i - 1]! * (period - 1) + dx) / period;
        }
    }
    return result;
}

// ── Parabolic SAR ───────────────────────────────────────────────────────────

export function parabolicSar(
    bars: OhlcvBar[],
    afStart: number = 0.02,
    afIncrement: number = 0.02,
    afMax: number = 0.2
): (number | null)[] {
    const result: (number | null)[] = new Array(bars.length).fill(null);
    if (bars.length < 2) return result;

    let isUptrend = true;
    let sar = bars[0].low;
    let ep = bars[0].high;
    let af = afStart;

    result[0] = sar;
    for (let i = 1; i < bars.length; i++) {
        const prevSar = sar;
        sar = prevSar + af * (ep - prevSar);
        if (isUptrend) {
            if (bars[i].low < sar) {
                isUptrend = false;
                sar = ep;
                ep = bars[i].low;
                af = afStart;
            } else {
                if (bars[i].high > ep) {
                    ep = bars[i].high;
                    af = Math.min(af + afIncrement, afMax);
                }
                if (bars[i].low < sar) sar = bars[i].low;
            }
        } else {
            if (bars[i].high > sar) {
                isUptrend = true;
                sar = ep;
                ep = bars[i].high;
                af = afStart;
            } else {
                if (bars[i].low < ep) {
                    ep = bars[i].low;
                    af = Math.min(af + afIncrement, afMax);
                }
                if (bars[i].high > sar) sar = bars[i].high;
            }
        }
        result[i] = sar;
    }
    return result;
}

// ── Supertrend ───────────────────────────────────────────────────────────────

export interface SupertrendOutput {
    supertrend: (number | null)[];
    direction: (number | null)[]; // 1 = uptrend, -1 = downtrend
}

export function supertrend(
    bars: OhlcvBar[],
    period: number = 10,
    multiplier: number = 3
): SupertrendOutput {
    const atrVals = atr(bars, period);
    const result: SupertrendOutput = {
        supertrend: new Array(bars.length).fill(null),
        direction: new Array(bars.length).fill(null),
    };
    if (bars.length < period + 1) return result;

    let isUptrend = true;
    let finalBand = 0;

    for (let i = period; i < bars.length; i++) {
        const hl2 = (bars[i].high + bars[i].low) / 2;
        const upperBand = hl2 + multiplier * (atrVals[i] ?? 0);
        const lowerBand = hl2 - multiplier * (atrVals[i] ?? 0);
        const prevSt = result.supertrend[i - 1];
        const prevDir = result.direction[i - 1] ?? 1;

        if (atrVals[i] === null) continue;

        if (isUptrend) {
            if (prevSt !== null && bars[i].close < prevSt) {
                isUptrend = false;
                finalBand = upperBand;
            } else {
                finalBand = Math.max(lowerBand, prevSt ?? lowerBand);
            }
        } else {
            if (prevSt !== null && bars[i].close > prevSt) {
                isUptrend = true;
                finalBand = lowerBand;
            } else {
                finalBand = Math.min(upperBand, prevSt ?? upperBand);
            }
        }
        result.supertrend[i] = finalBand;
        result.direction[i] = isUptrend ? 1 : -1;
    }
    return result;
}

// ── Registry ─────────────────────────────────────────────────────────────────

export type IndicatorName =
    | "sma" | "ema" | "wma" | "dema" | "tema" | "hma"
    | "rsi" | "macd" | "stochastic" | "cci" | "williamsR" | "roc" | "mfi"
    | "bollingerBands" | "atr" | "keltnerChannels" | "stdDev"
    | "obv" | "vwap" | "volumeSma" | "pivotPoints" | "donchianChannels"
    | "ichimoku" | "adx" | "parabolicSar" | "supertrend"
    | "highest" | "lowest";

export interface IndicatorResult {
    name: IndicatorName;
    values: (number | null)[];
    outputs?: Record<string, (number | null)[]>;
}

export function computeIndicator(
    bars: OhlcvBar[],
    name: IndicatorName,
    params: Record<string, number | string>
): IndicatorResult {
    // Normalize common parameter name aliases before processing
    const normalizedParams: Record<string, number | string> = { ...params };
    // MACD aliases
    if ("fastPeriod" in normalizedParams && !("fast" in normalizedParams)) {
        normalizedParams.fast = normalizedParams.fastPeriod as number;
    }
    if ("slowPeriod" in normalizedParams && !("slow" in normalizedParams)) {
        normalizedParams.slow = normalizedParams.slowPeriod as number;
    }
    if ("signalPeriod" in normalizedParams && !("signal" in normalizedParams)) {
        normalizedParams.signal = normalizedParams.signalPeriod as number;
    }
    // Stochastic aliases
    if ("k" in normalizedParams && !("kPeriod" in normalizedParams)) {
        normalizedParams.kPeriod = normalizedParams.k as number;
    }
    if ("KPeriod" in normalizedParams && !("kPeriod" in normalizedParams)) {
        normalizedParams.kPeriod = normalizedParams.KPeriod as number;
    }
    if ("d" in normalizedParams && !("dPeriod" in normalizedParams)) {
        normalizedParams.dPeriod = normalizedParams.d as number;
    }
    if ("DPeriod" in normalizedParams && !("dPeriod" in normalizedParams)) {
        normalizedParams.dPeriod = normalizedParams.DPeriod as number;
    }
    // Alias Slowing/slowing → kPeriod for slow stochastic (period = slowing value)
    if (("Slowing" in normalizedParams || "slowing" in normalizedParams) && !("kPeriod" in normalizedParams)) {
        normalizedParams.kPeriod = (normalizedParams.Slowing ?? normalizedParams.slowing) as number;
    }
    // Alias std → stdDev for Bollinger Bands
    if ("std" in normalizedParams && !("stdDev" in normalizedParams)) {
        normalizedParams.stdDev = normalizedParams.std as number;
    }

    const p = (key: string, fallback: number): number =>
        typeof normalizedParams[key] === "number" ? (normalizedParams[key] as number) : fallback;

    let normalizedName = String(name || "").replace(/\s+/g, "").toLowerCase();
    
    // Map common lowercased names back to their camelCase representations for the switch
    const camelMap: Record<string, string> = {
        "bollingerbands": "bollingerBands",
        "williamsr": "williamsR",
        "keltnerchannels": "keltnerChannels",
        "stddev": "stdDev",
        "volumesma": "volumeSma",
        "pivotpoints": "pivotPoints",
        "donchianchannels": "donchianChannels",
        "parabolicsar": "parabolicSar",
    };
    normalizedName = camelMap[normalizedName] ?? normalizedName;

    switch (normalizedName) {
        case "sma": return { name, values: sma(bars, p("period", 14)) };
        case "ema": return { name, values: ema(bars, p("period", 14)) };
        case "wma": return { name, values: wma(bars, p("period", 14)) };
        case "dema": return { name, values: dema(bars, p("period", 14)) };
        case "tema": return { name, values: tema(bars, p("period", 14)) };
        case "hma": return { name, values: hma(bars, p("period", 14)) };
        case "rsi": return { name, values: rsi(bars, p("period", 14)) };
        case "macd": {
            const out = macd(bars, p("fast", 12), p("slow", 26), p("signal", 9));
            return { name, values: out.macd, outputs: { signal: out.signal, histogram: out.histogram } };
        }
        case "stochastic": {
            const out = stochastic(bars, p("kPeriod", 14), p("dPeriod", 3));
            return { name, values: out.k, outputs: { d: out.d } };
        }
        case "cci": return { name, values: cci(bars, p("period", 14)) };
        case "williamsR": return { name, values: williamsR(bars, p("period", 14)) };
        case "roc": return { name, values: roc(bars, p("period", 14)) };
        case "mfi": return { name, values: mfi(bars, p("period", 14)) };
        case "bollingerBands": {
            const out = bollingerBands(bars, p("period", 20), p("stdDev", 2));
            return { name, values: out.middle, outputs: { upper: out.upper, lower: out.lower } };
        }
        case "atr": return { name, values: atr(bars, p("period", 14)) };
        case "keltnerChannels": {
            const out = keltnerChannels(bars, p("emaPeriod", 20), p("atrPeriod", 10), p("multiplier", 2));
            return { name, values: out.middle, outputs: { upper: out.upper, lower: out.lower } };
        }
        case "stdDev": return { name, values: stdDev(bars, p("period", 20)) };
        case "obv": return { name, values: obv(bars) };
        case "vwap": return { name, values: vwap(bars) };
        case "volumeSma": return { name, values: volumeSma(bars, p("period", 20)) };
        case "pivotPoints": {
            const out = pivotPoints(bars);
            return { name, values: out.pivot, outputs: { r1: out.r1, r2: out.r2, r3: out.r3, s1: out.s1, s2: out.s2, s3: out.s3 } };
        }
        case "donchianChannels": {
            const out = donchianChannels(bars, p("period", 20));
            return { name, values: out.middle, outputs: { upper: out.upper, lower: out.lower } };
        }
        case "ichimoku": {
            const out = ichimoku(bars, p("tenkanPeriod", 9), p("kijunPeriod", 26), p("senkouBPeriod", 52));
            return { name, values: out.tenkan, outputs: { kijun: out.kijun, senkouA: out.senkouA, senkouB: out.senkouB, chikou: out.chikou } };
        }
        case "adx": {
            const out = adx(bars, p("period", 14));
            return { name, values: out.adx, outputs: { plusDi: out.plusDi, minusDi: out.minusDi } };
        }
        case "parabolicSar": return { name, values: parabolicSar(bars, p("afStart", 0.02), p("afIncrement", 0.02), p("afMax", 0.2)) };
        case "supertrend": {
            const out = supertrend(bars, p("period", 10), p("multiplier", 3));
            return { name, values: out.supertrend, outputs: { direction: out.direction } };
        }
        case "highest": return { name, values: highest(bars, p("period", 20)) };
        case "lowest": return { name, values: lowest(bars, p("period", 20)) };
        default:
            throw new Error(`Unknown indicator: '${name}'`);
    }
}
