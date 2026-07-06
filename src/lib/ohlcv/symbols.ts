import { MT5_TIMEFRAMES, isMt5Timeframe } from "@/lib/backtest-capabilities";

export const APP_SYMBOLS = [
  "EURUSD",
  "GBPUSD",
  "USDJPY",
  "USDCHF",
  "AUDUSD",
  "USDCAD",
  "NZDUSD",
  "EURGBP",
  "EURJPY",
  "GBPJPY",
  "XAUUSD",
  "XAGUSD",
  "US30",
  "US500",
  "NAS100",
  "GER40",
  "UK100",
  "JPN225",
  "BTCUSD",
  "ETHUSD",
  "USDMXN",
  "USDZAR",
  "USDTRY",
  "EURTRY",
] as const;

export const APP_TIMEFRAMES = MT5_TIMEFRAMES;

export type AppSymbol = (typeof APP_SYMBOLS)[number];
export type AppTimeframe = (typeof APP_TIMEFRAMES)[number];

export function isAppSymbol(value: string): value is AppSymbol {
  return (APP_SYMBOLS as readonly string[]).includes(value);
}

export function isAppTimeframe(value: string): value is AppTimeframe {
  return isMt5Timeframe(value);
}

const DUKASCOPY_INSTRUMENT_OVERRIDES: Partial<Record<AppSymbol, string>> = {
  US30: "usa30idxusd",
  US500: "usa500idxusd",
  NAS100: "usatechidxusd",
  GER40: "deuidxeur",
  UK100: "gbridxgbp",
  JPN225: "jpnidxjpy",
};

export function toDukascopyInstrument(symbol: AppSymbol): string {
  const override = DUKASCOPY_INSTRUMENT_OVERRIDES[symbol];
  if (override) return override;
  return symbol.toLowerCase();
}

export function toDukascopyTimeframe(timeframe: AppTimeframe): string {
  return timeframe.toLowerCase();
}
