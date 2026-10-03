import { api, useLive } from '../api';
import { duration, tokens } from '../format';

const usd = (micros: number) => `$${(micros / 1_000_000).toFixed(2)}`;

/** Data performa agent dan saran HRD (dihitung dari data nyata, bukan dari LLM). */
export function PerformanceSection() {
  const { data } = useLive(api.performance);
  if (!data) return null;
  const rows = data.agents.filter((a) => a.status !== 'retired' && (a.tasksDone > 0 || a.tasksFailed > 0));
  return (
    <section className="card" aria-labelledby="perf">
      <h2 id="perf">Performa karyawan</h2>
      {data.recommendations.length > 0 && (
        <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {data.recommendations.map((r, i) => (
            <li key={i} className="small" style={{ color: r.level === 'warn' ? 'var(--orange-ink)' : 'var(--ink-2)' }}>
              <strong>{r.level === 'warn' ? 'Perhatian: ' : 'Saran HRD: '}</strong>
              {r.text}
            </li>
          ))}
        </ul>
      )}
      {rows.length === 0 ? (
        <p className="muted small" style={{ margin: 0 }}>Belum ada data. Angka muncul setelah karyawan menyelesaikan task.</p>
      ) : (
        <div className="table-box">
          <table style={{ minWidth: 720 }}>
            <thead>
              <tr>
                <th scope="col">Karyawan</th>
                <th scope="col">Selesai / gagal</th>
                <th scope="col">Direvisi</th>
                <th scope="col">Rata-rata durasi</th>
                <th scope="col">Token</th>
                <th scope="col">Biaya</th>
                <th scope="col">Utilisasi 7 hari</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.agentId}>
                  <td>
                    <strong>{a.name}</strong>
                    <div className="small muted">{a.runtime}{a.model ? ` · ${a.model}` : ''}</div>
                  </td>
                  <td className="mono small">{a.tasksDone} / {a.tasksFailed}</td>
                  <td className="mono small">{a.revised}</td>
                  <td className="mono small">{a.avgDurationMs ? duration(a.avgDurationMs) : '—'}</td>
                  <td className="mono small">{tokens(a.inputTokens + a.outputTokens)}</td>
                  <td className="mono small">{usd(a.costUsdMicros)}{a.costKind === 'estimate' ? ' (est.)' : ''}</td>
                  <td className="mono small">{Math.round(a.utilization * 100)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
