import { useEffect, useState } from 'react';
import { api, useLive, type Artifact, type Schedule, type TraceTask } from '../api';
import { DECISION_STATUS, KIND_LABEL, describeSchedule, SESSION_STATUS, TASK_STATUS, dateTime, duration, eventText, time, tokens, usd } from '../format';

export function ObjectivePage({ id }: { id: string }) {
  const { data, error } = useLive(() => api.objective(id), [id]);

  if (error && !data) return <main className="page"><p className="error">{error}</p></main>;
  if (!data) return <main className="page"><p className="muted">Memuat…</p></main>;

  const { objective, decisions, projects, tasks, usage, events } = data;
  const plan = projects[0]?.planTemplate ?? null;
  const supersededIds = new Set(tasks.map((t) => t.retryOfTaskId).filter(Boolean) as string[]);
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
        {['completed', 'failed', 'cancelled'].includes(objective.status) && <DeleteObjective id={objective.id} title={objective.title} />}
        <div className="row wrap">
          <span className="chip" style={{ color: st.tone, borderColor: 'currentColor', fontWeight: 600 }}>{st.label}</span>
          <span className="chip">Dibuat {dateTime(objective.createdAt)}</span>
          {tasks.some((t) => t.status === 'completed' && t.artifacts.length > 0) && (
            <>
              <a href="#/results">Lihat di Hasil</a>
              <a href={`/api/objectives/${objective.id}/download`} download>Unduh ZIP</a>
            </>
          )}
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
          <div key={k} style={{ background: 'var(--surface)', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 4 }}>
            <dt className="small muted">{k}</dt>
            <dd style={{ margin: 0, fontWeight: 500 }}>{v}</dd>
          </div>
        ))}
      </dl>

      <div className="row wrap" style={{ alignItems: 'stretch', gap: 24 }}>
        <div style={{ flex: '1 1 380px', minWidth: 0, display: 'flex' }}><ScheduleCard id={objective.id} schedule={data.schedule} status={objective.status} /></div>
        <div style={{ flex: '1 1 380px', minWidth: 0, display: 'flex' }}><BudgetCard id={objective.id} budget={data.budget} /></div>
      </div>

      {data.toolExecutions.length > 0 && (
        <section className="card" aria-labelledby="tools">
          <h2 id="tools">Pemakaian tool</h2>
          <div className="table-box">
            <table style={{ minWidth: 560 }}>
              <thead>
                <tr><th scope="col">Waktu</th><th scope="col">Tool</th><th scope="col">Status</th><th scope="col">Detail</th></tr>
              </thead>
              <tbody>
                {data.toolExecutions.map((x) => (
                  <tr key={x.id}>
                    <td className="mono small">{time(x.createdAt)}</td>
                    <td className="mono small">{x.toolId}</td>
                    <td>{TOOL_STATUS[x.status] ?? x.status}</td>
                    <td className="small" style={{ wordBreak: 'break-word' }}>{x.error ?? JSON.stringify(x.result ?? x.args).slice(0, 200)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {decisions.some((d) => d.proposedBy !== 'owner') && (
        <section className="card" aria-labelledby="decisions">
          <h2 id="decisions">Keputusan CEO</h2>
          {decisions.filter((d) => d.proposedBy !== 'owner').map((d) => {
            const ds = DECISION_STATUS[d.status] ?? DECISION_STATUS.proposed!;
            return (
              <a key={d.id} href={`#/decisions/${d.id}`} className="row wrap" style={{ gap: 8, textDecoration: 'none', color: 'var(--ink)' }}>
                <span className={`dot ${ds.dot}`} />
                <strong style={{ color: ds.tone }}>{ds.label}</strong>
                <span>{d.content.strategy}</span>
                <span className="small muted">{dateTime(d.createdAt)}</span>
              </a>
            );
          })}
        </section>
      )}

      {tasks.length > 1 && (
        <section className="card" aria-labelledby="pipeline">
          <div className="row wrap between">
            <h2 id="pipeline">Alur kerja</h2>
            {plan && <span className="small muted">Fokus review: {plan.review_focus}</span>}
          </div>
          {plan && <p style={{ margin: 0 }}>{plan.summary}</p>}
          <Pipeline tasks={tasks} superseded={supersededIds} />
        </section>
      )}

      {stageOrder(tasks).map((t) => (
        <TaskCard key={t.id} task={t} superseded={supersededIds.has(t.id)} />
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

/** Tahap = 1 + tahap dependency terjauh. Task tanpa dependency ada di tahap 0. */
function stages(tasks: TraceTask[]) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const memo = new Map<string, number>();
  const level = (t: TraceTask): number => {
    if (memo.has(t.id)) return memo.get(t.id)!;
    const deps = t.dependsOn ?? []; // server versi lama belum mengirim dependsOn
    const l = deps.length ? 1 + Math.max(...deps.map((d) => (byId.get(d) ? level(byId.get(d)!) : 0))) : 0;
    memo.set(t.id, l);
    return l;
  };
  // Fase: strategi (tanpa project) → perencanaan → eksekusi. Task hasil rencana tidak
  // bergantung formal pada perencanaan/keputusan, tapi selalu sesudahnya.
  const strategic = tasks.filter((t) => !t.projectId);
  const strategicDepth = strategic.length ? Math.max(...strategic.map(level)) + 1 : 0;
  const hasPlanning = tasks.some((t) => t.kind === 'planning');
  const grouped: TraceTask[][] = [];
  for (const t of tasks) {
    const l = !t.projectId ? level(t) : strategicDepth + (t.kind === 'planning' ? 0 : level(t) + (hasPlanning ? 1 : 0));
    (grouped[l] ??= []).push(t);
  }
  return grouped.filter(Boolean);
}

function stageOrder(tasks: TraceTask[]) {
  return stages(tasks).flat();
}

function Pipeline({ tasks, superseded }: { tasks: TraceTask[]; superseded: Set<string> }) {
  const groups = stages(tasks);
  return (
    <ol className="pipeline" aria-label="Tahapan">
      {groups.map((group, i) => (
        <li key={i}>
          <div className="stage-col">
            {group.map((t) => {
              const st = TASK_STATUS[t.status] ?? TASK_STATUS.pending!;
              return (
                <a key={t.id} href={`#task-${t.id}`} className={`step ${superseded.has(t.id) ? 'superseded' : t.status}`}>
                  <span className="eyebrow">{KIND_LABEL[t.kind] ?? t.kind} · {t.agentName ?? 'belum ada agent'}</span>
                  <strong style={{ fontSize: 13 }}>{t.title}</strong>
                  <span className="row small" style={{ gap: 6 }}>
                    <span className={`dot ${st.dot}`} />
                    <span style={{ color: st.tone }}>{superseded.has(t.id) ? 'Direvisi' : st.label}</span>
                  </span>
                </a>
              );
            })}
          </div>
          {i < groups.length - 1 && <span aria-hidden="true" style={{ color: 'var(--grey)', fontSize: 18 }}>›</span>}
        </li>
      ))}
    </ol>
  );
}

function TaskResult({ task }: { task: TraceTask }) {
  const r = task.result;
  if (!r) return null;
  if (task.kind === 'review' && r.verdict) {
    return (
      <div className={r.verdict === 'accept' ? 'verdict-accept' : 'verdict-revise'}>
        <strong>{r.verdict === 'accept' ? 'Diterima' : 'Perlu revisi'}</strong>
        <p style={{ margin: '4px 0 0' }}>{r.feedback}</p>
        {r.revisions && r.revisions.length > 0 && (
          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            {r.revisions.map((x) => (
              <li key={x.task_key}><span className="mono small">{x.task_key}</span>: {x.instructions}</li>
            ))}
          </ul>
        )}
      </div>
    );
  }
  return (
    <>
      {r.summary && <p style={{ margin: 0 }}>{r.summary}</p>}
      {task.kind === 'planning' && r.tasks && (
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          {r.tasks.map((t) => (
            <li key={t.key}>{t.title} <span className="small muted mono">({t.role})</span></li>
          ))}
        </ul>
      )}
      {r.findings && r.findings.length > 0 && (
        <div className="small">
          <strong>Temuan:</strong>
          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
            {r.findings.map((f, i) => (
              <li key={i}>
                {f.point}{' '}
                {/^https?:\/\//.test(f.source) ? <a href={f.source} target="_blank" rel="noreferrer">sumber</a> : <span className="muted">({f.source})</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {r.assumptions && r.assumptions.length > 0 && (
        <div className="small">
          <strong>Asumsi:</strong>
          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
            {r.assumptions.map((a) => <li key={a}>{a}</li>)}
          </ul>
        </div>
      )}
    </>
  );
}

function TaskCard({ task, superseded }: { task: TraceTask; superseded: boolean }) {
  const st = TASK_STATUS[task.status] ?? TASK_STATUS.pending!;
  return (
    <section className="card" id={`task-${task.id}`} aria-label={`Task ${task.title}`} style={superseded ? { opacity: 0.75 } : undefined}>
      <div className="row wrap between">
        <div>
          <div className="eyebrow">{KIND_LABEL[task.kind] ?? task.kind} · {task.agentName ?? 'belum di-assign'}{superseded ? ' · versi lama' : ''}</div>
          <h2>{task.title}</h2>
        </div>
        <span className="row" style={{ gap: 6 }}>
          <span className={`dot ${st.dot}`} />
          <strong style={{ color: st.tone }}>{st.label}</strong>
          <span className="small muted mono">· percobaan {task.attempt}/{task.maxAttempts}</span>
        </span>
      </div>
      <TaskResult task={task} />
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

const TOOL_STATUS: Record<string, string> = {
  executed: 'Dijalankan',
  failed: 'Gagal',
  denied: 'Ditolak (izin)',
  pending_approval: 'Menunggu persetujuan',
  rejected: 'Ditolak Owner',
};

function BudgetCard({ id, budget }: { id: string; budget: { budgetUsdMicros: number | null; spentUsdMicros: number } }) {
  const [value, setValue] = useState(budget.budgetUsdMicros == null ? '' : String(budget.budgetUsdMicros / 1_000_000));
  const [busy, setBusy] = useState(false);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    await api.setBudget(id, value.trim() === '' ? null : Number(value)).catch(() => undefined);
    setBusy(false);
  };
  const pct = budget.budgetUsdMicros ? Math.min(100, Math.round((budget.spentUsdMicros / budget.budgetUsdMicros) * 100)) : 0;
  return (
    <section className="card" aria-labelledby="budget" style={{ flex: 1 }}>
      <div className="row wrap between">
        <h2 id="budget">Budget API</h2>
        <span className="small muted">Biaya nyata (API key). Kuota langganan Claude tidak dihitung.</span>
      </div>
      <div className="row wrap" style={{ gap: 16 }}>
        <span>Terpakai <strong>{usd(budget.spentUsdMicros)}</strong>{budget.budgetUsdMicros != null && <> dari <strong>{usd(budget.budgetUsdMicros)}</strong></>}</span>
        {budget.budgetUsdMicros != null && (
          <div className={`meter${pct >= 80 ? ' warn' : ''}`} style={{ flex: '1 1 160px' }}><span style={{ width: `${pct}%` }} /></div>
        )}
      </div>
      <form className="row wrap" onSubmit={save}>
        <label htmlFor="budget-input" className="small">Batas (USD, kosong = tanpa batas)</label>
        <input id="budget-input" type="number" min="0" step="0.01" value={value} onChange={(e) => setValue(e.target.value)} style={{ width: 140 }} />
        <button type="submit" className="btn btn-ghost" disabled={busy}>Simpan budget</button>
      </form>
    </section>
  );
}

function ScheduleCard({ id, schedule, status }: { id: string; schedule: Schedule | null; status: string }) {
  const [time, setTime] = useState(schedule?.timeOfDay ?? '09:00');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const closed = ['failed', 'cancelled'].includes(status);
  return (
    <section className="card" aria-labelledby="schedule" style={{ flex: 1 }}>
      <h2 id="schedule">Jadwal</h2>
      {schedule ? (
        <>
          <span>
            <strong>{describeSchedule(schedule)}</strong> · {schedule.enabled ? `run berikutnya ${dateTime(schedule.nextRunAt)}` : 'dijeda'}
          </span>
          {schedule.lastRunAt && <span className="small muted">Run terakhir {dateTime(schedule.lastRunAt)}</span>}
          <div className="row wrap">
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => run(() => api.setSchedule(id, { ...schedule, enabled: !schedule.enabled }))}>
              {schedule.enabled ? 'Jeda' : 'Lanjutkan'}
            </button>
            <button type="button" className="btn btn-danger" disabled={busy} onClick={() => run(() => api.setSchedule(id, null))}>Hapus jadwal</button>
          </div>
        </>
      ) : (
        <form className="row wrap" onSubmit={(e) => (e.preventDefault(), run(() => api.setSchedule(id, { kind: 'daily', timeOfDay: time })))}>
          <span className="small muted" style={{ flexBasis: '100%' }}>Belum berulang. Jadikan run harian dengan rencana kerja yang sama.</span>
          <label htmlFor="sched-time" className="small">Setiap hari jam</label>
          <input id="sched-time" type="time" value={time} onChange={(e) => setTime(e.target.value)} style={{ width: 130 }} disabled={closed} />
          <button type="submit" className="btn btn-ghost" disabled={busy || closed}>Jadwalkan</button>
        </form>
      )}
      {error && <p className="error" style={{ margin: 0 }}>{error}</p>}
    </section>
  );
}

function DeleteObjective({ id, title }: { id: string; title: string }) {
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="row wrap">
      <button
        type="button"
        className="btn btn-danger"
        style={{ minHeight: 36, padding: '6px 12px' }}
        onClick={async () => {
          if (!window.confirm(`Hapus “${title}” beserta semua task, file hasil, dan jejaknya? Tidak bisa dibatalkan.`)) return;
          try {
            await api.deleteObjective(id);
            window.location.hash = '#/objectives';
          } catch (e) {
            setErr((e as Error).message);
          }
        }}
      >
        Hapus objective ini
      </button>
      {err && <span className="error small">{err}</span>}
    </div>
  );
}
