import { useState } from 'react';
import { api, useLive, type AgentRow, type ProviderInfo } from '../api';
import { OrgSection } from './OrgSection';
import { PerformanceSection } from './PerformanceSection';

function QuotaRules() {
  const { data, refresh } = useLive(api.settings);
  const office = useLive(api.office);
  const [value, setValue] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  if (!data) return null;
  const q = office.data?.runtimes.find((r) => r.id === 'claude-cli')?.quota;
  const shown = value ?? data.claude_max_runs_per_window;
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    await fn().catch(() => undefined);
    setBusy(false);
    setValue(null);
    refresh();
  };
  return (
    <section className="card" aria-labelledby="quota">
      <h2 id="quota">Kuota Claude CLI</h2>
      <p className="small muted" style={{ margin: 0 }}>
        Pengaman Virtual Office: jumlah run per jendela 5 jam. Kuota langganan Pro sebenarnya dihitung Anthropic, dan bila habis task otomatis ditunda
        lalu dilanjutkan, jadi batas ini boleh dilonggarkan. {q ? `Terpakai sekarang: ${q.used}/${q.max} run.` : 'Saat ini tanpa batas.'}
      </p>
      <div className="row wrap">
        <label htmlFor="quota-max" className="small">Maks run per jendela</label>
        <input id="quota-max" type="number" min={-1} max={1000} value={shown} onChange={(e) => setValue(Number(e.target.value))} style={{ width: 90 }} />
        <span className="small muted">-1 ikut .env · 0 tanpa batas</span>
        <button type="button" className="btn btn-ghost" disabled={busy || value === null} onClick={() => act(() => api.updateSettings({ claude_max_runs_per_window: shown }))}>Simpan</button>
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => act(api.resetQuota)}>Reset hitungan sekarang</button>
      </div>
    </section>
  );
}

export function SettingsPage() {
  const providers = useLive(api.providers);
  const agents = useLive(api.agents);
  const tools = useLive(api.tools);

  return (
    <main className="page split">
      <section className="main">
        <QuotaRules />
        <OrgSection />
        <PerformanceSection />
        <section className="card" aria-labelledby="team">
          <h2 id="team">Karyawan</h2>
          <p className="small muted" style={{ margin: 0 }}>
            Runtime menentukan siapa yang menjalankan agent. <span className="mono">claude-cli</span> bisa membaca/menulis file dan riset web;{' '}
            <span className="mono">openrouter</span> hanya bernalar, cocok untuk konsultasi eksekutif dan perencanaan, dan menghemat kuota Claude.
          </p>
          {agents.error && <p className="error">{agents.error}</p>}
          <div className="table-box">
            <table style={{ minWidth: 720 }}>
              <thead>
                <tr>
                  <th scope="col">Agent</th>
                  <th scope="col">Runtime</th>
                  <th scope="col">Model</th>
                  <th scope="col">Status</th>
                  <th scope="col"><span className="sr-only">Aksi</span></th>
                </tr>
              </thead>
              <tbody>
                {agents.data?.map((a) => (
                  <AgentEditor key={a.id} agent={a} providers={providers.data ?? []} onSaved={agents.refresh} />
                ))}
              </tbody>
            </table>
          </div>
        </section>
        <section className="card" aria-labelledby="tools">
          <h2 id="tools">Tool Gateway</h2>
          <p className="small muted" style={{ margin: 0 }}>
            Agent memakai tool eksternal lewat Gateway Virtual Office, bukan langsung. Tool berisiko tinggi tidak dijalankan sampai Anda menyetujuinya.
          </p>
          <div className="table-box">
            <table style={{ minWidth: 560 }}>
              <thead>
                <tr><th scope="col">Tool</th><th scope="col">Risiko</th><th scope="col">Role yang diizinkan</th></tr>
              </thead>
              <tbody>
                {tools.data?.map((t) => (
                  <tr key={t.id}>
                    <td><strong>{t.title}</strong><div className="small muted">{t.description}</div></td>
                    <td>{t.risk === 'high' ? <span style={{ color: 'var(--orange-ink)', fontWeight: 600 }}>Tinggi · butuh persetujuan</span> : 'Rendah'}</td>
                    <td className="mono small">{t.roles.join(', ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </section>
      <aside className="side">
        <section className="card" aria-labelledby="access-link">
          <h2 id="access-link">API key dan akses</h2>
          <p className="small muted" style={{ margin: 0 }}>Kunci dan akun yang dipakai AI (OpenRouter, Instagram, dsb.) sekarang dikelola di satu halaman khusus.</p>
          <a className="btn btn-ghost" href="#/access">Buka halaman Akses</a>
        </section>
      </aside>
    </main>
  );
}

const STATUS_LABEL: Record<string, string> = { active: 'Aktif', inactive: 'Dirumahkan', retired: 'Pensiun (arsip)', waiting_provider: 'Menunggu provider' };
const TENURE_LABEL: Record<string, string> = { permanent: 'Permanen', on_demand: 'On-demand', temporary: 'Sementara' };

function AgentEditor({ agent, providers, onSaved }: { agent: AgentRow; providers: ProviderInfo[]; onSaved: () => void }) {
  const [runtime, setRuntime] = useState(agent.runtime);
  const [model, setModel] = useState(agent.model ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = runtime !== agent.runtime || model !== (agent.model ?? '');
  const orConfigured = providers.find((p) => p.id === 'openrouter')?.configured;

  const save = async (lifecycle?: 'suspend' | 'reactivate' | 'retire') => {
    setBusy(true);
    setError(null);
    try {
      if (lifecycle) await api.agentLifecycle(agent.id, lifecycle);
      else await api.updateAgent(agent.id, { runtime, model: model.trim() || null });
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <tr>
      <td>
        <strong>{agent.name}</strong>
        <div className="small muted">{agent.roleName} · {TENURE_LABEL[agent.tenure] ?? agent.tenure}</div>
        {error && <div className="error">{error}</div>}
      </td>
      <td>
        <label className="sr-only" htmlFor={`rt-${agent.id}`}>Runtime {agent.name}</label>
        <select id={`rt-${agent.id}`} value={runtime} onChange={(e) => setRuntime(e.target.value)}>
          <option value="claude-cli">claude-cli</option>
          <option value="openrouter">openrouter{orConfigured ? '' : ' (belum dipasang)'}</option>
        </select>
      </td>
      <td>
        <label className="sr-only" htmlFor={`model-${agent.id}`}>Model {agent.name}</label>
        <input id={`model-${agent.id}`} value={model} onChange={(e) => setModel(e.target.value)} placeholder={runtime === 'claude-cli' ? 'sonnet' : 'vendor/model'} />
      </td>
      <td className="small">{STATUS_LABEL[agent.status] ?? agent.status}</td>
      <td>
        <div className="row">
          <button type="button" className="btn btn-ghost" disabled={!dirty || busy} onClick={() => save()}>Simpan</button>
          {agent.status === 'inactive' || agent.status === 'retired' ? (
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => save('reactivate')}>Aktifkan kembali</button>
          ) : (
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => save('suspend')}>Rumahkan</button>
          )}
          {agent.status !== 'retired' && (
            <button
              type="button"
              className="btn btn-danger"
              disabled={busy}
              onClick={() => window.confirm(`Pensiunkan ${agent.name}? Agent diarsipkan dan hilang dari kantor; riwayatnya tetap tersimpan dan bisa diaktifkan kembali.`) && save('retire')}
            >
              Pensiunkan
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}
