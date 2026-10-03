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
        <InstagramCard />
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

const IG_RESULT: Record<string, { ok: boolean; text: string }> = {
  connected: { ok: true, text: 'Instagram terhubung.' },
  cancelled: { ok: false, text: 'Izin dibatalkan di Instagram. Akun belum terhubung.' },
  error: { ok: false, text: 'Login Instagram gagal atau kedaluwarsa. Coba hubungkan lagi.' },
};
const IG_STATUS = { active: 'Aktif', expiring: 'Hampir habis', expired: 'Kedaluwarsa', revoked: 'Dicabut' } as const;

/** Instagram Login resmi: Owner memberi izin langsung di instagram.com. Tidak ada token yang diketik. */
function InstagramCard() {
  const { data, refresh } = useLive(api.instagram);
  const [appId, setAppId] = useState('');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(() => {
    const r = new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('instagram');
    return r ? (IG_RESULT[r] ?? IG_RESULT.error!) : null;
  });
  if (!data) return null;

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      if (ok) setMsg({ ok: true, text: ok });
      refresh();
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const configured = data.app.configured;
  return (
    <section className="card" aria-labelledby="ig-title">
      <div className="row between">
        <h2 id="ig-title">Instagram</h2>
        <span className="chip">{data.accounts.length > 0 ? `${data.accounts.length} akun terhubung` : configured ? 'Siap dihubungkan' : 'Belum diatur'}</span>
      </div>
      <p className="small muted" style={{ margin: 0 }}>
        Login resmi lewat Meta (Instagram Login): Anda memberi izin langsung di instagram.com, lalu sistem menyimpan token terenkripsi dan memperpanjangnya
        otomatis. Password Instagram tidak pernah diketik di sini. Akun harus Instagram Business atau Creator.
      </p>

      <details open={!configured}>
        <summary className="small" style={{ cursor: 'pointer', fontWeight: 600 }}>1. Aplikasi Meta {configured ? `· ID ${data.app.appId} · ••••${data.app.secretLast4}` : ''}</summary>
        <form
          className="field"
          style={{ marginTop: 8 }}
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await api.saveInstagramApp({ appId: appId.trim() || data.app.appId, appSecret: secret.trim() || undefined });
              setSecret('');
            }, 'Aplikasi Meta tersimpan.');
          }}
        >
          <p className="small muted" style={{ margin: 0 }}>
            Di Meta App Dashboard buka Instagram &gt; API setup with Instagram login, lalu tambahkan alamat berikut sebagai <strong>Valid OAuth redirect URI</strong>
            (harus persis sama dan dapat dijangkau browser Anda; Meta umumnya mewajibkan HTTPS, jadi pakai alamat publik lewat <span className="mono">APP_ORIGIN</span>):
          </p>
          <input readOnly value={data.app.redirectUri} aria-label="Redirect URI" className="mono" onFocus={(e) => e.currentTarget.select()} />
          <label htmlFor="ig-app-id">Instagram App ID</label>
          <input id="ig-app-id" inputMode="numeric" value={appId} onChange={(e) => setAppId(e.target.value)} placeholder={data.app.appId || '123456789012345'} />
          <label htmlFor="ig-app-secret">Instagram App Secret{configured ? ' (kosongkan untuk tetap memakai yang lama)' : ''}</label>
          <input id="ig-app-secret" type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} />
          <div className="row wrap">
            <button type="submit" className="btn btn-ghost" disabled={busy || (!configured && (!appId.trim() || !secret.trim()))}>Simpan aplikasi</button>
            {configured && <Remove busy={busy} label="Hapus aplikasi" what="aplikasi Meta (akun yang sudah terhubung tetap ada sampai kedaluwarsa)" onConfirm={() => void run(() => api.removeInstagramApp(), 'Aplikasi Meta dihapus.')} />}
          </div>
        </form>
      </details>

      <div className="field">
        <strong className="small">2. Akun Instagram</strong>
        {data.accounts.length === 0 ? (
          <p className="small muted" style={{ margin: 0 }}>Belum ada akun terhubung.</p>
        ) : (
          <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 8 }}>
            {data.accounts.map((a) => (
              <li key={a.id} className="row wrap between" style={{ borderTop: '1px solid var(--line-soft)', paddingTop: 8 }}>
                <span>
                  <strong>@{a.username}</strong> <span className="small muted">{a.accountType.toLowerCase()}</span>
                  <div className="small" style={{ color: a.status === 'active' ? 'var(--green)' : 'var(--orange-ink)' }}>
                    {IG_STATUS[a.status]}{a.status !== 'revoked' && a.status !== 'expired' ? ` · ${a.daysLeft} hari lagi` : ' · hubungkan ulang'}
                    {!a.canPublish && ' · tanpa izin posting'}
                  </div>
                </span>
                <span className="row">
                  {(a.status === 'active' || a.status === 'expiring') && <button type="button" className="btn btn-ghost" style={{ minHeight: 36, padding: '6px 12px' }} disabled={busy} onClick={() => void run(() => api.refreshInstagram(a.id), 'Token diperpanjang.')}>Perpanjang</button>}
                  <Remove busy={busy} label="Putuskan" what={`akun @${a.username}`} onConfirm={() => void run(() => api.disconnectInstagram(a.id), 'Akun diputus.')} />
                </span>
              </li>
            ))}
          </ul>
        )}
        <div className="row wrap">
          <button
            type="button"
            className="btn"
            disabled={busy || !configured}
            onClick={() => void run(async () => {
              const { url } = await api.connectInstagram();
              window.location.href = url;
            })}
          >
            {data.accounts.length > 0 ? 'Hubungkan akun lain / ulang' : 'Hubungkan Instagram'}
          </button>
          {!configured && <span className="small muted">Isi aplikasi Meta dulu.</span>}
        </div>
      </div>
      {msg && <p className={msg.ok ? 'small' : 'error'} role="status" style={{ margin: 0 }}>{msg.text}</p>}
      <p className="small muted" style={{ margin: 0 }}>
        Penerbitan oleh AI tetap lewat Gateway: menunggu persetujuan Anda kecuali izin publikasi otomatis diaktifkan di halaman Perusahaan. Gambar harus berupa URL publik JPEG.
      </p>
    </section>
  );
}
