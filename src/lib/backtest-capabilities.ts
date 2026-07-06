export const LOCAL_DATA_TIMEFRAMES = ["M5", "M15", "M30", "H1", "H4", "D1"] as const;
export const LOCAL_ENGINE_TIMEFRAMES = LOCAL_DATA_TIMEFRAMES;
export const MT5_TIMEFRAMES = ["M1", "M5", "M15", "M30", "H1", "H4", "D1"] as const;

export const BASIC_ALLOWED_TIMEFRAMES = ["M15", "M30", "H1", "H4", "D1"] as const;
export const PRO_ALLOWED_TIMEFRAMES = ["M1", "M5", "M15", "M30", "H1", "H4", "D1"] as const;

export type LocalDataTimeframe = (typeof LOCAL_DATA_TIMEFRAMES)[number];
export type LocalEngineTimeframe = (typeof LOCAL_ENGINE_TIMEFRAMES)[number];
export type Mt5Timeframe = (typeof MT5_TIMEFRAMES)[number];

export function isLocalDataTimeframe(tf: string): tf is LocalDataTimeframe {
  return (LOCAL_DATA_TIMEFRAMES as readonly string[]).includes(tf);
}

export function isLocalEngineTimeframe(tf: string): tf is LocalEngineTimeframe {
  return (LOCAL_ENGINE_TIMEFRAMES as readonly string[]).includes(tf);
}

export function isMt5Timeframe(tf: string): tf is Mt5Timeframe {
  return (MT5_TIMEFRAMES as readonly string[]).includes(tf);
}

export function isBasicAllowedTimeframe(tf: string): boolean {
  return (BASIC_ALLOWED_TIMEFRAMES as readonly string[]).includes(tf);
}

export function isProAllowedTimeframe(tf: string): boolean {
  return (PRO_ALLOWED_TIMEFRAMES as readonly string[]).includes(tf);
}

export function isUserAllowedTimeframe(timeframe: string): boolean {
  return isProAllowedTimeframe(timeframe);
}
