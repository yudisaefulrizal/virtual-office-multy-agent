import { useEffect, useState } from 'react';
import { api, useLive, type Artifact, type TraceTask } from '../api';
import { SESSION_STATUS, TASK_STATUS, dateTime, duration, eventText, time, tokens, usd } from '../format';

export function ObjectivePage({ id }: { id: string }) {
  const { data, error } = useLive(() => api.objective(id), [id]);

  if (error && !data) return <main className="page"><p className="error">{error}</p></main>;
  if (!data) return <main className="page"><p className="muted">Memuat…</p></main>;

  const { objective, decisions, tasks, usage, events } = data;
  const st = TASK_STATUS[objective.status] ?? TASK_STATUS.new!;
  const costKind = tasks.flatMap((t) => t.sessions).find((s) => s.costKind)?.costKind;

  return (
    <main className="page" style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <nav aria-label="Breadcrumb" className="row small muted">
          <a href="#/objectives">Objective</a>
          <span aria-hidden="true">/</span>
          <span className="mono">{objective.id.slice(0, 8)}</span>
        </nav>
        <h1 style={{ fontSize: 28, lineHeight: 1.2, fontWeight: 600 }}>{objective.title}</h1>
        <div className="row wrap">
          <span className="chip" style={{ color: st.tone, borderColor: 'currentColor', fontWeight: 600 }}>{st.label}</span>
          <span className="chip">Dibuat {dateTime(objective.createdAt)}</span>
        </div>
        {objective.description !== objective.title && <p style={{ margin: 0, maxWidth: 900 }}>{objective.description}</p>}
      </div>

      <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(200px, 100%), 1fr))', gap: 1, background: 'var(--line)', border: '1px solid var(--line)' }}>
        {[
          ['Keputusan', decisions.at(-1)?.content.strategy ?? '—'],
          ['Task', `${tasks.filter((t) => t.status === 'completed').length}/${tasks.length} selesai`],
          ['Sesi terminal', String(usage.sessions)],
          ['Token (in / out)', `${tokens(usage.inputTokens)} / ${tokens(usage.outputTokens)}`],
          [costKind === 'estimate' ? 'Biaya (estimasi)' : 'Biaya', usd(usage.costUsdMicros)],
        ].map(([k, v]) => (
          <div key={k} style={{ background: '#fff', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 4 }}>
            <dt className="small muted">{k}</dt>
            <dd style={{ margin: 0, fontWeight: 500 }}>{v}</dd>
          </div>
        ))}
      </dl>

      {tasks.map((t) => (
        <TaskCard key={t.id} task={t} />
      ))}

      <section className="card" aria-labelledby="timeline">
        <h2 id="timeline">Timeline</h2>
        <ol className="feed">
          {[...events].reverse().map((e) => (
            <li key={e.id}>
              <span className="mono small muted">{time(e.createdAt)}</span>
              <span>
                <strong>{e.actorName}</strong> <span style={{ color: 'var(--ink-2)' }}>{eventText(e.type, e.payload)}</span>
              </span>
            </li>
          ))}
        </ol>
      </section>
    </main>
  );
}

function TaskCard({ task }: { task: TraceTask }) {
  const st = TASK_STATUS[task.status] ?? TASK_STATUS.pending!;
  return (
    <section className="card" aria-label={`Task ${task.title}`}>
      <div className="row wrap between">
        <div>
          <div className="eyebrow">Task · {task.kind} · {task.agentName ?? 'belum di-assign'}</div>
          <h2>{task.title}</h2>
        </div>
        <span className="row" style={{ gap: 6 }}>
          <span className={`dot ${st.dot}`} />
          <strong style={{ color: st.tone }}>{st.label}</strong>
          <span className="small muted mono">· percobaan {task.attempt}/{task.maxAttempts}</span>
        </span>
      </div>
      {task.result?.summary && <p style={{ margin: 0 }}>{task.result.summary}</p>}
      {task.result?.assumptions && task.result.assumptions.length > 0 && (
        <div className="small">
          <strong>Asumsi:</strong>
          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
            {task.result.assumptions.map((a) => <li key={a}>{a}</li>)}
          </ul>
        </div>
      )}
      {task.error && task.status !== 'completed' && <p className="error" style={{ margin: 0 }}>{task.error}</p>}

      {task.sessions.length > 0 && (
        <div className="table-box">
          <table style={{ minWidth: 720 }}>
            <thead>
              <tr>
                <th scope="col">Mulai</th>
                <th scope="col">Sesi</th>
                <th scope="col">Runtime</th>
                <th scope="col">Status</th>
                <th scope="col" style={{ textAlign: 'right' }}>Durasi</th>
                <th scope="col" style={{ textAlign: 'right' }}>Token in/out</th>
                <th scope="col" style={{ textAlign: 'right' }}>Biaya</th>
              </tr>
            </thead>
            <tbody>
              {task.sessions.map((s) => (
                <tr key={s.id}>
                  <td className="mono small">{time(s.startedAt)}</td>
                  <td className="mono small">
                    <a href={`/api/sessions/${s.id}/log`} target="_blank" rel="noreferrer">{s.id.slice(0, 8)}</a>
                    {s.purpose === 'repair' && <span className="muted"> · repair</span>}
                  </td>
                  <td className="mono small">{s.runtime}{s.model ? ` · ${s.model}` : ''}</td>
                  <td>{SESSION_STATUS[s.status] ?? s.status}</td>
                  <td className="mono small" style={{ textAlign: 'right' }}>{s.endedAt ? duration(Date.parse(s.endedAt) - Date.parse(s.startedAt)) : '…'}</td>
                  <td className="mono small" style={{ textAlign: 'right' }}>{tokens(s.inputTokens)} / {tokens(s.outputTokens)}</td>
                  <td className="mono small" style={{ textAlign: 'right' }}>{usd(s.costUsdMicros)}{s.costKind === 'estimate' ? '*' : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {task.artifacts.map((a) => (
        <ArtifactView key={a.id} artifact={a} />
      ))}
    </section>
  );
}

function ArtifactView({ artifact }: { artifact: Artifact }) {
  const [open, setOpen] = useState(true);
  const [content, setContent] = useState<string | null>(null);
  const textual = !artifact.mimeType || /^text\/|json/.test(artifact.mimeType);

  useEffect(() => {
    if (!open || !textual || content !== null) return;
    fetch(`/api/artifacts/${artifact.id}/content`)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setContent)
      .catch((e: Error) => setContent(`(tidak bisa memuat: ${e.message})`));
  }, [open, textual, content, artifact.id]);

  return (
    <div style={{ borderTop: '1px solid var(--line-soft)', paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className="row wrap between">
        <span className="mono" style={{ fontWeight: 500 }}>{artifact.path.split('/').slice(-2).join('/')}</span>
        <span className="row">
          <span className="small muted">{(artifact.bytes / 1024).toFixed(1)} KB</span>
          {textual && (
            <button type="button" className="btn btn-ghost" style={{ minHeight: 36, padding: '6px 12px' }} onClick={() => setOpen(!open)} aria-expanded={open}>
              {open ? 'Tutup' : 'Lihat'}
            </button>
          )}
          <a href={`/api/artifacts/${artifact.id}/content`} target="_blank" rel="noreferrer">Buka</a>
        </span>
      </div>
      {open && textual && <pre className="artifact">{content ?? 'Memuat…'}</pre>}
    </div>
  );
}
