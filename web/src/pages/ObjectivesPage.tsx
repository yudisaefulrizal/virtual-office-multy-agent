import { api, useLive } from '../api';
import { TASK_STATUS, dateTime } from '../format';

export function ObjectivesPage() {
  const { data, error } = useLive(api.objectives);

  return (
    <main className="page">
      <section className="card">
        <h2>Objective</h2>
        {error && <p className="error">{error}</p>}
        {data && data.length === 0 && <p className="muted">Belum ada objective. Beri objective dari halaman Kantor.</p>}
        {data && data.length > 0 && (
          <div className="table-box">
            <table style={{ minWidth: 560 }}>
              <thead>
                <tr>
                  <th scope="col">Objective</th>
                  <th scope="col">Status</th>
                  <th scope="col">Task</th>
                  <th scope="col">Dibuat</th>
                </tr>
              </thead>
              <tbody>
                {data.map((o) => {
                  const st = TASK_STATUS[o.status] ?? TASK_STATUS.new!;
                  return (
                    <tr key={o.id}>
                      <td><a href={`#/objectives/${o.id}`} style={{ fontWeight: 500 }}>{o.title}</a></td>
                      <td>
                        <span className="row" style={{ gap: 6 }}>
                          <span className={`dot ${st.dot}`} />
                          <span style={{ color: st.tone, fontWeight: 500 }}>{st.label}</span>
                        </span>
                      </td>
                      <td className="mono small">{o.completedCount}/{o.taskCount}</td>
                      <td className="small muted">{dateTime(o.createdAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
