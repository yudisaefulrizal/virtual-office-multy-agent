import { useState } from 'react';
import { api, useLive, type AgentRow, type ProviderInfo, type ToolInfo } from '../api';

/** Satu tempat untuk semua kunci dan akun yang boleh dipakai AI. Rahasia hanya masuk; tidak pernah dikirim balik. */
export function AccessPage() {
  const providers = useLive(api.providers);
  const tools = useLive(api.tools);
  const agents = useLive(api.agents);
  const office = useLive(api.office);

  const claude = office.data?.runtimes.find((r) => r.id === 'claude-cli');
  const toolsWithCred = tools.data?.filter((t) => t.credential) ?? [];
  const pending = agents.data?.filter((a) => a.status === 'waiting_provider') ?? [];

  return (
    <main className="page" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <h1 style={{ fontSize: 24, fontWeight: 600 }}>Akses untuk AI</h1>
        <p className="muted" style={{ margin: '6px 0 0', maxWidth: 760 }}>
          Kunci dan akun yang boleh dipakai perusahaan. Semuanya disimpan terenkripsi dan tidak pernah ditampilkan lagi atau dikirim ke agent: hanya
          sistem yang memakainya, sesuai izin tiap role.
        </p>
      </div>

      {pending.length > 0 && (
        <p className="small" role="status" style={{ margin: 0, color: 'var(--orange-ink)' }}>
          {pending.length} karyawan menunggu provider ({[...new Set(pending.map((a) => a.runtime))].join(', ')}). Pasang kuncinya di bawah agar mereka aktif.
        </p>
      )}

      <div className="access-grid">
        <section className="card" aria-labelledby="acc-claude">
          <div className="row between">
            <h2 id="acc-claude">Claude CLI</h2>
            <span className="chip">{claude?.configured ? 'Siap' : 'Tidak ditemukan'}</span>
          </div>
          <p className="small muted" style={{ margin: 0 }}>
            Runtime utama, memakai login langganan Anda di terminal komputer ini (<span className="mono">claude</span>). Virtual Office tidak menyimpan
            kredensialnya, jadi tidak ada yang perlu diisi di sini. Bila belum login, jalankan <span className="mono">claude</span> di terminal sekali.
          </p>
          {claude?.quota && <p className="small" style={{ margin: 0 }}>Kuota run: {claude.quota.used}/{claude.quota.max} dalam {claude.quota.windowHours} jam. Batas diatur di <a href="#/settings">Pengaturan</a>.</p>}
        </section>

        {providers.data?.map((p) => (
          <ProviderCard key={p.id} provider={p} users={agents.data?.filter((a) => a.runtime === p.id) ?? []} onChanged={() => (providers.refresh(), agents.refresh())} />
        ))}
        {toolsWithCred.map((t) => (
          <ToolCard key={t.id} tool={t} onChanged={tools.refresh} />
        ))}
      </div>

      {(providers.error || tools.error) && <p className="error">{providers.error ?? tools.error}</p>}
      <p className="small muted" style={{ margin: 0 }}>
        Integrasi baru (mis. kanal lain atau pembuat gambar) muncul di halaman ini begitu tool-nya ditambahkan ke sistem. Sampai saat itu agent tidak punya jalan untuk memakainya.
      </p>
    </main>
  );
}

function Remove({ label, what, onConfirm, busy }: { label: string; what: string; onConfirm: () => void; busy: boolean }) {
  return (
    <button
      type="button"
      className="btn btn-danger"
      disabled={busy}
      onClick={() => window.confirm(`Hapus ${what}? Kuncinya dihapus dari Virtual Office dan tidak bisa dipulihkan dari sini.`) && onConfirm()}
    >
      {label}
    </button>
  );
}

