import { type KeyboardEvent, type PointerEvent, useLayoutEffect, useMemo, useRef, useState } from "react";
import { formatAxisTime, formatTooltipTime } from "../lib/format";

export interface ChartPoint {
  t: number;
  v: number | null;
  max: number | null;
}

export interface ChartSeries {
  id: string;
  label: string;
  points: ChartPoint[];
}

interface LineChartProps {
  title: string;
  series: ChartSeries[];
  from: number;
  to: number;
  formatValue: (value: number) => string;
  /** Fixed upper bound (e.g. 100 for percentages); otherwise derived from the data. */
  yMax?: number;
  /** Bucket width from the API; null for raw samples. Used to decide where lines break. */
  stepSeconds: number | null;
  loading?: boolean;
  height?: number;
}

/** Categorical slots; colors are defined in CSS (`.series-N`) for light and dark mode. */
const MAX_SERIES = 8;
/** Secondary encoding so series stay distinguishable without color. */
const DASHES = ["", "6 3", "2 3", "8 3 2 3", "12 4", "4 2 1 2", "1 3", "10 2 2 2"];
const MARGIN = { top: 12, right: 16, bottom: 28, left: 56 };
const TIME_STEPS = [
  60_000,
  5 * 60_000,
  10 * 60_000,
  15 * 60_000,
  30 * 60_000,
  3600_000,
  2 * 3600_000,
  3 * 3600_000,
  6 * 3600_000,
  12 * 3600_000,
  86_400_000,
  2 * 86_400_000,
];

function niceStep(rough: number): number {
  if (rough <= 0 || !Number.isFinite(rough)) return 1;
  const exponent = 10 ** Math.floor(Math.log10(rough));
  const fraction = rough / exponent;
  const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10;
  return nice * exponent;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? null;
}

/** Index of the element in a sorted array closest to `target`. */
function nearestIndex(sorted: number[], target: number): number {
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((sorted[mid] ?? 0) < target) lo = mid + 1;
    else hi = mid;
  }
  const after = sorted[lo];
  const before = sorted[lo - 1];
  if (before !== undefined && after !== undefined && target - before < after - target) return lo - 1;
  return lo;
}

function nearestPoint(points: ChartPoint[], target: number, tolerance: number): ChartPoint | null {
  if (points.length === 0) return null;
  const idx = nearestIndex(
    points.map((p) => p.t),
    target,
  );
  const p = points[idx];
  return p && Math.abs(p.t - target) <= tolerance ? p : null;
}

function useElementWidth<T extends HTMLElement>(fallback: number) {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(fallback);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth || fallback);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidth(Math.max(200, Math.floor(entry.contentRect.width)));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [fallback]);
  return [ref, width] as const;
}

