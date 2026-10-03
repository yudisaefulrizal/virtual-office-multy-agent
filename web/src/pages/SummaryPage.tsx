import { useState } from 'react';
import { api, useLive, type UsageBucket } from '../api';
import { duration, tokens } from '../format';

const RANGES = [7, 14, 30];

export function SummaryPage() {
  const [days, setDays] = useState(14);
  const { data, error } = useLive(() => api.stats(days), [days]);

  if (error && !data) return <main className="page"><p className="error">{error}</p></main>;
  if (!data) return <main className="page"><p className="muted">Memuat…</p></main>;

  const idr = (micros: number) => `Rp${Math.round((micros / 1_000_000) * data.usdToIdr).toLocaleString('id-ID')}`;
  const usd = (micros: number) => `$${(micros / 1_000_000).toFixed(2)}`;

  return (
    <main className="page" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div className="row wrap between">
        <h1 style={{ fontSize: 24, fontWeight: 600 }}>Ringkasan</h1>
        <div role="group" aria-label="Rentang waktu" className="row" style={{ gap: 0, border: '1px solid var(--grey)' }}>
          {RANGES.map((d) => (
            <button key={d} type="button" className={`btn ${d === days ? '' : 'btn-ghost'}`} style={{ border: 0, minWidth: 72 }} aria-pressed={d === days} onClick={() => setDays(d)}>
              {d} hari
            </button>
          ))}
        </div>
      </div>

      <div className="tiles">
        <Tile label="Biaya API hari ini" value={idr(data.today.actualUsdMicros)} sub={usd(data.today.actualUsdMicros)} />
        <Tile label="Biaya API bulan ini" value={idr(data.month.actualUsdMicros)} sub={usd(data.month.actualUsdMicros)} />
        <Tile label="Estimasi kuota Claude bulan ini" value={usd(data.month.estimateUsdMicros)} sub="Langganan: kuota, bukan tagihan" />
        <Tile label="Sesi agent hari ini" value={String(data.today.sessions)} sub={data.today.failures ? `${data.today.failures} gagal/tertunda` : 'Tanpa kegagalan'} />
        <Tile label="Task selesai hari ini" value={String(data.today.tasks.completed)} sub={data.today.tasks.failed ? `${data.today.tasks.failed} gagal` : '—'} />
        <Tile label="Token bulan ini" value={tokens(data.month.inputTokens + data.month.outputTokens)} sub={`${tokens(data.month.inputTokens)} masuk · ${tokens(data.month.outputTokens)} keluar`} />
      </div>

      <div className="row wrap" style={{ alignItems: 'stretch', gap: 20 }}>
        <ColumnChart
          title="Sesi agent per hari"
          rows={data.byDay}
          value={(d) => d.sessions}
          format={(v) => String(v)}
          detail={(d) => `${d.sessions} sesi · ${d.failures} gagal · ${tokens(d.inputTokens + d.outputTokens)} token`}
        />
        <ColumnChart
          title="Biaya API nyata per hari"
          rows={data.byDay}
          value={(d) => d.actualUsdMicros}
          format={idr}
          detail={(d) => `${idr(d.actualUsdMicros)} (${usd(d.actualUsdMicros)})`}
        />
      </div>

      <BreakdownTable title="Per agent" rows={data.byAgent} name={(r) => r.name} idr={idr} />
      <BreakdownTable title="Per objective" rows={data.byObjective} name={(r) => <a href={`#/objectives/${r.id}`}>{r.title}</a>} idr={idr} />
      <BreakdownTable title="Per runtime & model" rows={data.byRuntime} name={(r) => <span className="mono small">{r.runtime}{r.model ? ` · ${r.model}` : ''}</span>} idr={idr} />

      {data.tools.length > 0 && (
        <section className="card" aria-labelledby="tools-usage">
          <h2 id="tools-usage">Pemakaian tool</h2>
          <div className="table-box">
            <table style={{ minWidth: 420 }}>
              <thead><tr><th scope="col">Tool</th><th scope="col">Rincian</th></tr></thead>
              <tbody>
                {data.tools.map((t) => (
                  <tr key={t.toolId}>
                    <td className="mono small">{t.toolId}</td>
                    <td className="small">{Object.entries(t.statuses).map(([k, v]) => `${k}: ${v}`).join(' · ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </main>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="tile">
      <span className="small muted">{label}</span>
      <strong className="tile-value">{value}</strong>
      <span className="small muted">{sub}</span>
    </div>
  );
}

/** Bilangan "bulat" ≥ v untuk puncak sumbu (1, 2, 5 × 10ⁿ). */
function niceCeil(v: number) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return ([1, 2, 5, 10].find((m) => m * p >= v) ?? 10) * p;
}

type Day = UsageBucket & { date: string };

function ColumnChart({
  title,
  rows,
  value,
  format,
  detail,
}: {
  title: string;
  rows: Day[];
  value: (d: Day) => number;
  format: (v: number) => string;
  detail: (d: Day) => string;
}) {
  const [asTable, setAsTable] = useState(false);
  const values = rows.map(value);
  const max = niceCeil(Math.max(...values));
  const peak = values.indexOf(Math.max(...values));
  const label = (date: string) => new Date(`${date}T00:00:00Z`).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const showTick = (i: number) => i === 0 || i === rows.length - 1 || (rows.length > 7 && i === Math.floor(rows.length / 2));

  return (
    <section className="card" style={{ flex: '1 1 420px', minWidth: 0 }} aria-label={title}>
      <div className="row between">
        <h2>{title}</h2>
        <button type="button" className="btn btn-ghost" style={{ minHeight: 32, padding: '4px 10px', fontSize: 12 }} onClick={() => setAsTable(!asTable)} aria-pressed={asTable}>
          {asTable ? 'Lihat grafik' : 'Lihat tabel'}
        </button>
      </div>
      {asTable ? (
        <div className="table-box">
          <table>
            <thead><tr><th scope="col">Tanggal</th><th scope="col" style={{ textAlign: 'right' }}>Nilai</th></tr></thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.date}><td>{label(d.date)}</td><td className="mono small" style={{ textAlign: 'right' }}>{format(value(d))}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="colchart">
          <div className="colchart-grid" aria-hidden="true">
            {[1, 0.5, 0].map((f) => (
              <div key={f} className="colchart-gridline" style={{ bottom: `${f * 100}%` }}>
                <span>{format(max * f)}</span>
              </div>
            ))}
          </div>
          <div className="colchart-cols">
            {rows.map((d, i) => {
              const v = values[i]!;
              return (
                <button key={d.date} type="button" className="colchart-col" aria-label={`${label(d.date)}: ${detail(d)}`}>
                  {i === peak && v > 0 && <span className="colchart-peak">{format(v)}</span>}
                  <span className="colchart-bar" style={{ height: `${(v / max) * 100}%` }} />
                  <span className={`colchart-tip${i >= rows.length * 0.7 ? ' tip-left' : i < rows.length * 0.3 ? ' tip-right' : ''}`} role="tooltip">
                    <strong>{label(d.date)}</strong>
                    <br />
                    {detail(d)}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="colchart-x" aria-hidden="true">
            {rows.map((d, i) => (
              <span key={d.date}>{showTick(i) ? label(d.date) : ''}</span>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function BreakdownTable<T extends UsageBucket>({ title, rows, name, idr }: { title: string; rows: T[]; name: (r: T) => React.ReactNode; idr: (m: number) => string }) {
  if (rows.length === 0) return null;
  return (
    <section className="card" aria-label={title}>
      <h2>{title}</h2>
      <div className="table-box">
        <table style={{ minWidth: 720 }}>
          <thead>
            <tr>
              <th scope="col">Nama</th>
              <th scope="col" style={{ textAlign: 'right' }}>Sesi</th>
              <th scope="col" style={{ textAlign: 'right' }}>Gagal</th>
              <th scope="col" style={{ textAlign: 'right' }}>Token in / out</th>
              <th scope="col" style={{ textAlign: 'right' }}>Rata-rata durasi</th>
              <th scope="col" style={{ textAlign: 'right' }}>Biaya API</th>
              <th scope="col" style={{ textAlign: 'right' }}>Estimasi kuota</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td>{name(r)}</td>
                <td className="mono small" style={{ textAlign: 'right' }}>{r.sessions}</td>
                <td className="mono small" style={{ textAlign: 'right' }}>{r.failures}</td>
                <td className="mono small" style={{ textAlign: 'right' }}>{tokens(r.inputTokens)} / {tokens(r.outputTokens)}</td>
                <td className="mono small" style={{ textAlign: 'right' }}>{r.sessions ? duration(r.durationMs / r.sessions) : '—'}</td>
                <td className="mono small" style={{ textAlign: 'right' }}>{idr(r.actualUsdMicros)}</td>
                <td className="mono small" style={{ textAlign: 'right' }}>${(r.estimateUsdMicros / 1_000_000).toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