function ProviderCard({ provider, users, onChanged }: { provider: ProviderInfo; users: AgentRow[]; onChanged: () => void }) {
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState(provider.defaultModel ?? '');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      setApiKey('');
      setMsg({ ok: true, text: ok });
      onChanged();
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="card"
      aria-labelledby={`prov-${provider.id}`}
      onSubmit={(e) => {
        e.preventDefault();
        void run(() => api.setProvider(provider.id, { apiKey: apiKey.trim() || undefined, defaultModel: model.trim() }), 'Tersimpan. Karyawan yang menunggu provider ini sudah diaktifkan.');
      }}
    >
      <div className="row between">
        <h2 id={`prov-${provider.id}`}>OpenRouter</h2>
        <span className="chip">{provider.configured ? `Terpasang · ••••${provider.apiKeyLast4}` : 'Belum dipasang'}</span>
      </div>
      <p className="small muted" style={{ margin: 0 }}>
        Model dari berbagai vendor lewat API berbayar, untuk role yang cukup bernalar. Biayanya dihitung nyata dan masuk batas budget bulanan perusahaan.
      </p>
      <div className="field">
        <label htmlFor={`key-${provider.id}`}>API key{provider.configured ? ' (kosongkan untuk tetap memakai key lama)' : ''}</label>
        <input id={`key-${provider.id}`} type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-or-…" />
      </div>
      <div className="field">
        <label htmlFor={`dm-${provider.id}`}>Model default</label>
        <input id={`dm-${provider.id}`} value={model} onChange={(e) => setModel(e.target.value)} placeholder="mis. vendor/nama-model" required minLength={3} />
      </div>
      <p className="small muted" style={{ margin: 0 }}>
        {users.length > 0 ? `Dipakai: ${users.map((u) => u.name).join(', ')}.` : 'Belum ada karyawan yang memakai provider ini; pindahkan karyawan ke OpenRouter di Pengaturan.'}
      </p>
      {msg && <p className={msg.ok ? 'small' : 'error'} role="status" style={{ margin: 0 }}>{msg.text}</p>}
      <div className="row wrap">
        <button className="btn" type="submit" disabled={busy || model.trim().length < 3 || (!provider.configured && !apiKey.trim())}>
          {busy ? 'Menyimpan…' : 'Simpan'}
        </button>
        {provider.configured && (
          <Remove busy={busy} label="Hapus key" what="API key OpenRouter" onConfirm={() => void run(() => api.removeProvider(provider.id), 'Key dihapus. Karyawan yang memakainya menunggu provider.')} />
        )}
      </div>
    </form>
  );
}

function ToolCard({ tool, onChanged }: { tool: ToolInfo; onChanged: () => void }) {
  const cred = tool.credential!;
  const [secret, setSecret] = useState('');
  const [config, setConfig] = useState<Record<string, string>>(cred.config);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      setSecret('');
      setMsg({ ok: true, text: ok });
      onChanged();
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="card"
      aria-labelledby={`tool-${tool.id}`}
      onSubmit={(e) => {
        e.preventDefault();
        void run(() => api.setToolCredential(tool.id, { secret: secret.trim() || undefined, config }), 'Tersimpan.');
      }}
    >
      <div className="row between">
        <h2 id={`tool-${tool.id}`}>{tool.title}</h2>
        <span className="chip">{cred.configured ? `Terpasang · ••••${cred.last4}` : 'Belum dipasang'}</span>
      </div>
      <p className="small muted" style={{ margin: 0 }}>{tool.description}</p>
      <div className="field">
        <label htmlFor={`sec-${tool.id}`}>{cred.label}{cred.configured ? ' (kosongkan untuk tetap memakai yang lama)' : ''}</label>
        <input id={`sec-${tool.id}`} type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} />
      </div>
      {cred.configFields.map((f) => (
        <div key={f.key} className="field">
          <label htmlFor={`cfg-${tool.id}-${f.key}`}>{f.label}</label>
          <input id={`cfg-${tool.id}-${f.key}`} value={config[f.key] ?? ''} onChange={(e) => setConfig({ ...config, [f.key]: e.target.value })} />
        </div>
      ))}
      <p className="small muted" style={{ margin: 0 }}>
        Boleh dipakai role: <span className="mono">{tool.roles.join(', ')}</span>.{' '}
        {tool.risk === 'high' ? 'Berisiko tinggi: setiap penggunaan menunggu persetujuan Anda, kecuali izin otomatis diberikan di halaman Perusahaan.' : 'Berisiko rendah.'}
      </p>
      {msg && <p className={msg.ok ? 'small' : 'error'} role="status" style={{ margin: 0 }}>{msg.text}</p>}
      <div className="row wrap">
        <button className="btn" type="submit" disabled={busy || (!cred.configured && !secret.trim())}>{busy ? 'Menyimpan…' : 'Simpan'}</button>
        {cred.configured && <Remove busy={busy} label="Hapus akses" what={`akses ${tool.title}`} onConfirm={() => void run(() => api.removeToolCredential(tool.id), 'Akses dihapus.')} />}
      </div>
    </form>
  );
}