export function LineChart({
  title,
  series: allSeries,
  from,
  to,
  formatValue,
  yMax,
  stepSeconds,
  loading = false,
  height = 220,
}: LineChartProps) {
  const [plotRef, width] = useElementWidth<HTMLDivElement>(640);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const hidden = Math.max(0, allSeries.length - MAX_SERIES);

  const model = useMemo(() => {
    const series = allSeries.slice(0, MAX_SERIES);
    const sorted = series.map((s) => ({ ...s, points: [...s.points].sort((a, b) => a.t - b.t) }));
    const deltas: number[] = [];
    for (const s of sorted) {
      for (let i = 1; i < s.points.length; i++) {
        const a = s.points[i - 1];
        const b = s.points[i];
        if (a && b) deltas.push(b.t - a.t);
      }
    }
    const typical = stepSeconds ? stepSeconds * 1000 : (median(deltas) ?? 60_000);
    // Break the line where samples are missing for longer than a few intervals.
    const gap = Math.max(typical * 2.5, 30_000);
    let dataMax = 0;
    let hasData = false;
    const times = new Set<number>();
    for (const s of sorted) {
      for (const p of s.points) {
        if (p.v !== null) {
          hasData = true;
          dataMax = Math.max(dataMax, p.v);
          times.add(p.t);
        }
      }
    }
    return { sorted, gap, dataMax, hasData, times: [...times].sort((a, b) => a - b) };
  }, [allSeries, stepSeconds]);

  const innerW = Math.max(10, width - MARGIN.left - MARGIN.right);
  const innerH = height - MARGIN.top - MARGIN.bottom;
  const span = Math.max(1, to - from);
  const x = (t: number) => MARGIN.left + ((t - from) / span) * innerW;

  const top = yMax ?? Math.max(model.dataMax * 1.1, 1e-9);
  const yStep = niceStep(top / 4);
  const yTop = yMax ?? Math.max(yStep, Math.ceil(top / yStep) * yStep);
  const y = (v: number) => MARGIN.top + innerH - (Math.min(v, yTop) / yTop) * innerH;
  const yTicks: number[] = [];
  for (let v = 0; v <= yTop + yStep / 1000; v += yStep) yTicks.push(v);

  const maxXTicks = Math.max(2, Math.floor(innerW / 90));
  const xStep = TIME_STEPS.find((s) => span / s <= maxXTicks) ?? 7 * 86_400_000;
  const tzOffset = -new Date(from).getTimezoneOffset() * 60_000;
  const xTicks: number[] = [];
  for (let t = Math.ceil((from + tzOffset) / xStep) * xStep - tzOffset; t <= to; t += xStep) xTicks.push(t);

  const paths = model.sorted.map((s) => {
    const segments: Array<Array<[number, number]>> = [];
    let current: Array<[number, number]> = [];
    let lastT: number | null = null;
    for (const p of s.points) {
      if (p.v === null || (lastT !== null && p.t - lastT > model.gap)) {
        if (current.length > 0) segments.push(current);
        current = [];
      }
      if (p.v !== null) current.push([x(p.t), y(p.v)]);
      lastT = p.t;
    }
    if (current.length > 0) segments.push(current);
    return segments;
  });

  const hoverT = hoverIndex !== null ? model.times[hoverIndex] : undefined;
  const hoverValues =
    hoverT === undefined
      ? []
      : model.sorted.map((s) => ({ series: s, point: nearestPoint(s.points, hoverT, model.gap / 2) }));

  const setFromPointer = (event: PointerEvent<HTMLDivElement>) => {
    if (model.times.length === 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const t = from + ((px - MARGIN.left) / innerW) * span;
    setHoverIndex(nearestIndex(model.times, t));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const last = model.times.length - 1;
    if (last < 0) return;
    const current = hoverIndex ?? last;
    let next: number | null = current;
    if (event.key === "ArrowLeft") next = Math.max(0, current - 1);
    else if (event.key === "ArrowRight") next = Math.min(last, current + 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = last;
    else if (event.key === "Escape") next = null;
    else return;
    event.preventDefault();
    setHoverIndex(next);
  };

  const valueText =
    hoverT === undefined
      ? "Use arrow keys to read values"
      : `${formatTooltipTime(hoverT)}: ${hoverValues
          .map((h) => `${h.series.label} ${h.point?.v != null ? formatValue(h.point.v) : "no data"}`)
          .join(", ")}`;

  const summaries = model.sorted.map((s) => {
    const values = s.points.map((p) => p.v).filter((v): v is number => v !== null);
    const lastPoint = [...s.points].reverse().find((p) => p.v !== null);
    return {
      series: s,
      latest: lastPoint?.v ?? null,
      min: values.length ? Math.min(...values) : null,
      max: values.length ? Math.max(...values) : null,
      avg: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null,
    };
  });

  const tooltipLeft = hoverT !== undefined ? x(hoverT) : 0;
  const tooltipOnLeft = tooltipLeft > width / 2;

  return (
    <figure className={`chart${loading ? " chart-loading" : ""}`}>
      <figcaption className="chart-title">{title}</figcaption>
      <div className="chart-body" ref={plotRef}>
        {!model.hasData ? (
          <div className="chart-empty">No data in this time range</div>
        ) : (
          <div
            className="chart-plot"
            role="slider"
            tabIndex={0}
            aria-label={`${title}: time cursor`}
            aria-valuemin={0}
            aria-valuemax={Math.max(0, model.times.length - 1)}
            aria-valuenow={hoverIndex ?? Math.max(0, model.times.length - 1)}
            aria-valuetext={valueText}
            onPointerMove={setFromPointer}
            onPointerDown={setFromPointer}
            onPointerLeave={() => setHoverIndex(null)}
            onKeyDown={onKeyDown}
            onBlur={() => setHoverIndex(null)}
          >
            <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
              <g className="chart-grid">
                {yTicks.map((v) => (
                  <line key={`gy${v}`} x1={MARGIN.left} x2={MARGIN.left + innerW} y1={y(v)} y2={y(v)} />
                ))}
              </g>
              <line
                className="chart-axis"
                x1={MARGIN.left}
                x2={MARGIN.left + innerW}
                y1={MARGIN.top + innerH}
                y2={MARGIN.top + innerH}
              />
              <g className="chart-tick-labels">
                {yTicks.map((v) => (
                  <text key={`ly${v}`} x={MARGIN.left - 6} y={y(v)} dy="0.32em" textAnchor="end">
                    {formatValue(v)}
                  </text>
                ))}
                {xTicks.map((t) => (
                  <text key={`lx${t}`} x={x(t)} y={MARGIN.top + innerH + 18} textAnchor="middle">
                    {formatAxisTime(t, span)}
                  </text>
                ))}
              </g>
              {paths.map((segments, i) => {
                const s = model.sorted[i];
                if (!s) return null;
                return (
                  <g key={s.id} className={`chart-series series-${i + 1}`}>
                    {segments.map((seg) => {
                      const first = seg[0];
                      if (!first) return null;
                      if (seg.length === 1) {
                        return <circle key={`p${first[0]}`} cx={first[0]} cy={first[1]} r={2.5} />;
                      }
                      return (
                        <path
                          key={`s${first[0]}`}
                          d={seg
                            .map(([px, py], j) => `${j === 0 ? "M" : "L"}${px.toFixed(1)},${py.toFixed(1)}`)
                            .join("")}
                          strokeDasharray={DASHES[i] || undefined}
                        />
                      );
                    })}
                  </g>
                );
              })}
              {hoverT !== undefined && (
                <g className="chart-hover">
                  <line x1={x(hoverT)} x2={x(hoverT)} y1={MARGIN.top} y2={MARGIN.top + innerH} />
                  {hoverValues.map((h, i) =>
                    h.point?.v != null ? (
                      <circle
                        key={h.series.id}
                        className={`chart-dot series-${i + 1}`}
                        cx={x(h.point.t)}
                        cy={y(h.point.v)}
                        r={4}
                      />
                    ) : null,
                  )}
                </g>
              )}
            </svg>
            {hoverT !== undefined && (
              <div
                className={`chart-tooltip${tooltipOnLeft ? " chart-tooltip-left" : ""}`}
                style={tooltipOnLeft ? { right: width - tooltipLeft + 12 } : { left: tooltipLeft + 12 }}
                aria-hidden="true"
              >
                <div className="chart-tooltip-time">{formatTooltipTime(hoverT)}</div>
                {hoverValues.map((h, i) => (
                  <div key={h.series.id} className="chart-tooltip-row">
                    <LineKey index={i} />
                    <strong>{h.point?.v != null ? formatValue(h.point.v) : "no data"}</strong>
                    {h.point?.max != null && h.point.v != null && h.point.max - h.point.v > 1e-9 ? (
                      <span className="muted small">max {formatValue(h.point.max)}</span>
                    ) : null}
                    <span className="chart-tooltip-label">{h.series.label}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      {model.hasData && model.sorted.length > 1 && (
        <ul className="chart-legend">
          {summaries.map((s, i) => (
            <li key={s.series.id}>
              <LineKey index={i} />
              <span>{s.series.label}</span>
              <span className="muted">{s.latest !== null ? formatValue(s.latest) : "no data"}</span>
            </li>
          ))}
        </ul>
      )}
      {hidden > 0 && (
        <p className="muted small">
          {hidden} more series not drawn (showing the first {MAX_SERIES}); see the latest metrics table.
        </p>
      )}
      {model.hasData && (
        <details className="chart-table">
          <summary>Data summary</summary>
          <div className="table-wrap">
            <table className="table table-compact">
              <thead>
                <tr>
                  <th scope="col">Series</th>
                  <th scope="col">Latest</th>
                  <th scope="col">Min</th>
                  <th scope="col">Avg</th>
                  <th scope="col">Max</th>
                </tr>
              </thead>
              <tbody>
                {summaries.map((s) => (
                  <tr key={s.series.id}>
                    <th scope="row">{s.series.label}</th>
                    <td>{s.latest !== null ? formatValue(s.latest) : "no data"}</td>
                    <td>{s.min !== null ? formatValue(s.min) : "—"}</td>
                    <td>{s.avg !== null ? formatValue(s.avg) : "—"}</td>
                    <td>{s.max !== null ? formatValue(s.max) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </figure>
  );
}

function LineKey({ index }: { index: number }) {
  return (
    <svg
      className={`line-key series-${index + 1}`}
      width="18"
      height="8"
      viewBox="0 0 18 8"
      aria-hidden="true"
    >
      <line x1="1" y1="4" x2="17" y2="4" strokeDasharray={DASHES[index] || undefined} />
    </svg>
  );
}
