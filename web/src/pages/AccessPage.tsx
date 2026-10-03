import { useState, type ReactNode } from 'react';
import { api, useLive, type ProviderInfo, type ToolInfo } from '../api';

const IG_RESULT: Record<string, { ok: boolean; text: string }> = {
  connected: { ok: true, text: 'Instagram terhubung.' },
  cancelled: { ok: false, text: 'Izin dibatalkan.' },
  error: { ok: false, text: 'Login gagal atau kedaluwarsa. Coba lagi.' },
};
const IG_STATUS = { active: 'Aktif', expiring: 'Hampir habis', expired: 'Kedaluwarsa', revoked: 'Dicabut' } as const;

/** Kunci dan akun yang boleh dipakai AI. Rahasia hanya bisa dimasukkan, diganti, atau dihapus. */
export function AccessPage() {
  const providers = useLive(api.providers);
  const tools = useLive(api.tools);
  const agents = useLive(api.agents);
  const office = useLive(api.office);
  const claude = office.data?.runtimes.find((r) => r.id === 'claude-cli');
  const toolsWithCred = tools.data?.filter((t) => t.credential) ?? [];

  return (
    <main className="page" style={{ maxWidth: 960, display: 'flex', flexDirection: 'column', gap: 32 }}>
      <h1 className="page-title">Akses</h1>
      <section className="card list" aria-label="Integrasi">
        <Item icon="M4 5l5 5-5 5M11 15h5" title="Claude" sub={claude?.quota ? `Login terminal · ${claude.quota.used}/${claude.quota.max} run` : 'Login terminal'} pill={claude?.configured ? ['Siap', 'pill-green'] : ['Tidak ditemukan', 'pill-amber']} />
        {providers.data?.map((p) => (
          <ProviderItem key={p.id} provider={p} waiting={agents.data?.filter((a) => a.runtime === p.id && a.status === 'waiting_provider').length ?? 0} onChanged={() => (providers.refresh(), agents.refresh())} />
        ))}
        <InstagramItem />
        {toolsWithCred.map((t) => (
          <ToolItem key={t.id} tool={t} onChanged={tools.refresh} />
        ))}
      </section>
      {(providers.error || tools.error) && <p className="error">{providers.error ?? tools.error}</p>}
    </main>
  );
}

function Item({ icon, title, sub, pill, open, onToggle, children }: { icon: string; title: string; sub?: string; pill: [string, string]; open?: boolean; onToggle?: () => void; children?: ReactNode }) {
  return (
    <div className="acc">
      <div className="acc-head">
        <span className="acc-ic" aria-hidden="true"><svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8"><path d={icon} /></svg></span>
        <div style={{ flex: '1 1 200px', minWidth: 0 }}>
          <strong style={{ fontSize: 16, display: 'block' }}>{title}</strong>
          {sub && <span className="muted">{sub}</span>}
        </div>
        <span className={`pill ${pill[1]}`}>{pill[0]}</span>
        {onToggle && <button type="button" className="btn btn-ghost btn-sm" aria-expanded={open} onClick={onToggle}>{open ? 'Tutup' : 'Atur'}</button>}
      </div>
      {open && <div className="acc-body">{children}</div>}
    </div>
  );
}

function Remove({ label, what, onConfirm, busy }: { label: string; what: string; onConfirm: () => void; busy: boolean }) {
  return (
    <button type="button" className="btn btn-danger" disabled={busy} onClick={() => window.confirm(`Hapus ${what}? Tidak bisa dipulihkan dari sini.`) && onConfirm()}>
      {label}
    </button>
  );
}

function useAction(onDone: () => void) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      if (ok) setMsg({ ok: true, text: ok });
      onDone();
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return { busy, msg, setMsg, run };
}

const Msg = ({ msg }: { msg: { ok: boolean; text: string } | null }) => (msg ? <p className={msg.ok ? 'small' : 'error'} role="status" style={{ margin: 0 }}>{msg.text}</p> : null);

