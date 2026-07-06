// ── OHLCV Bar ─────────────────────────────────────────────────────────────────

export interface OhlcvBar {
    time: number;     // Unix timestamp (seconds)
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

// ── RuleNode (strategy entry/exit condition tree) ────────────────────────────

export type RuleNode =
    | {
        operator: "crosses_above" | "crosses_below" | "greater_than" | "less_than"
            | "greater_than_or_equal" | "less_than_or_equal" | "equals";
        left: Operand;
        right: Operand;
    }
    | { operator: "and" | "or"; conditions: RuleNode[]; }
    | { operator: "not"; condition: RuleNode; };

export type Operand =
    | { type: "indicator"; name: string; parameters: Record<string, number | string>; output?: string; shift?: number; timeframe?: string; symbol?: string }
    | { type: "price"; field: "open" | "high" | "low" | "close" | "volume" }
    | { type: "constant"; value: number };

// ── Multi-Symbol Backtest ─────────────────────────────────────────────────────

/**
 * Per-symbol backtest result.
 * Each symbol maintains its own trades, equity curve, and stats.
 */
export interface SymbolBacktestResult {
    symbol: string;
    trades: BacktestTrade[];
    equityCurve: EquityPoint[];
    stats: BacktestEngineStats;
}

/**
 * Combined portfolio-level backtest result.
 * Aggregates results across multiple symbols with unified stats.
 */
export interface PortfolioBacktestResult {
    symbolResults: SymbolBacktestResult[];
    combinedStats: BacktestEngineStats;
    totalEquityCurve: EquityPoint[];
}

// ── Backtest Config ───────────────────────────────────────────────────────────

export interface ExitConfig {
    /** Absolute price distance in quote units, NOT pips.
     * E.g., EURUSD: 0.0100 = 100 pips, 0.00100 = 10 pips.
     * USDJPY: 1.00 = 100 pips, 0.100 = 10 pips.
     * Divide pips by pipSize to get the correct value. */
    takeProfit?: number;
    /** Absolute price distance in quote units, NOT pips. */
    stopLoss?: number;
    /** Activation threshold AND trail distance (same value used for both).
     * In price units (same as takeProfit/stopLoss), NOT pips. */
    trailingStop?: number;
    // ATR-based exits: computed at entry time using current bar's ATR value
    takeProfitAtr?: { multiplier: number; period: number };
    stopLossAtr?: { multiplier: number; period: number };
}

export interface PositionSizing {
    method: "fixed_lot" | "percentage_equity" | "dynamic";
    value: number;        // lot size, percentage (0.01 = 1%), or risk multiplier
}

/**
 * Volume-aware fill model.
 * Prevents orders from filling beyond what historical bar volume could support.
 */
export interface FillModel {
    /** Fraction of bar's volume that can be filled per lot unit. Default: 1.0 (no limit). */
    fillRatio: number;
}

export interface EntryConditionGroup {
    direction: TradeDirection;
    rules: RuleNode[]; // entry conditions (all must pass = AND)
    timeframe?: string; // optional: which timeframe this group's indicators are computed on (default: primary)
    symbol?: string;    // optional: which symbol this group's conditions apply to (default: primary symbol)
}

/**
 * Slippage model for entry and exit fills.
 * Models the reality that orders fill at worse-than-mid due to latency and market impact.
 */
export interface SlippageConfig {
    /** Fixed slippage in pips applied to every fill. Default: 0 (no fixed slippage). */
    fixedPips?: number;
    /**
     * Volatility-scaled slippage multiplier.
     * Scales slippage proportional to ATR: slippage = multiplier * ATR / pipSize.
     * Default: 0 (no volatility adjustment).
     */
    atrMultiplier?: number;
}

/**
 * Spread cost model.
 * Adds a fixed spread cost per trade (applied to both entry and exit).
 */
export interface SpreadConfig {
    /** Fixed spread cost in pips per trade (applied at both entry and exit). Default: 0. */
    fixedPips?: number;
}

/**
 * Short selling cost model.
 * Borrow rate: annual % charged on short position value (held overnight).
 * Short positions are charged borrow fee each bar they are held.
 */
export interface ShortConfig {
    /** Annual borrow rate as a fraction (e.g., 0.03 = 3% per year). Default: 0 (free to short). */
    borrowRate?: number;
}

export interface BacktestConfig {
    symbol: string;           // Primary/backwards-compatible symbol
    symbols: string[];        // All symbols in the strategy e.g. ["EURUSD", "GBPUSD"]
    timeframe: string;
    timeframes: string[]; // e.g. ["H1", "H4"] for multi-timeframe strategies
    fromDate: string;  // ISO date string
    toDate: string;
    initialDeposit: number;
    entryConditions: EntryConditionGroup[]; // separate rule sets per direction
    exitRules: ExitConfig;
    positionSizing: PositionSizing;
    /** Volume-aware fill model. If not set, no volume check is performed (backwards-compatible). */
    fillModel?: FillModel;
    /** Commission per lot in dollars (round-trip). Defaults to $7/lot if not set. */
    commissionPerLot?: number;
    /** Tick value in dollars per pip per lot. Defaults to $10/pip/lot if not set. */
    tickValue?: number;
    /** Slippage model. Defaults to no slippage if not set. */
    slippage?: SlippageConfig;
    /** Spread cost model. Defaults to no spread cost if not set. */
    spread?: SpreadConfig;
    /** Short selling cost model. Defaults to no borrow/margin costs if not set. */
    shortConfig?: ShortConfig;
}

// ── Trade Direction ──────────────────────────────────────────────────────────

export type TradeDirection = "long" | "short" | "call" | "put";

// ── Trade Record ─────────────────────────────────────────────────────────────

export interface BacktestTrade {
    id: string;
    entryTime: number;   // Unix timestamp (seconds)
    exitTime: number;
    direction: TradeDirection;
    entryPrice: number;
    exitPrice: number;
    lotSize: number;
    pnl: number;         // net profit/loss including commission
    commission: number;
}

// ── Equity Curve ─────────────────────────────────────────────────────────────

export interface EquityPoint {
    time: number;        // Unix timestamp (seconds)
    equity: number;
    drawdown: number;    // drawdown percentage at this point (0-100)
}

// ── Backtest Result ───────────────────────────────────────────────────────────

export interface BacktestEngineStats {
    netProfit: number;
    totalTrades: number;
    winRate: number;
    maxDrawdown: number;  // percentage (0-100), not fraction
    sharpeRatio: number;
    sortinoRatio: number;
    cagr: number;
    profitFactor: number;
    avgWin: number;
    avgLoss: number;
    timeframe: string;
}

export interface BacktestEngineResult {
    trades: BacktestTrade[];
    equityCurve: EquityPoint[];
    stats: BacktestEngineStats;
}

// ── Forward Test Projection ──────────────────────────────────────────────────

export interface ProjectionResult {
    historicalStats: BacktestEngineStats;
    projectedStats: BacktestEngineStats;
    projectionStartIndex: number;
    projectionEndIndex: number;
    historicalEquityCurve: EquityPoint[];
    projectedEquityCurve: EquityPoint[];
}

// ── Walk-Forward ─────────────────────────────────────────────────────────────

export interface WalkForwardSegment {
    /** Index of the last in-sample bar (inclusive). */
    trainEndIndex: number;
    /** Index of the last out-of-sample bar (inclusive). */
    testEndIndex: number;
    /** Equity at trainEndIndex (starting equity for the test period). */
    trainEndingEquity: number;
    inSampleStats: BacktestEngineStats;
    outOfSampleStats: BacktestEngineStats;
    /**
     * In-sample equity curve restricted to this segment's training window.
     * Starts at bar 0 with initialDeposit and ends at trainEndIndex.
     */
    inSampleEquityCurve: EquityPoint[];
    /**
     * Out-of-sample equity curve for this segment.
     * Anchored to trainEndingEquity so multiple segments can be chained.
     */
    outOfSampleEquityCurve: EquityPoint[];
}

export interface WalkForwardResult {
    segments: WalkForwardSegment[];
    /** Average in-sample Sharpe across all segments. */
    avgInSampleSharpe: number;
    /** Average out-of-sample Sharpe across all segments. */
    avgOutOfSampleSharpe: number;
    /** Average Sharpe ratio degradation (IS minus OOS). */
    avgSharpeDecay: number;
}

export interface WalkForwardConfig {
    /** Fraction of data used for training in each step (0.0-1.0). Default: 0.8. */
    trainRatio?: number;
    /** Fraction of data to step forward each iteration (0.0-1.0). Default: 0.2. */
    stepRatio?: number;
}

// ── Open Position (runtime only) ─────────────────────────────────────────────

export interface OpenTrade {
    id: string;
    entryTime: number;
    direction: TradeDirection;
    entryPrice: number;
    lotSize: number;
    commission: number;
    /** Spread cost for round-trip (entry + exit) in dollars. Included in PnL at exit. */
    spreadCost: number;
    /** Tick value in $/pip/lot at time of entry — used for PnL computation at exit. */
    tickValue: number;
    /** Accumulated borrow cost for short positions (in dollars). Deducted at exit. */
    borrowCost: number;
    /** Annual borrow rate as fraction (e.g., 0.03 = 3%/year). Used to compute daily borrow fees. */
    borrowRate: number;
    tp?: number;
    sl?: number;
    trailingStop?: number;
    trailingStopActivated: boolean;
    highestPrice: number; // for long trailing stop
    lowestPrice: number;  // for short trailing stop
}
