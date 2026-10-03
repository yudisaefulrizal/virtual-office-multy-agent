import { useState } from 'react';
import { api, useLive, type CompanyCharter, type CompanyStatus } from '../api';
import { eventText, time } from '../format';
import { Inbox } from './Inbox';

const EMPTY: CompanyCharter = {
  name: '',
  businessType: '',
  product: '',
  audience: '',
  guidelines: '',
  forbidden: '',
  monthlyBudgetUsd: 0,
  maxActiveObjectives: 2,
  maxNewPerCycle: 2,
  cycleHours: 24,
  autoPublish: false,
};

export function CompanyPage() {
  const status = useLive(api.company);
  const office = useLive(api.office);
  const [editing, setEditing] = useState(false);
  const data = status.data;
  if (status.error && !data) return <main className="page"><p className="error">{status.error}</p></main>;
  if (!data) return <main className="page"><p className="muted">Memuat…</p></main>;

  if (data.state === 'unset' || editing) {
    return (
      <CharterForm
        initial={data.company ?? EMPTY}
        first={data.state === 'unset'}
        onDone={async (start) => {
          if (start) await api.companyAction('start');
          setEditing(false);
          status.refresh();
        }}
        onCancel={data.state === 'unset' ? undefined : () => setEditing(false)}
      />
    );
  }

  const work = data.objectives.filter((o) => o.mode !== 'agenda' && !['completed', 'failed', 'cancelled'].includes(o.status));
  const c = data.company!;
  return (
    <main className="page" style={{ display: 'flex', flexDirection: 'column', gap: 32 }}>
      <Header status={data} onEdit={() => setEditing(true)} onChanged={status.refresh} />
      {office.data && office.data.inbox.length > 0 && <Inbox items={office.data.inbox} onChanged={() => (office.refresh(), status.refresh())} />}

      <section aria-label="Pemakaian" className="usage">
        <Usage label="Pekerjaan" value={work.length} max={c.maxActiveObjectives} warn={work.length >= c.maxActiveObjectives} />
        <Usage label="Kuota Claude" value={data.quota?.used ?? 0} max={data.quota?.max ?? 0} />
        <Usage label="Budget API" value={data.spentUsd} max={c.monthlyBudgetUsd} money />
      </section>

      <div className="two">
        <section aria-label="Sedang dikerjakan" style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
          <h2 className="label">Sedang dikerjakan</h2>
          <div className="card list">
            {work.length === 0 && <p className="muted" style={{ margin: 0, padding: 20 }}>{data.waiting ?? 'Menunggu agenda CEO'}</p>}
            {work.map((o) => (
              <Work key={o.id} o={o} />
            ))}
          </div>
        </section>
        <section aria-label="Aktivitas" style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
          <div className="row between"><h2 className="label">Aktivitas</h2><a href="#/office" className="muted small" style={{ fontWeight: 600, textDecoration: 'none' }}>Kantor →</a></div>
          <ol className="feed">
            {(office.data?.events ?? []).slice(0, 6).map((e) => (
              <li key={e.id}>
                <span className="mono small muted">{time(e.createdAt)}</span>
                <span><strong>{e.actorName}</strong> {eventText(e.type, e.payload)}</span>
              </li>
            ))}
          </ol>
        </section>
      </div>

      {data.results.length > 0 && (
        <section aria-label="Hasil terbaru" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="row between"><h2 className="label">Hasil terbaru</h2><a href="#/results" className="muted small" style={{ fontWeight: 600, textDecoration: 'none' }}>Semua →</a></div>
          <div className="thumbs">
            {data.results.map((r, i) => (
              <a key={`${r.objectiveId}-${i}`} href="#/results" className="card thumb">
                <div className={`thumb-art${i === 0 ? ' dark' : ''}`}>{r.title}</div>
                <div className="row between" style={{ padding: '14px 16px' }}>
                  <span style={{ fontWeight: 600, minWidth: 0 }}>{r.title}</span>
                  <span className={`pill ${r.status === 'completed' ? 'pill-green' : 'pill-blue'}`}>{r.status === 'completed' ? 'Selesai' : 'Berjalan'}</span>
                </div>
              </a>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}

function Header({ status, onEdit, onChanged }: { status: CompanyStatus; onEdit: () => void; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const running = status.state === 'running';
  const c = status.company!;
  const act = async () => {
    setBusy(true);
    try {
      await api.companyAction(running ? 'pause' : 'start');
      onChanged();
    } finally {
      setBusy(false);
    }
  };
  return (
    <header className="row wrap between" style={{ gap: 16 }}>
      <div className="row wrap" style={{ gap: 16 }}>
        <h1 className="page-title">{c.name || 'Perusahaan'}</h1>
        <span className={`pill ${running ? 'pill-green' : 'pill-grey'}`} style={{ height: 28, padding: '0 12px', fontSize: 13 }}>
          <span className="dot" style={{ width: 8, height: 8, background: running ? '#16a34a' : '#8c929a' }} />
          {running ? 'Berjalan' : 'Dijeda'}
        </span>
      </div>
      <div className="row">
        <button type="button" className="btn btn-ghost" onClick={onEdit}>Batas</button>
        <button type="button" className={running ? 'btn btn-ghost' : 'btn'} disabled={busy} onClick={act}>{running ? 'Jeda' : 'Jalankan'}</button>
      </div>
      {c.pausedReason && !running && <p className="error" style={{ flexBasis: '100%', margin: 0 }}>{c.pausedReason}</p>}
    </header>
  );
}

function Usage({ label, value, max, warn, money }: { label: string; value: number; max: number; warn?: boolean; money?: boolean }) {
  const fmt = (n: number) => (money ? `$${n.toFixed(n < 10 ? 1 : 0)}` : String(Math.round(n)));
  return (
    <div className="card" style={{ gap: 12 }}>
      <span className="label">{label}</span>
      <span className="mono big">
        {fmt(value)}
        {max > 0 && <span className="muted" style={{ fontSize: 20 }}> / {fmt(max)}</span>}
      </span>
      {max > 0 && (
        <div className={`meter${warn || value / max >= 0.8 ? ' warn' : ''}`} role="img" aria-label={`${fmt(value)} dari ${fmt(max)}`}>
          <span style={{ width: `${Math.min(100, (value / max) * 100)}%` }} />
        </div>
      )}
    </div>
  );
}

function Work({ o }: { o: CompanyStatus['objectives'][number] }) {
  const steps = o.steps.length > 0 ? o.steps : [{ title: 'Menyiapkan', status: 'queued', kind: 'planning', agentName: null }];
  const done = steps.filter((s) => s.status === 'completed').length;
  const current = steps.find((s) => s.status === 'running') ?? steps.find((s) => s.status === 'queued' || s.status === 'pending');
  return (
    <a className="work" href={`#/objectives/${o.id}`}>
      <span style={{ minWidth: 0 }}>
        <strong style={{ fontSize: 16, display: 'block' }}>{o.title}</strong>
        <span className="muted small">{current ? `${current.title}${current.agentName ? ` · ${current.agentName}` : ''}` : 'Selesai'}</span>
      </span>
      <span className="bar" aria-label={`${done} dari ${steps.length} langkah`}>
        {steps.map((s, i) => (
          <i key={i} className={s.status === 'completed' ? 'd' : s.status === 'running' ? 'c' : undefined} />
        ))}
      </span>
      <span className="mono muted small" style={{ textAlign: 'right' }}>{done}/{steps.length}</span>
    </a>
  );
}

function CharterForm({ initial, first, onDone, onCancel }: { initial: CompanyCharter; first: boolean; onDone: (start: boolean) => Promise<void>; onCancel?: () => void }) {
  const [f, setF] = useState<CompanyCharter>({ ...initial, forbidden: initial.forbidden.split('\n').filter(Boolean).join(', ') });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = <K extends keyof CompanyCharter>(k: K, v: CompanyCharter[K]) => setF((p) => ({ ...p, [k]: v }));
  const valid = f.businessType.trim().length >= 3 && f.product.trim().length >= 3;

  const save = async (start: boolean) => {
    setBusy(true);
    setErr(null);
    try {
      await api.saveCompany({ ...f, maxNewPerCycle: f.maxActiveObjectives, forbidden: f.forbidden.split(/[,\n;]+/).map((x) => x.trim()).filter(Boolean).join('\n') });
      await onDone(start);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="page" style={{ maxWidth: 640, display: 'flex', flexDirection: 'column', gap: 32 }}>
      <h1 className="page-title" style={{ fontSize: 39, lineHeight: 1.15 }}>Profil perusahaan</h1>
      <section className="card" aria-labelledby="cf-a" style={{ padding: 32, gap: 24 }}>
        <h2 id="cf-a" className="label">Usaha</h2>
        <Field id="cf-name" label="Nama" value={f.name} onChange={(v) => set('name', v)} />
        <Field id="cf-type" label="Jenis usaha" value={f.businessType} onChange={(v) => set('businessType', v)} placeholder="mis. Kedai kopi lokal" />
        <Field id="cf-product" label="Produk" value={f.product} onChange={(v) => set('product', v)} placeholder="mis. Biji kopi sangrai dan konten edukasi" />
        <Field id="cf-aud" label="Target pasar" value={f.audience} onChange={(v) => set('audience', v)} />
        <Field id="cf-guide" label="Pedoman" value={f.guidelines} onChange={(v) => set('guidelines', v)} placeholder="mis. Santai, tanpa klaim kesehatan" />
      </section>
      <section className="card" aria-labelledby="cf-b" style={{ padding: 32, gap: 24 }}>
        <h2 id="cf-b" className="label">Batas</h2>
        <Field id="cf-forbid" label="Larangan" value={f.forbidden} onChange={(v) => set('forbidden', v)} placeholder="politik, judi" />
        <div className="row wrap" style={{ gap: 24, alignItems: 'flex-start' }}>
          <Seg label="Pekerjaan bersamaan" value={f.maxActiveObjectives} options={[[1, '1'], [2, '2'], [3, '3'], [5, '5']]} onChange={(v) => set('maxActiveObjectives', v)} />
          <Seg label="Agenda CEO" value={f.cycleHours} options={[[6, '6 jam'], [24, 'Harian'], [168, 'Mingguan']]} onChange={(v) => set('cycleHours', v)} />
        </div>
        <div className="field" style={{ maxWidth: 200 }}>
          <label htmlFor="cf-budget">Budget API / bulan</label>
          <div style={{ position: 'relative' }}>
            <span className="mono muted" style={{ position: 'absolute', left: 14, top: 11 }}>$</span>
            <input id="cf-budget" className="mono" type="number" min={0} step="0.5" value={f.monthlyBudgetUsd} onChange={(e) => set('monthlyBudgetUsd', Number(e.target.value))} style={{ paddingLeft: 30 }} />
          </div>
        </div>
        <label className="row" style={{ fontSize: 14, cursor: 'pointer' }}>
          <input type="checkbox" checked={f.autoPublish} onChange={(e) => set('autoPublish', e.target.checked)} />
          Terbitkan tanpa menunggu persetujuan
        </label>
      </section>
      {err && <p className="error" role="alert" style={{ margin: 0 }}>{err}</p>}
      <div className="row wrap">
        <button type="button" className="btn" style={{ minHeight: 48, flex: '1 1 220px' }} disabled={busy || !valid} onClick={() => save(true)}>
          {first ? 'Jalankan perusahaan' : 'Simpan dan jalankan'}
        </button>
        <button type="button" className="btn btn-ghost" style={{ minHeight: 48 }} disabled={busy || !valid} onClick={() => save(false)}>Simpan</button>
        {onCancel && <button type="button" className="btn btn-ghost" style={{ minHeight: 48 }} onClick={onCancel}>Batal</button>}
      </div>
    </main>
  );
}

function Field({ id, label, value, onChange, placeholder }: { id: string; label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <div className="field" style={{ gap: 8 }}>
      <label htmlFor={id}>{label}</label>
      <input id={id} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} style={{ minHeight: 48, fontSize: 16 }} />
    </div>
  );
}

function Seg({ label, value, options, onChange }: { label: string; value: number; options: [number, string][]; onChange: (v: number) => void }) {
  return (
    <div className="field" style={{ gap: 8 }}>
      <span id={`seg-${label}`} style={{ fontSize: 13, fontWeight: 600 }}>{label}</span>
      <div className="seg" role="radiogroup" aria-labelledby={`seg-${label}`}>
        {options.map(([v, text]) => (
          <button key={v} type="button" role="radio" aria-checked={value === v} className={value === v ? 'on' : undefined} onClick={() => onChange(v)}>{text}</button>
        ))}
      </div>
    </div>
  );
}
