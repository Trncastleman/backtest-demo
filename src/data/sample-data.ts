import type { OhlcvBar } from "@/engine/types";

const HOUR = 60 * 60;

function round(value: number, decimals = 5): number {
  const scale = 10 ** decimals;
  return Math.round(value * scale) / scale;
}

function seededNoise(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

export function generateSampleBars(count = 720): OhlcvBar[] {
  const start = Math.floor(Date.UTC(2025, 0, 2, 0, 0, 0) / 1000);
  const bars: OhlcvBar[] = [];
  let close = 1.085;

  for (let i = 0; i < count; i++) {
    const trend = Math.sin(i / 65) * 0.00055 + Math.sin(i / 17) * 0.00022;
    const shock = (seededNoise(i + 11) - 0.5) * 0.00055;
    const open = close;
    close = Math.max(1.045, open + trend + shock);
    const wick = 0.00035 + seededNoise(i + 37) * 0.00045;
    const high = Math.max(open, close) + wick;
    const low = Math.min(open, close) - wick * (0.8 + seededNoise(i + 71) * 0.4);
    bars.push({
      time: start + i * HOUR,
      open: round(open),
      high: round(high),
      low: round(low),
      close: round(close),
      volume: Math.round(900 + seededNoise(i + 101) * 1600),
    });
  }

  return bars;
}
