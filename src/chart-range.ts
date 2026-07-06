export type ChartRange = "day" | "week" | "month" | "all";

export const chartRangeLabels: Record<ChartRange, string> = {
  day: "1D",
  week: "1W",
  month: "1M",
  all: "All",
};

export function rangeToSeconds(range: ChartRange): number | null {
  if (range === "day") return 24 * 60 * 60;
  if (range === "week") return 7 * 24 * 60 * 60;
  if (range === "month") return 30 * 24 * 60 * 60;
  return null;
}
