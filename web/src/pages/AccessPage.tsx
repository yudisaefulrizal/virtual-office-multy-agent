import { useState, type ReactNode } from 'react';
import { api, useLive, type ImageModelInfo, type ImageTestResult, type ProviderInfo, type Settings, type ToolInfo } from '../api';

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
    <main className="access" aria-label="Akses">
      <>
        <Item icon="M4 5l5 5-5 5M11 15h5" title="Claude" sub={claude?.quota ? `Login terminal · ${claude.quota.used}/${claude.quota.max} run` : 'Login terminal'} pill={claude?.configured ? ['Siap', 'pill-green'] : ['Tidak ditemukan', 'pill-amber']} />
        {providers.data?.map((p) => (
          <ProviderItem key={p.id} provider={p} waiting={agents.data?.filter((a) => a.runtime === p.id && a.status === 'waiting_provider').length ?? 0} onChanged={() => (providers.refresh(), agents.refresh())} />
        ))}
        <InstagramItem />
        <ImageModelItem />
        {toolsWithCred.map((t) => (
          <ToolItem key={t.id} tool={t} onChanged={tools.refresh} />
        ))}
      </>
      <section className="card" aria-label="Pemakaian akses" style={{ gridColumn: '1 / -1' }}>
        <div className="panel-head"><h2 className="label">Siapa memakai apa</h2></div>
        <div className="usage-grid">
          <div className="table-box">
            <table>
              <thead><tr><th scope="col">Karyawan</th><th scope="col">Runtime</th><th scope="col">Status</th></tr></thead>
              <tbody>
                {agents.data?.filter((a) => a.status !== 'retired').map((a) => (
                  <tr key={a.id}>
                    <td><strong style={{ fontWeight: 600 }}>{a.name}</strong></td>
                    <td className="mono small">{a.runtime}{a.model ? ` · ${a.model}` : ''}</td>
                    <td><span className={`pill ${a.status === 'active' ? 'pill-green' : a.status === 'waiting_provider' ? 'pill-amber' : 'pill-grey'}`}>{a.status === 'active' ? 'Aktif' : a.status === 'waiting_provider' ? 'Menunggu' : 'Dirumahkan'}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="table-box">
            <table>
              <thead><tr><th scope="col">Tool</th><th scope="col">Role</th><th scope="col">Risiko</th></tr></thead>
              <tbody>
                {tools.data?.map((t) => (
                  <tr key={t.id}>
                    <td><strong style={{ fontWeight: 600 }}>{t.title}</strong></td>
                    <td className="mono small">{t.roles.join(', ')}</td>
                    <td><span className={`pill ${t.risk === 'high' ? 'pill-amber' : 'pill-grey'}`}>{t.risk === 'high' ? 'Tinggi' : 'Rendah'}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>
      {(providers.error || tools.error) && <p className="error">{providers.error ?? tools.error}</p>}
    </main>
  );
}

function Item({ icon, title, sub, pill, children }: { icon: string; title: string; sub?: string; pill: [string, string]; open?: boolean; onToggle?: () => void; children?: ReactNode }) {
  return (
    <section className="card" aria-label={title} style={{ gap: 18 }}>
      <div className="acc-head">
        <span className="acc-ic" aria-hidden="true"><svg width="22" height="22" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d={icon} /></svg></span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <strong style={{ fontSize: 16, display: 'block' }}>{title}</strong>
          <span className="muted small">{sub ?? '\u00a0'}</span>
        </div>
        <span className={`pill ${pill[1]}`}>{pill[0]}</span>
      </div>
      {children}
    </section>
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
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState('');
  const { busy, msg, run } = useAction(refresh);
  if (!data) return null;
  return (
    <Item
      icon="M5 3h10a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2zM10 7.5a2.5 2.5 0 100 5 2.5 2.5 0 000-5z"
      title="Instagram"
      sub={data.accounts.length > 0 ? data.accounts.map((a) => `@${a.username}`).join(', ') : data.configured ? `••••${data.last4}` : undefined}
      pill={data.accounts.length > 0 ? ['Terhubung', 'pill-green'] : ['Belum terhubung', 'pill-amber']}
      open={open}
      onToggle={() => setOpen(!open)}
    >
      <form
        className="acc-form"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await api.saveInstagramKey({ apiKey: key.trim() });
            setKey('');
          }, 'Tersimpan.');
        }}
      >
        <div className="field" style={{ flex: '1 1 320px' }}>
          <label htmlFor="ig-key">API key NC-WA</label>
          <input id="ig-key" className="mono" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder={data.configured ? `••••${data.last4}` : 'ncig_…'} />
        </div>
        <div className="row wrap">
          <button type="submit" className="btn btn-ghost" disabled={busy || !key.trim()}>Simpan</button>
          {data.configured && <Remove busy={busy} label="Hapus" what="API key NC-WA" onConfirm={() => void run(() => api.removeInstagramKey(), 'Dihapus.')} />}
        </div>
        {data.error && <p className="small" style={{ color: 'var(--orange-ink)', flexBasis: '100%' }}>{data.error}</p>}
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
              </li>
            ))}
          </ul>
        )}
        <Msg msg={msg} />
      </form>
    </Item>
  );
}

const usd = (n: number) => `$${n.toFixed(n < 1 ? 3 : 2)}`;

/** OpenRouter khusus model gambar. Tanpa model aktif (atau kuota habis) gambar post berupa teks di latar putih. */
function ImageModelItem() {
  const info = useLive(api.imageModel);
  const settings = useLive(api.settings);
  if (!info.data || !settings.data) return null;
  return <ImageModelBody info={info.data} settings={settings.data} onChanged={() => (info.refresh(), settings.refresh())} />;
}

