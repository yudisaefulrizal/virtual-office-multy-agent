import { useState } from 'react';
import { api, useLive, type CompanyCharter, type CompanyStatus } from '../api';
import { dateTime, eventText, time } from '../format';
import { Inbox } from './Inbox';
import { OfficeStage } from './OfficePage';

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

/** Beranda: pusat komando. Kantor 3D di tengah, keputusan dan pekerjaan di samping, hasil di bawah. */
export function CompanyPage() {
  const status = useLive(api.company);
  const office = useLive(api.office);
  const data = status.data;
  if (status.error && !data) return <main className="page"><p className="error">{status.error}</p></main>;
  if (!data || !office.data) return <main className="page"><p className="muted">Memuat…</p></main>;

  if (data.state === 'unset') {
    return (
      <main className="onboard">
        <OfficeStage data={office.data} showAgent={false} />
        <CharterForm initial={EMPTY} first onDone={async (start) => { if (start) await api.companyAction('start'); status.refresh(); }} />
      </main>
    );
  }

  const work = data.objectives.filter((o) => o.mode !== 'agenda' && !['completed', 'failed', 'cancelled'].includes(o.status));
  const events = office.data.events.slice(0, 30);
  return (
    <main className="cc">
      <div className="cc-stage" style={{ display: 'flex', minHeight: 0 }}>
        <OfficeStage data={office.data} expand />
      </div>

      <section className="card strip cc-strip" aria-label="Hasil terbaru">
        <div className="panel-head"><h2 className="label">Hasil terbaru</h2><a href="#/results" className="small" style={{ fontWeight: 700, textDecoration: 'none' }}>Semua hasil →</a></div>
        {(
          <div className="film">
            {data.state === 'running' && (
              <div className="tile3d next" aria-label="Agenda berikutnya">
                <span className="label">Agenda berikutnya</span>
                <strong className="mono" style={{ fontWeight: 500 }}>{data.nextAgendaAt ? dateTime(data.nextAgendaAt) : 'Segera'}</strong>
                <span className="small muted">{data.waiting ?? 'CEO memilih pekerjaan'}</span>
              </div>
            )}
            {data.results.map((r, i) => (
              <a key={`${r.objectiveId}-${i}`} href="#/results" className={`tile3d${i === 0 ? ' accent' : ''}`}>
                <span style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <strong>{r.title}</strong>
                  {r.summary && <span className="small muted">{r.summary}</span>}
                </span>
                <span className="row between">
                  <span className="small muted">{r.at ? time(r.at) : ''}</span>
                  <span className={`pill ${r.status === 'completed' ? 'pill-green' : 'pill-blue'}`}>{r.status === 'completed' ? 'Selesai' : 'Berjalan'}</span>
                </span>
              </a>
            ))}
          </div>
        )}
      </section>

      <div className="cc-side">
        {office.data.inbox.length > 0 && <Inbox items={office.data.inbox} onChanged={() => (office.refresh(), status.refresh())} />}

        <section className="card" aria-label="Sedang dikerjakan" style={{ gap: 4 }}>
          <div className="panel-head"><h2 className="label">Sedang dikerjakan</h2><span className="mono small muted">{work.length}/{data.company!.maxActiveObjectives}</span></div>
          {work.length === 0 ? <p className="muted small" style={{ margin: '8px 0 0' }}>{data.waiting ?? 'Menunggu agenda CEO'}</p> : work.map((o) => <Work key={o.id} o={o} />)}
        </section>

        <section className="card grow" aria-label="Aktivitas" style={{ gap: 8 }}>
          <div className="panel-head"><h2 className="label">Aktivitas</h2><span className="live" aria-hidden="true" /></div>
          <div className="scroll">
            <ol className="feed">
              {events.map((e) => (
                <li key={e.id}>
                  <span className="mono small muted">{time(e.createdAt)}</span>
                  <span><strong>{e.actorName}</strong> {eventText(e.type, e.payload)}</span>
                </li>
              ))}
            </ol>
          </div>
        </section>
      </div>
    </main>
  );
}

function Work({ o }: { o: CompanyStatus['objectives'][number] }) {
  const steps = o.steps.length > 0 ? o.steps : [{ title: 'Menyiapkan', status: 'queued', kind: 'planning', agentName: null }];
  const done = steps.filter((s) => s.status === 'completed').length;
  const current = steps.find((s) => s.status === 'running') ?? steps.find((s) => s.status === 'queued' || s.status === 'pending');
  return (
    <a className="work" href={`#/objectives/${o.id}`}>
      <span style={{ minWidth: 0 }}>
        <strong style={{ display: 'block', fontSize: 14 }}>{o.title}</strong>
        <span className="muted small">{current ? `${current.title}${current.agentName ? ` · ${current.agentName}` : ''}` : 'Selesai'}</span>
      </span>
      <span className="mono muted small" style={{ textAlign: 'right' }}>{done}/{steps.length}</span>
      <span className="bar" aria-label={`${done} dari ${steps.length} langkah`}>
        {steps.map((s, i) => <i key={i} className={s.status === 'completed' ? 'd' : s.status === 'running' ? 'c' : undefined} />)}
      </span>
    </a>
  );
}

