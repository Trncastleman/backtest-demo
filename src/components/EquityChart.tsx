import { useEffect, useRef } from "react";
import {
  ColorType,
  createChart,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type Time,
} from "lightweight-charts";
import type { EquityPoint } from "@/engine/types";

type Props = {
  equityCurve: EquityPoint[];
};

export function EquityChart({ equityCurve }: Props) {
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
    chart.timeScale().fitContent();
  }, [equityCurve]);

  return <div className="chart compact" ref={containerRef} />;
}
