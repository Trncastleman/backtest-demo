import type { OhlcvBar } from "@/engine/types";

function parseTimestamp(value: string): number {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const raw = Number(trimmed);
    return raw > 9_999_999_999 ? Math.floor(raw / 1000) : raw;
  }
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) throw new Error(`Invalid timestamp: ${value}`);
  return Math.floor(parsed / 1000);
}

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_-]+/g, "");
}

export function parseOhlcvCsv(csv: string): OhlcvBar[] {
  const lines = csv
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length < 2) {
    throw new Error("CSV needs a header row and at least one data row.");
  }

  const headers = lines[0].split(",").map(normalizeHeader);
  const indexOf = (...names: string[]) => {
    const index = headers.findIndex((header) => names.includes(header));
    if (index === -1) throw new Error(`Missing CSV column: ${names.join(" or ")}`);
    return index;
  };

  const timeIndex = indexOf("time", "timestamp", "date", "datetime");
  const openIndex = indexOf("open");
  const highIndex = indexOf("high");
  const lowIndex = indexOf("low");
  const closeIndex = indexOf("close");
  const volumeIndex = headers.findIndex((header) => header === "volume" || header === "vol");

  const bars = lines.slice(1).map((line) => {
    const cells = line.split(",").map((cell) => cell.trim());
    const bar: OhlcvBar = {
      time: parseTimestamp(cells[timeIndex] ?? ""),
      open: Number(cells[openIndex]),
      high: Number(cells[highIndex]),
      low: Number(cells[lowIndex]),
      close: Number(cells[closeIndex]),
      volume: volumeIndex >= 0 ? Number(cells[volumeIndex]) : 1000,
    };

    if (
      !Number.isFinite(bar.time) ||
      !Number.isFinite(bar.open) ||
      !Number.isFinite(bar.high) ||
      !Number.isFinite(bar.low) ||
      !Number.isFinite(bar.close) ||
      !Number.isFinite(bar.volume)
    ) {
      throw new Error(`Invalid OHLCV row: ${line}`);
    }

    return bar;
  });

  return bars.sort((a, b) => a.time - b.time);
}

export function barsToCsv(bars: OhlcvBar[]): string {
  const rows = ["time,open,high,low,close,volume"];
  for (const bar of bars) {
    rows.push([bar.time, bar.open, bar.high, bar.low, bar.close, bar.volume].join(","));
  }
  return rows.join("\n");
}
