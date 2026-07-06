import { useEffect, useRef } from "react";
import {
  ColorType,
  createChart,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type Time,
} from "lightweight-charts";
import { rangeToSeconds, type ChartRange } from "@/chart-range";
import type { EquityPoint } from "@/engine/types";

type Props = {
  equityCurve: EquityPoint[];
  range: ChartRange;
};

export function EquityChart({ equityCurve, range }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Line"> | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      height: 320,
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
    });

    const series = chart.addSeries(LineSeries, {
      color: "#2563eb",
      lineWidth: 2,
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
      equityCurve.map((point) => ({
        time: point.time as Time,
        value: point.equity,
      })),
    );
  }, [equityCurve]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || equityCurve.length === 0) return;

    const first = equityCurve[0];
    const last = equityCurve[equityCurve.length - 1];
    const seconds = rangeToSeconds(range);
    if (!seconds || !first || !last) {
      chart.timeScale().fitContent();
      return;
    }

    chart.timeScale().setVisibleRange({
      from: Math.max(first.time, last.time - seconds) as Time,
      to: last.time as Time,
    });
  }, [equityCurve, range]);

  return <div className="chart compact" ref={containerRef} />;
}
