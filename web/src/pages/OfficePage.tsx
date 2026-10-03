import { lazy, Suspense, useMemo, useState } from 'react';
import { api, useLive, useNow, type OfficeAgent } from '../api';
import { ACTIVITY, TASK_STATUS, dateTime, duration, eventText, time } from '../format';
import { lookFor } from '../office/look';
import { NewObjective } from './NewObjective';

const OfficeScene = lazy(() => import('../office/Scene').then((m) => ({ default: m.OfficeScene })));

export function OfficePage() {
  const { data, error } = useLive(api.office);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const selected = useMemo(() => {
    if (!data) return null;
    return (
      data.agents.find((a) => a.id === selectedId) ??
      data.agents.find((a) => a.activity === 'working') ??
      data.agents[0] ??
      null
    );
  }, [data, selectedId]);

  if (error && !data) return <main className="page"><p className="error">Tidak bisa memuat kantor: {error}</p></main>;
  if (!data) return <main className="page"><p className="muted">Memuat kantor…</p></main>;

  const working = data.agents.filter((a) => a.activity === 'working').length;

  return (
    <main className="page split">
      <section className="main" aria-label="Kantor 3D">
        <div className="scene-card">
          <div className="scene-head">
            <div>
              <div className="eyebrow" style={{ color: '#aeb4bc' }}>Kantor</div>
              <div style={{ fontWeight: 600, fontSize: 16 }}>
                {data.agents.length} karyawan · {working} sedang bekerja
              </div>
            </div>
            <div className="row wrap">
              {data.runtimes.map((r) => (
                <span key={r.id} className="rt-chip">
                  <span className={`sq ${!r.configured ? 'dark-dash-grey' : r.cooldownUntil ? 'dark-fill-orange' : r.inflight > 0 ? 'dark-fill-blue' : 'dark-fill-green'}`} />
                  {r.id} {r.configured ? `${r.inflight}/${r.concurrency}` : 'belum aktif'}
                </span>
              ))}
            </div>
          </div>
          <div className="scene-canvas">
            <Suspense fallback={<p style={{ padding: 20 }}>Menyiapkan kantor 3D…</p>}>
              <OfficeScene agents={data.agents} runtimes={data.runtimes} events={data.events} meeting={data.meeting} selectedId={selected?.id ?? null} onSelect={setSelectedId} />
            </Suspense>
          </div>
          <div className="scene-foot">
            {(['working', 'waiting', 'done', 'idle', 'blocked', 'inactive'] as const).map((k) => (
              <span key={k} className="row" style={{ gap: 6 }}>
                <span className={`sq ${ACTIVITY[k].darkDot}`} />
                {ACTIVITY[k].label}
              </span>
            ))}
            <span style={{ marginLeft: 'auto', color: '#aeb4bc' }}>Klik avatar · seret untuk memutar · scroll untuk zoom</span>
          </div>
        </div>
        <RecentObjectives />
      </section>

      <aside className="side">
        {selected && <AgentDetail agent={selected} />}
        {data.inbox.length > 0 && (
          <section className="card" aria-labelledby="inbox">
            <h2 id="inbox">Perlu Anda</h2>
            {data.inbox.map((i) => (
              <a key={i.taskId} href={i.kind === 'decision_pending' ? `#/decisions/${i.taskId}` : `#/objectives/${i.objectiveId}`} className="notice" style={{ color: 'var(--ink)', textDecoration: 'none', display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={{ fontWeight: 600 }}>
                  {i.kind === 'task_failed'
                    ? `Task gagal: ${i.title}`
                    : i.kind === 'review_escalated'
                      ? `Perlu keputusan Anda: ${i.title}`
                      : i.kind === 'decision_pending'
                        ? `Keputusan CEO menunggu: ${i.title}`
                        : `Belum ada agent: ${i.title}`}
                </span>
                <span className="small muted">{i.detail}</span>
              </a>
            ))}
          </section>
        )}
        <NewObjective />
        <section className="card" aria-labelledby="feed">
          <h2 id="feed">Aktivitas</h2>
          <ol className="feed">
            {data.events.slice(0, 12).map((e) => (
              <li key={e.id}>
                <span className="mono small muted">{time(e.createdAt)}</span>
                <span>
                  <strong>{e.actorName}</strong> <span style={{ color: 'var(--ink-2)' }}>{eventText(e.type, e.payload)}</span>
                </span>
              </li>
            ))}
            {data.events.length === 0 && <li><span /><span className="muted">Belum ada aktivitas. Beri objective pertama.</span></li>}
          </ol>
        </section>
      </aside>
    </main>
  );
}

function AgentDetail({ agent }: { agent: OfficeAgent }) {
  const now = useNow();
  const look = lookFor(agent.id, agent.department);
  const st = ACTIVITY[agent.activity];
  const [stopping, setStopping] = useState(false);

  const stop = async () => {
    if (!agent.task) return;
    setStopping(true);
    await api.cancelTask(agent.task.id).catch(() => undefined);
    setStopping(false);
  };

  return (
    <section className="card" aria-labelledby="agent-name" style={{ gap: 14 }}>
      <div className="row" style={{ gap: 14 }}>
        <div className="portrait" aria-hidden="true" style={{ background: look.skin }}>
          <div style={{ left: 0, top: 0, width: 60, height: 16, background: look.hair }} />
          <div style={{ left: 0, top: 16, width: 8, height: 12, background: look.hair }} />
          <div style={{ left: 52, top: 16, width: 8, height: 12, background: look.hair }} />
          <div style={{ left: 14, top: 28, width: 8, height: 8, background: '#1a1a1a' }} />
          <div style={{ left: 38, top: 28, width: 8, height: 8, background: '#1a1a1a' }} />
          <div style={{ left: 0, top: 48, width: 60, height: 12, background: look.shirt }} />
        </div>
        <div style={{ minWidth: 0 }}>
          <h2 id="agent-name" style={{ fontSize: 18 }}>{agent.name}</h2>
          <div className="small muted">{agent.roleName}</div>
          <div className="row small" style={{ marginTop: 4, gap: 6 }}>
            <span className={`dot ${st.dot}`} />
            <strong style={{ color: st.tone }}>{st.label}</strong>
          </div>
        </div>
      </div>
      <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 16px', fontSize: 13 }}>
        <dt className="muted">Runtime</dt>
        <dd className="mono small" style={{ margin: 0 }}>{agent.runtime}{agent.model ? ` · ${agent.model}` : ''}</dd>
        <dt className="muted">Aktivitas</dt>
        <dd style={{ margin: 0 }}>{agent.line}</dd>
        <dt className="muted">Workspace</dt>
        <dd className="mono small" style={{ margin: 0, overflowWrap: 'anywhere' }}>{agent.workspacePath}</dd>
      </dl>
      {agent.task && (
        <div className="notice notice-blue" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span className="eyebrow" style={{ color: 'var(--blue-ink)' }}>{agent.task.status === 'running' ? 'Sedang dikerjakan' : 'Di antrean'}</span>
          <strong>{agent.task.title}</strong>
          <span className="small mono muted">
            percobaan {Math.max(1, agent.task.attempt)}/{agent.task.maxAttempts}
            {agent.task.startedAt && agent.task.status === 'running' ? ` · ${duration(now - Date.parse(agent.task.startedAt))}` : ''}
          </span>
          <div className="row wrap">
            {agent.task.sessionId && (
              <a className="btn btn-ghost" href={`/api/sessions/${agent.task.sessionId}/log`} target="_blank" rel="noreferrer">
                Lihat log sesi
              </a>
            )}
            <button type="button" className="btn btn-danger" onClick={stop} disabled={stopping}>
              {stopping ? 'Menghentikan…' : agent.task.status === 'running' ? 'Hentikan sesi' : 'Batalkan task'}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function RecentObjectives() {
  const { data } = useLive(api.objectives);
  if (!data || data.length === 0) return null;
  return (
    <section className="card" aria-labelledby="recent-obj">
      <div className="row between wrap">
        <h2 id="recent-obj">Objective terbaru</h2>
        <a href="#/objectives">Semua objective</a>
      </div>
      <div className="table-box">
        <table style={{ minWidth: 520 }}>
          <tbody>
            {data.slice(0, 5).map((o) => {
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
                  <td className="mono small">{o.completedCount}/{o.taskCount} task</td>
                  <td className="small muted">{dateTime(o.createdAt)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
