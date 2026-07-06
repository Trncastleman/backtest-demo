import { useEffect, useRef } from "react";
import {
  CandlestickSeries,
  ColorType,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesMarkersPluginApi,
  type ISeriesApi,
  type Time,
} from "lightweight-charts";
import { rangeToSeconds, type ChartRange } from "@/chart-range";
import type { BacktestTrade, OhlcvBar } from "@/engine/types";

type Props = {
  bars: OhlcvBar[];
  trades: BacktestTrade[];
  range: ChartRange;
  showMarkers: boolean;
};

export function BacktestChart({ bars, trades, range, showMarkers }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);

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
    markersRef.current = createSeriesMarkers(series, []);

    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      chart.applyOptions({ width: entry.contentRect.width });
    });
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      markersRef.current?.detach();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      markersRef.current = null;
    };
  }, []);

  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;

    series.setData(
      bars.map((bar) => ({
        time: bar.time as Time,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
      })),
    );

    markersRef.current?.setMarkers(
      showMarkers
        ? trades.flatMap((trade) => [
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
      ])
        : [],
    );
  }, [bars, trades, showMarkers]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || bars.length === 0) return;

    const last = bars[bars.length - 1];
    const seconds = rangeToSeconds(range);
    if (!seconds || !last) {
      chart.timeScale().fitContent();
      return;
    }

    chart.timeScale().setVisibleRange({
      from: Math.max(bars[0].time, last.time - seconds) as Time,
      to: last.time as Time,
    });
  }, [bars, range]);

  return <div className="chart" ref={containerRef} />;
}