function ProviderItem({ provider, waiting, onChanged }: { provider: ProviderInfo; waiting: number; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState(provider.defaultModel ?? '');
  const { busy, msg, run } = useAction(() => (setApiKey(''), onChanged()));
  return (
    <Item
      icon="M10 3.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM3.5 10h13M10 3.5c2 2 2 11 0 13M10 3.5c-2 2-2 11 0 13"
      title="OpenRouter"
      sub={waiting > 0 ? `${waiting} karyawan menunggu` : provider.configured ? `••••${provider.apiKeyLast4}` : undefined}
      pill={provider.configured ? ['Terpasang', 'pill-green'] : ['Belum dipasang', 'pill-grey']}
      open={open}
      onToggle={() => setOpen(!open)}
    >
      <form
        className="acc-form"
        onSubmit={(e) => {
          e.preventDefault();
          void run(() => api.setProvider(provider.id, { apiKey: apiKey.trim() || undefined, defaultModel: model.trim() }), 'Tersimpan.');
        }}
      >
        <div className="field" style={{ flex: '1 1 220px' }}><label htmlFor="or-key">API key</label><input id="or-key" className="mono" type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={provider.configured ? 'Kosongkan untuk tetap' : 'sk-or-…'} /></div>
        <div className="field" style={{ flex: '1 1 220px' }}><label htmlFor="or-model">Model</label><input id="or-model" value={model} onChange={(e) => setModel(e.target.value)} placeholder="vendor/model" required minLength={3} /></div>
        <div className="row wrap">
          <button className="btn" type="submit" disabled={busy || model.trim().length < 3 || (!provider.configured && !apiKey.trim())}>Simpan</button>
          {provider.configured && <Remove busy={busy} label="Hapus" what="API key OpenRouter" onConfirm={() => void run(() => api.removeProvider(provider.id), 'Dihapus.')} />}
        </div>
        <Msg msg={msg} />
      </form>
    </Item>
  );
}

function InstagramItem() {
  const { data, refresh } = useLive(api.instagram);
  const [open, setOpen] = useState(() => new URLSearchParams(window.location.hash.split('?')[1] ?? '').has('instagram'));
  const [appId, setAppId] = useState('');
  const [secret, setSecret] = useState('');
  const { busy, msg, setMsg, run } = useAction(refresh);
  const [seeded, setSeeded] = useState(false);
  if (!data) return null;
  if (!seeded) {
    const r = new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('instagram');
    if (r) setMsg(IG_RESULT[r] ?? IG_RESULT.error!);
    setSeeded(true);
  }
  const configured = data.app.configured;
  return (
    <Item
      icon="M5 3h10a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2zM10 7.5a2.5 2.5 0 100 5 2.5 2.5 0 000-5z"
      title="Instagram"
      sub={data.accounts.length > 0 ? data.accounts.map((a) => `@${a.username}`).join(', ') : undefined}
      pill={data.accounts.length > 0 ? ['Terhubung', 'pill-green'] : ['Belum terhubung', 'pill-amber']}
      open={open}
      onToggle={() => setOpen(!open)}
    >
      <div className="acc-form">
        <form
          style={{ display: 'contents' }}
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await api.saveInstagramApp({ appId: appId.trim() || data.app.appId, appSecret: secret.trim() || undefined });
              setSecret('');
            }, 'Tersimpan.');
          }}
        >
          <div className="field" style={{ flex: '1 1 220px' }}><label htmlFor="ig-app-id">App ID</label><input id="ig-app-id" className="mono" inputMode="numeric" value={appId} onChange={(e) => setAppId(e.target.value)} placeholder={data.app.appId || '123456789012345'} /></div>
          <div className="field" style={{ flex: '1 1 220px' }}><label htmlFor="ig-app-secret">App Secret</label><input id="ig-app-secret" className="mono" type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={configured ? `••••${data.app.secretLast4}` : ''} /></div>
          <div className="field" style={{ flexBasis: '100%' }}><label htmlFor="ig-uri">Redirect URI</label><input id="ig-uri" className="mono" readOnly value={data.app.redirectUri} onFocus={(e) => e.currentTarget.select()} style={{ background: 'var(--bg)', fontSize: 13 }} /></div>
          <div className="row wrap">
            <button type="submit" className="btn btn-ghost" disabled={busy || (!configured && (!appId.trim() || !secret.trim()))}>Simpan</button>
            {configured && <Remove busy={busy} label="Hapus aplikasi" what="aplikasi Meta" onConfirm={() => void run(() => api.removeInstagramApp(), 'Dihapus.')} />}
          </div>
        </form>

        {data.accounts.length > 0 && (
          <ul className="accounts">
            {data.accounts.map((a) => (
              <li key={a.id}>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <strong>@{a.username}</strong>
                  <span className="small" style={{ display: 'block', color: a.status === 'active' ? 'var(--green)' : 'var(--orange-ink)' }}>
                    {IG_STATUS[a.status]}{a.status === 'active' || a.status === 'expiring' ? ` · ${a.daysLeft} hari` : ''}{!a.canPublish ? ' · tanpa izin posting' : ''}
                  </span>
                </span>
                {(a.status === 'active' || a.status === 'expiring') && <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void run(() => api.refreshInstagram(a.id), 'Diperpanjang.')}>Perpanjang</button>}
                <Remove busy={busy} label="Putuskan" what={`akun @${a.username}`} onConfirm={() => void run(() => api.disconnectInstagram(a.id), 'Diputus.')} />
              </li>
            ))}
          </ul>
        )}

        <button
          type="button"
          className="btn"
          disabled={busy || !configured}
          onClick={() => void run(async () => {
            const { url } = await api.connectInstagram();
            window.location.href = url;
          })}
        >
          {data.accounts.length > 0 ? 'Hubungkan akun lain' : 'Hubungkan Instagram'}
        </button>
        <Msg msg={msg} />
      </div>
    </Item>
  );
}