/** Ubah profil dan batas perusahaan. */
export function ProfilePage() {
  const status = useLive(api.company);
  const office = useLive(api.office);
  if (!status.data || !office.data) return <main className="page"><p className="muted">Memuat…</p></main>;
  return (
    <main className="onboard">
      <OfficeStage data={office.data} showAgent={false} />
      <CharterForm
        initial={status.data.company ?? EMPTY}
        first={status.data.state === 'unset'}
        onDone={async (start) => {
          if (start) await api.companyAction('start');
          window.location.hash = '#/';
        }}
      />
    </main>
  );
}

function CharterForm({ initial, first, onDone }: { initial: CompanyCharter; first: boolean; onDone: (start: boolean) => Promise<void> }) {
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
    <section className="card onboard-form" aria-labelledby="cf-title">
      <div>
        <h1 id="cf-title" className="page-title">{first ? 'Bangun perusahaan Anda' : 'Profil perusahaan'}</h1>
        {first && <p className="muted" style={{ margin: '6px 0 0' }}>Isi usaha dan batas, lalu jalankan.</p>}
      </div>
      <div className="field"><label htmlFor="cf-name">Nama</label><input id="cf-name" value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="Kopi Senja" /></div>
      <div className="row wrap" style={{ gap: 12, alignItems: 'flex-start' }}>
        <div className="field" style={{ flex: '1 1 200px' }}><label htmlFor="cf-type">Jenis usaha</label><input id="cf-type" value={f.businessType} onChange={(e) => set('businessType', e.target.value)} placeholder="Kedai kopi lokal" /></div>
        <div className="field" style={{ flex: '1 1 200px' }}><label htmlFor="cf-aud">Target pasar</label><input id="cf-aud" value={f.audience} onChange={(e) => set('audience', e.target.value)} placeholder="Anak muda" /></div>
      </div>
      <div className="field"><label htmlFor="cf-product">Produk</label><input id="cf-product" value={f.product} onChange={(e) => set('product', e.target.value)} placeholder="Biji kopi sangrai, konten edukasi" /></div>
      <div className="row wrap" style={{ gap: 12, alignItems: 'flex-start' }}>
        <div className="field" style={{ flex: '1 1 200px' }}><label htmlFor="cf-guide">Pedoman</label><input id="cf-guide" value={f.guidelines} onChange={(e) => set('guidelines', e.target.value)} placeholder="Santai, tanpa klaim kesehatan" /></div>
        <div className="field" style={{ flex: '1 1 200px' }}><label htmlFor="cf-forbid">Larangan</label><input id="cf-forbid" value={f.forbidden} onChange={(e) => set('forbidden', e.target.value)} placeholder="politik, judi" /></div>
      </div>
      <div style={{ height: 1, background: 'var(--line)' }} />
      <div className="row wrap" style={{ gap: 16, alignItems: 'flex-end' }}>
        <Seg label="Pekerjaan bersamaan" value={f.maxActiveObjectives} options={[[1, '1'], [2, '2'], [3, '3'], [5, '5']]} onChange={(v) => set('maxActiveObjectives', v)} />
        <Seg label="Agenda CEO" value={f.cycleHours} options={[[6, '6 jam'], [24, 'Harian'], [168, 'Mingguan']]} onChange={(v) => set('cycleHours', v)} />
      </div>
      <div className="row wrap" style={{ gap: 16, alignItems: 'flex-end' }}>
        <div className="field" style={{ width: 160 }}>
          <label htmlFor="cf-budget">Budget API / bulan</label>
          <div style={{ position: 'relative' }}>
            <span className="mono muted" style={{ position: 'absolute', left: 12, top: 10 }}>$</span>
            <input id="cf-budget" className="mono" type="number" min={0} step="0.5" value={f.monthlyBudgetUsd} onChange={(e) => set('monthlyBudgetUsd', Number(e.target.value))} style={{ paddingLeft: 26 }} />
          </div>
        </div>
        <label className="row" style={{ fontSize: 13, cursor: 'pointer', minHeight: 42 }}>
          <input type="checkbox" checked={f.autoPublish} onChange={(e) => set('autoPublish', e.target.checked)} />
          Terbitkan tanpa persetujuan
        </label>
      </div>
      {err && <p className="error" role="alert" style={{ margin: 0 }}>{err}</p>}
      <div className="row wrap">
        <button type="button" className="btn" style={{ minHeight: 44, flex: '1 1 200px' }} disabled={busy || !valid} onClick={() => save(true)}>
          {first ? 'Jalankan perusahaan' : 'Simpan dan jalankan'}
        </button>
        <button type="button" className="btn btn-ghost" style={{ minHeight: 44 }} disabled={busy || !valid} onClick={() => save(false)}>Simpan</button>
        {!first && <a className="btn btn-ghost" style={{ minHeight: 44 }} href="#/">Batal</a>}
      </div>
    </section>
  );
}

function Seg({ label, value, options, onChange }: { label: string; value: number; options: [number, string][]; onChange: (v: number) => void }) {
  const id = `seg-${label.replace(/\s+/g, '-')}`;
  return (
    <div className="field">
      <span id={id} style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink-2)' }}>{label}</span>
      <div className="seg" role="radiogroup" aria-labelledby={id}>
        {options.map(([v, text]) => (
          <button key={v} type="button" role="radio" aria-checked={value === v} className={value === v ? 'on' : undefined} onClick={() => onChange(v)}>{text}</button>
        ))}
      </div>
    </div>
  );
}
