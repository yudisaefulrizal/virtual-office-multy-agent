import { useEffect, useRef, useState } from 'react';

export interface ChartPoint {
  t: number;
  v: number;
}

const MARGIN = { top: 14, right: 64, bottom: 26, left: 48 };
const nf = new Intl.NumberFormat('id-ID');
const dateFmt = new Intl.DateTimeFormat('id-ID', { day: 'numeric', month: 'short' });
const timeFmt = new Intl.DateTimeFormat('id-ID', { hour: '2-digit', minute: '2-digit' });
const fullFmt = new Intl.DateTimeFormat('id-ID', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

/** Langkah sumbu yang bulat (1, 2, 5 × 10^n) agar tick terbaca dan tidak pecahan. */
function niceStep(range: number, count: number) {
  const raw = range / count;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const f = raw / pow;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * pow;
}

function yScale(values: number[]) {
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const step = Math.max(1, niceStep(max - min, 4));
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(v);
  return { lo, hi, ticks };
}

/**
 * Grafik garis satu seri: garis 2px, area 10%, titik akhir bercincin permukaan dengan satu label di ujung,
 * crosshair + tooltip mengikuti penunjuk (dan panah kiri/kanan saat fokus keyboard). Teks memakai warna teks,
 * bukan warna seri; warna seri hanya pada tanda (garis, titik, kunci tooltip).
 */
export function LineChart({ points, label, height = 220 }: { points: ChartPoint[]; label: string; height?: number }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [active, setActive] = useState<number | null>(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => e && setWidth(Math.max(280, Math.floor(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const innerW = width - MARGIN.left - MARGIN.right;
  const innerH = height - MARGIN.top - MARGIN.bottom;
  const { lo, hi, ticks } = yScale(points.map((p) => p.v));
  const t0 = points[0]?.t ?? 0;
  const t1 = points.at(-1)?.t ?? 1;
  const x = (t: number) => MARGIN.left + (t1 === t0 ? innerW / 2 : ((t - t0) / (t1 - t0)) * innerW);
  const y = (v: number) => MARGIN.top + innerH - ((v - lo) / (hi - lo)) * innerH;
  const baseY = MARGIN.top + innerH;
  const span = t1 - t0;

  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
  const area = points.length > 1 ? `${line}L${x(t1).toFixed(1)},${baseY}L${x(t0).toFixed(1)},${baseY}Z` : '';
  const xTicks = points.length > 1 ? [0, 1, 2, 3].map((i) => t0 + (span * i) / 3) : [t0];
  const tickText = (t: number) => (span <= 2 * 24 * 3600_000 ? timeFmt.format(t) : dateFmt.format(t));

  const nearest = (clientX: number) => {
    const rect = wrap.current!.getBoundingClientRect();
    const px = clientX - rect.left;
    let best = 0;
    points.forEach((p, i) => {
      if (Math.abs(x(p.t) - px) < Math.abs(x(points[best]!.t) - px)) best = i;
    });
    return best;
  };

  const last = points.at(-1);
  const act = active !== null ? points[active] : null;
  const tipLeft = act ? (x(act.t) > width / 2 ? x(act.t) - 168 : x(act.t) + 14) : 0;

  return (
    <div ref={wrap} className="gr-chart" style={{ height }}>
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={`${label}: ${points.length} titik data${last ? `, terakhir ${nf.format(last.v)}` : ''}`}
        tabIndex={0}
        onPointerMove={(e) => setActive(nearest(e.clientX))}
        onPointerLeave={() => setActive(null)}
        onFocus={() => setActive((a) => a ?? points.length - 1)}
        onBlur={() => setActive(null)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') setActive((a) => Math.max(0, (a ?? points.length) - 1));
          else if (e.key === 'ArrowRight') setActive((a) => Math.min(points.length - 1, (a ?? -1) + 1));
          else if (e.key === 'Home') setActive(0);
          else if (e.key === 'End') setActive(points.length - 1);
          else return;
          e.preventDefault();
        }}
      >
        {ticks.map((v) => (
          <g key={v}>
            <line x1={MARGIN.left} x2={width - MARGIN.right} y1={y(v)} y2={y(v)} stroke="var(--line-soft)" strokeWidth={1} />
            <text x={MARGIN.left - 8} y={y(v)} dy="0.32em" textAnchor="end" fontSize={11} fill="var(--ink-3)" className="mono">{nf.format(v)}</text>
          </g>
        ))}
        {xTicks.map((t, i) => (
          <text key={i} x={x(t)} y={height - 6} textAnchor={xTicks.length === 1 ? 'middle' : i === 0 ? 'start' : i === xTicks.length - 1 ? 'end' : 'middle'} fontSize={11} fill="var(--ink-3)">{tickText(t)}</text>
        ))}
        {area && <path d={area} fill="var(--series-1)" opacity={0.1} />}
        {points.length > 1 && <path d={line} fill="none" stroke="var(--series-1)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />}
        {last && (
          <g>
            <circle cx={x(last.t)} cy={y(last.v)} r={5} fill="var(--series-1)" stroke="var(--surface)" strokeWidth={2} />
            <text x={x(last.t) + 10} y={y(last.v)} dy="0.32em" fontSize={12} fontWeight={700} fill="var(--ink)" className="mono">{nf.format(last.v)}</text>
          </g>
        )}
        {act && (
          <g pointerEvents="none">
            <line x1={x(act.t)} x2={x(act.t)} y1={MARGIN.top} y2={baseY} stroke="var(--ink-3)" strokeWidth={1} />
            <circle cx={x(act.t)} cy={y(act.v)} r={5} fill="var(--series-1)" stroke="var(--surface)" strokeWidth={2} />
          </g>
        )}
      </svg>
      {act && (
        <div className="gr-tip" style={{ left: tipLeft, top: MARGIN.top }} role="status">
          <span className="gr-tip-val"><i aria-hidden="true" />{nf.format(act.v)}</span>
          <span className="small muted">{label}</span>
          <span className="small muted">{fullFmt.format(act.t)}</span>
        </div>
      )}
    </div>
  );
}