function ToolItem({ tool, onChanged }: { tool: ToolInfo; onChanged: () => void }) {
  const cred = tool.credential!;
  const [open, setOpen] = useState(false);
  const [secret, setSecret] = useState('');
  const [config, setConfig] = useState<Record<string, string>>(cred.config);
  const { busy, msg, run } = useAction(() => (setSecret(''), onChanged()));
  return (
    <Item icon="M10 3v14M3 10h14" title={tool.title} sub={cred.configured ? `••••${cred.last4}` : undefined} pill={cred.configured ? ['Terpasang', 'pill-green'] : ['Belum dipasang', 'pill-grey']} open={open} onToggle={() => setOpen(!open)}>
      <form
        className="acc-form"
        onSubmit={(e) => {
          e.preventDefault();
          void run(() => api.setToolCredential(tool.id, { secret: secret.trim() || undefined, config }), 'Tersimpan.');
        }}
      >
        <div className="field" style={{ flex: '1 1 220px' }}><label htmlFor={`sec-${tool.id}`}>{cred.label}</label><input id={`sec-${tool.id}`} type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} /></div>
        {cred.configFields.map((f) => (
          <div key={f.key} className="field" style={{ flex: '1 1 220px' }}><label htmlFor={`cfg-${tool.id}-${f.key}`}>{f.label}</label><input id={`cfg-${tool.id}-${f.key}`} value={config[f.key] ?? ''} onChange={(e) => setConfig({ ...config, [f.key]: e.target.value })} /></div>
        ))}
        <div className="row wrap">
          <button className="btn" type="submit" disabled={busy || (!cred.configured && !secret.trim())}>Simpan</button>
          {cred.configured && <Remove busy={busy} label="Hapus" what={`akses ${tool.title}`} onConfirm={() => void run(() => api.removeToolCredential(tool.id), 'Dihapus.')} />}
        </div>
        <Msg msg={msg} />
      </form>
    </Item>
  );
}
