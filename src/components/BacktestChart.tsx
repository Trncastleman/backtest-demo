import { useEffect, useRef } from "react";
import {
  CandlestickSeries,
  ColorType,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type Time,
} from "lightweight-charts";
import type { BacktestTrade, OhlcvBar } from "@/engine/types";

type Props = {
  bars: OhlcvBar[];
  trades: BacktestTrade[];
};

export function BacktestChart({ bars, trades }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      height: 420,
      layout: {
        background: { type: ColorType.Solid, color: "#ffffff" },
        textColor: "#1f2937",
      },
      grid: {
        vertLines: { color: "#eef2f7" },
        horzLines: { color: "#eef2f7" },
      },
      rightPriceScale: {
        borderColor: "#e5e7eb",
      },
      timeScale: {
        borderColor: "#e5e7eb",
      },
      crosshair: {
        mode: 1,
      },
    });

    const series = chart.addSeries(CandlestickSeries, {
      upColor: "#0f9f6e",
      downColor: "#d14343",
      borderVisible: false,
      wickUpColor: "#0f9f6e",
      wickDownColor: "#d14343",
    });

    chartRef.current = chart;
    seriesRef.current = series;

    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      chart.applyOptions({ width: entry.contentRect.width });
    });
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (!chart || !series) return;

    series.setData(
      bars.map((bar) => ({
        time: bar.time as Time,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
      })),
    );

    createSeriesMarkers(
      series,
      trades.flatMap((trade) => [
        {
          time: trade.entryTime as Time,
          position: "belowBar" as const,
          color: "#2563eb",
          shape: "arrowUp" as const,
          text: "Entry",
        },
        {
          time: trade.exitTime as Time,
          position: "aboveBar" as const,
          color: trade.pnl >= 0 ? "#059669" : "#dc2626",
          shape: "arrowDown" as const,
          text: trade.pnl >= 0 ? "Exit +" : "Exit -",
        },
      ]),
    );

    chart.timeScale().fitContent();
  }, [bars, trades]);

  return <div className="chart" ref={containerRef} />;
}
