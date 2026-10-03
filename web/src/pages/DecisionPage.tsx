import { useState } from 'react';
import { api, useLive, type DecisionDetail } from '../api';
import { DECISION_STATUS, KIND_LABEL, dateTime } from '../format';

export function DecisionsPage() {
  const { data, error } = useLive(api.decisions);
  return (
    <main className="page">
      <section className="card">
        <h2>Keputusan CEO</h2>
        {error && <p className="error">{error}</p>}
        {data && data.length === 0 && (
          <p className="muted">Belum ada keputusan. Beri objective dengan cara kerja "Strategis" agar CEO menyusun keputusan.</p>
        )}
        {data && data.length > 0 && (
          <div className="table-box">
            <table style={{ minWidth: 640 }}>
              <thead>
                <tr>
                  <th scope="col">Objective</th>
                  <th scope="col">Strategi</th>
                  <th scope="col">Status</th>
                  <th scope="col">Diusulkan</th>
                </tr>
              </thead>
              <tbody>
                {data.map((d) => {
                  const st = DECISION_STATUS[d.status] ?? DECISION_STATUS.proposed!;
                  return (
                    <tr key={d.id}>
                      <td><a href={`#/decisions/${d.id}`} style={{ fontWeight: 500 }}>{d.objectiveTitle}</a></td>
                      <td className="small" style={{ maxWidth: 420 }}>{d.strategy}</td>
                      <td>
                        <span className="row" style={{ gap: 6 }}>
                          <span className={`dot ${st.dot}`} />
                          <span style={{ color: st.tone, fontWeight: 500 }}>{st.label}</span>
                        </span>
                      </td>
                      <td className="small muted">{dateTime(d.createdAt)}</td>
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

const REQUEST_LABEL: Record<string, string> = { provider: 'provider', budget: 'budget', tool: 'tool', other: 'lainnya' };

export function DecisionPage({ id }: { id: string }) {
  const { data, error, refresh } = useLive(() => api.decision(id), [id]);
  if (error && !data) return <main className="page"><p className="error">{error}</p></main>;
  if (!data) return <main className="page"><p className="muted">Memuat…</p></main>;

  const { decision, objective, inputs, history } = data;
  const p = decision.content;
  const st = DECISION_STATUS[decision.status] ?? DECISION_STATUS.proposed!;
  const pending = decision.status === 'proposed';

  return (
    <main className="page" style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <nav aria-label="Breadcrumb" className="row small muted">
          <a href="#/decisions">Keputusan</a>
          <span aria-hidden="true">/</span>
          <a href={`#/objectives/${objective.id}`}>{objective.title}</a>
        </nav>
        <span className="eyebrow">Diusulkan {decision.proposedByName} · {dateTime(decision.createdAt)}</span>
        <h1 style={{ fontSize: 26, lineHeight: 1.25, fontWeight: 600, maxWidth: 900 }}>{p.strategy}</h1>
        <span className="chip" style={{ alignSelf: 'flex-start', color: st.tone, borderColor: 'currentColor', fontWeight: 600 }}>{st.label}</span>
        {decision.reviewNote && <p className="small muted" style={{ margin: 0 }}>Catatan Owner: {decision.reviewNote}</p>}
      </div>

      <div className="split">
        <div className="main">
          <section className="card" aria-labelledby="strategy">
            <h2 id="strategy">Strategi</h2>
            <div className="small muted">Objective</div>
            <p style={{ margin: 0 }}>{objective.description}</p>
            <div className="small muted">Arahan untuk Manager</div>
            <p style={{ margin: 0 }}>{p.execution_brief}</p>
            <div className="small muted">Metrik keberhasilan</div>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {p.success_metrics.map((m) => <li key={m}>{m}</li>)}
            </ul>
            <div className="small muted">Batas biaya API</div>
            <p style={{ margin: 0 }}>{p.budget_cap_usd > 0 ? `$${p.budget_cap_usd}` : 'Tanpa batas tambahan'}</p>
          </section>

          {inputs.length > 0 && (
            <section className="card" aria-labelledby="inputs">
              <h2 id="inputs">Masukan tim</h2>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(260px, 100%), 1fr))', gap: 12 }}>
                {inputs.map((i) => (
                  <article key={i.id} style={{ border: '1px solid var(--line)', padding: 14, display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <span className="row between">
                      <strong>{i.agentName ?? 'Agent'}</strong>
                      <span className="eyebrow">{KIND_LABEL[i.kind] ?? i.kind}</span>
                    </span>
                    <InputResult kind={i.kind} result={i.result} />
                  </article>
                ))}
              </div>
            </section>
          )}

          {p.team.length > 0 && (
            <section className="card" aria-labelledby="team">
              <h2 id="team">Susunan tim yang diusulkan</h2>
              <div className="table-box">
                <table style={{ minWidth: 520 }}>
                  <thead>
                    <tr><th scope="col">Role</th><th scope="col">Runtime</th><th scope="col">Alasan</th></tr>
                  </thead>
                  <tbody>
                    {p.team.map((t) => (
                      <tr key={t.role}>
                        <td className="mono small">{t.role}</td>
                        <td className="mono small">{t.runtime}{data.providers.includes(t.runtime) ? '' : ' (belum dipasang)'}</td>
                        <td>{t.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="small muted" style={{ margin: 0 }}>Agent baru hanya dibuat dari role yang sudah ada. Runtime yang belum dipasang membuat agent menunggu provider.</p>
            </section>
          )}

          {history.length > 1 && (
            <section className="card" aria-labelledby="history">
              <h2 id="history">Riwayat keputusan objective ini</h2>
              {history.map((h) => {
                const hs = DECISION_STATUS[h.status] ?? DECISION_STATUS.proposed!;
                return (
                  <a key={h.id} href={`#/decisions/${h.id}`} className="row" style={{ gap: 8, textDecoration: 'none', color: 'var(--ink)' }}>
                    <span className={`dot ${hs.dot}`} />
                    <span>{dateTime(h.createdAt)}</span>
                    <span style={{ color: hs.tone }}>{hs.label}</span>
                    {h.id === decision.id && <span className="small muted">(ini)</span>}
                    {h.reviewNote && <span className="small muted">— {h.reviewNote}</span>}
                  </a>
                );
              })}
            </section>
          )}
        </div>

        <aside className="side">
          <section className="card" aria-labelledby="requests" style={{ borderWidth: 2, borderColor: 'var(--plan)' }}>
            <h2 id="requests">Permintaan CEO kepada Anda</h2>
            {p.owner_requests.length === 0 && <p className="muted" style={{ margin: 0 }}>Tidak ada permintaan khusus.</p>}
            {p.owner_requests.map((r, i) => (
              <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 4, paddingBottom: 10, borderBottom: '1px solid var(--line-soft)' }}>
                <span className="row">
                  <span className="mono small chip">{REQUEST_LABEL[r.type] ?? r.type}</span>
                  <strong>{r.key}</strong>
                  {r.amount_usd ? <span className="small muted">${r.amount_usd}</span> : null}
                </span>
                <span className="small">{r.reason}</span>
                {r.type === 'provider' && (
                  data.providers.includes(r.key)
                    ? <span className="small" style={{ color: 'var(--green)' }}>Sudah terpasang.</span>
                    : <a className="small" href="#/settings">Pasang {r.key} di Pengaturan →</a>
                )}
              </div>
            ))}
            <p className="small muted" style={{ margin: 0 }}>API key dimasukkan di Pengaturan, bukan di sini, dan tidak pernah dikirim ke agent.</p>
          </section>
          {pending && <DecideForm id={decision.id} onDone={refresh} />}
          <ApprovalMode />
        </aside>
      </div>
    </main>
  );
}

function InputResult({ kind, result }: { kind: string; result: Record<string, any> | null }) {
  if (!result) return <span className="small muted">Belum ada hasil.</span>;
  if (kind === 'framing') return <span className="small">{result.vision}</span>;
  if (kind === 'consultation') {
    return (
      <>
        <span className="small"><strong>Rekomendasi:</strong> {result.recommendation}</span>
        <span className="small muted">{result.analysis}</span>
        {result.alternatives?.length > 0 && <span className="small"><strong>Alternatif:</strong> {result.alternatives.join('; ')}</span>}
        {result.risks?.length > 0 && <span className="small"><strong>Risiko:</strong> {result.risks.join('; ')}</span>}
      </>
    );
  }
  return (
    <>
      <span className="small">{result.summary}</span>
      {result.findings?.length > 0 && (
        <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
          {result.findings.slice(0, 5).map((f: { point: string; source: string }, i: number) => <li key={i}>{f.point}</li>)}
        </ul>
      )}
    </>
  );
}

function DecideForm({ id, onDone }: { id: string; onDone: () => void }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const act = async (action: 'approve' | 'revise' | 'reject') => {
    if (action === 'revise' && !note.trim()) return setError('Tulis catatan untuk CEO sebelum meminta revisi.');
    if (action === 'reject' && !window.confirm('Tolak keputusan ini? Objective akan dibatalkan.')) return;
    setBusy(true);
    setError(null);
    try {
      await api.decide(id, action, note.trim() || undefined);
      setNote('');
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card" aria-labelledby="decide">
      <h2 id="decide">Keputusan Anda</h2>
      <button type="button" className="btn" disabled={busy} onClick={() => act('approve')}>Setujui</button>
      <div className="field">
        <label htmlFor="note">Catatan untuk CEO (wajib jika minta revisi)</label>
        <textarea id="note" rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Mis. fokus ke video pendek dulu." />
      </div>
      {error && <p className="error" style={{ margin: 0 }}>{error}</p>}
      <div className="row wrap">
        <button type="button" className="btn btn-ghost" style={{ flex: '1 1 140px' }} disabled={busy} onClick={() => act('revise')}>Minta revisi</button>
        <button type="button" className="btn btn-danger" style={{ flex: '1 1 100px' }} disabled={busy} onClick={() => act('reject')}>Tolak</button>
      </div>
    </section>
  );
}

export function ApprovalMode() {
  const { data, refresh } = useLive(api.settings);
  const set = async (mode: 'always' | 'auto') => {
    await api.updateSettings({ decision_approval: mode });
    refresh();
  };
  const auto = data?.decision_approval === 'auto';
  return (
    <section className="card" aria-labelledby="mode">
      <h2 id="mode" style={{ fontSize: 14 }}>Keputusan strategis berikutnya</h2>
      <div role="group" aria-label="Mode persetujuan" className="row" style={{ gap: 0, border: '1px solid var(--grey)' }}>
        <button type="button" className={`btn ${auto ? 'btn-ghost' : ''}`} style={{ flex: 1, border: 0 }} aria-pressed={!auto} onClick={() => set('always')}>Selalu minta saya</button>
        <button type="button" className={`btn ${auto ? '' : 'btn-ghost'}`} style={{ flex: 1, border: 0 }} aria-pressed={auto} onClick={() => set('auto')}>Otomatis, kabari saya</button>
      </div>
      <span className="small muted">
        {auto
          ? 'Keputusan berlaku langsung. Permintaan provider, budget, dan tool tetap menunggu Anda.'
          : 'Setiap keputusan CEO menunggu persetujuan sebelum dijalankan.'}
      </span>
    </section>
  );
}

export type { DecisionDetail };