function ImageModelBody({ info, settings, onChanged }: { info: ImageModelInfo; settings: Settings; onChanged: () => void }) {
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState(info.model);
  const [enabled, setEnabled] = useState(info.configured ? info.enabled : true);
  const [limits, setLimits] = useState({
    perDay: String(settings.image_max_per_day),
    costDay: String(settings.image_max_cost_usd_per_day),
    publicUrl: settings.public_base_url,
  });
  const [test, setTest] = useState<ImageTestResult | null>(null);
  const modelForm = useAction(() => (setApiKey(''), onChanged()));
  const limitForm = useAction(onChanged);
  const tester = useAction(onChanged);
  const active = info.configured && info.enabled;
  const { day } = info.usage;
  const cap = (used: string, max: number, fmt: (n: number) => string = String) => `${used}${max > 0 ? ` / ${fmt(max)}` : ' (tanpa batas)'}`;
  return (
    <Item
      icon="M3 5a2 2 0 012-2h10a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2V5zM3 14l4-4 3 3 3-3 4 4M13 7.5h.01"
      title="Model gambar"
      sub={active ? `${info.model} · ••••${info.last4}` : 'Tanpa model: gambar berupa teks di latar putih'}
      pill={active ? ['Aktif', 'pill-green'] : info.configured ? ['Nonaktif', 'pill-grey'] : ['Teks saja', 'pill-grey']}
    >
      <form
        className="acc-form"
        onSubmit={(e) => {
          e.preventDefault();
          void modelForm.run(() => api.saveImageModel({ apiKey: apiKey.trim() || undefined, model: model.trim(), enabled }), 'Tersimpan.');
        }}
      >
        <div className="field" style={{ flex: '1 1 220px' }}><label htmlFor="img-key">API key OpenRouter (khusus gambar)</label><input id="img-key" className="mono" type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={info.configured ? 'Kosongkan untuk tetap' : 'sk-or-…'} /></div>
        <div className="field" style={{ flex: '1 1 220px' }}><label htmlFor="img-model">Vendor/model</label><input id="img-model" value={model} onChange={(e) => setModel(e.target.value)} placeholder="google/gemini-2.5-flash-image" required minLength={3} /></div>
        <label className="row small" style={{ gap: 8, alignItems: 'center' }}><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Aktif</label>
        <div className="row wrap">
          <button className="btn" type="submit" disabled={modelForm.busy || model.trim().length < 3 || (!info.configured && !apiKey.trim())}>Simpan</button>
          {info.configured && <Remove busy={modelForm.busy} label="Hapus" what="API key model gambar" onConfirm={() => void modelForm.run(() => api.removeImageModel(), 'Dihapus.')} />}
        </div>
        <Msg msg={modelForm.msg} />
      </form>

      <form
        className="acc-form"
        onSubmit={(e) => {
          e.preventDefault();
          void limitForm.run(
            () => api.updateSettings({ image_max_per_day: Number(limits.perDay), image_max_cost_usd_per_day: Number(limits.costDay), public_base_url: limits.publicUrl.trim().replace(/\/+$/, '') }),
            'Tersimpan.',
          );
        }}
      >
        <div className="field" style={{ flex: '1 1 150px' }}><label htmlFor="img-day">Gambar per 24 jam</label><input id="img-day" type="number" min={0} step={1} value={limits.perDay} onChange={(e) => setLimits({ ...limits, perDay: e.target.value })} /></div>
        <div className="field" style={{ flex: '1 1 150px' }}><label htmlFor="img-cost-day">Biaya per 24 jam (USD)</label><input id="img-cost-day" type="number" min={0} step="0.01" value={limits.costDay} onChange={(e) => setLimits({ ...limits, costDay: e.target.value })} /></div>
        <div className="field" style={{ flex: '1 1 100%' }}><label htmlFor="img-public">Alamat publik server (agar Instagram bisa mengambil gambar)</label><input id="img-public" type="url" value={limits.publicUrl} onChange={(e) => setLimits({ ...limits, publicUrl: e.target.value })} placeholder="https://kantor.contoh.id" /></div>
        <p className="muted small" style={{ flexBasis: '100%', margin: 0 }}>0 = tanpa batas. Saat batas tercapai, gambar otomatis berupa teks di latar putih; post tidak tertunda. Hanya <span className="mono">/media/…</span> yang dibuka ke publik.</p>
        <div className="row wrap">
          <button className="btn btn-ghost" type="submit" disabled={limitForm.busy}>Simpan batas</button>
          <button className="btn btn-ghost" type="button" disabled={tester.busy} onClick={() => void tester.run(async () => setTest(await api.testImageModel()))}>{tester.busy ? 'Membuat…' : 'Uji buat gambar'}</button>
        </div>
        <Msg msg={limitForm.msg} />
        <Msg msg={tester.msg} />
      </form>

      <p className="small" style={{ margin: 0 }}>
        Pemakaian: {cap(String(day.count), settings.image_max_per_day)} gambar · {cap(usd(day.costUsd), settings.image_max_cost_usd_per_day, usd)} dalam 24 jam terakhir
      </p>
      {test && (
        <div className="row" style={{ gap: 14, alignItems: 'flex-start' }}>
          <img src={`/media/${test.file}`} alt="Contoh gambar" width={120} style={{ border: '1px solid var(--line, #ddd)', borderRadius: 6 }} />
          <span className="small">{test.source === 'model' ? 'Dibuat oleh model gambar.' : `Gambar teks di latar putih${test.reason ? ` — ${test.reason}` : ''}.`}</span>
        </div>
      )}
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
