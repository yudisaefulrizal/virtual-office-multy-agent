import { useEffect, useState } from 'react';
import { api, useLive, type CompanyCharter, type CompanyStatus } from '../api';
import { TASK_STATUS, dateTime } from '../format';

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
  const { data, error, refresh } = useLive(api.company);
  if (error && !data) return <main className="page"><p className="error">{error}</p></main>;
  if (!data) return <main className="page"><p className="muted">Memuat…</p></main>;
  return (
    <main className="page company-grid">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
        <StatusCard status={data} onChanged={refresh} />
        <ObjectiveList status={data} />
      </div>
      <CharterForm status={data} onSaved={refresh} />
    </main>
  );
}

const STATE_LABEL = { unset: 'Belum diatur', paused: 'Dijeda', running: 'Berjalan sendiri' } as const;

function StatusCard({ status, onChanged }: { status: CompanyStatus; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const c = status.company;
  const act = async (a: 'start' | 'pause') => {
    setBusy(true);
    setErr(null);
    try {
      await api.companyAction(a);
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card" aria-labelledby="co-status">
      <div className="row wrap between">
        <h1 id="co-status" style={{ fontSize: 24, fontWeight: 600 }}>{c?.name || 'Perusahaan'}</h1>
        <span className="chip" style={{ color: status.state === 'running' ? 'var(--green)' : 'var(--ink-2)', fontWeight: 600 }}>{STATE_LABEL[status.state]}</span>
      </div>
      {status.state === 'unset' ? (
        <p className="muted" style={{ margin: 0 }}>
          Isi jenis usaha, produk, dan batas di samping. Setelah itu perusahaan bekerja sendiri: CEO menentukan pekerjaan, tim merekrut dan mengerjakan,
          hasil masuk ke halaman Hasil. Anda hanya dihubungi bila sesuatu melewati batas yang Anda tetapkan.
        </p>
      ) : (
        <>
          {c?.pausedReason && status.state === 'paused' && <p className="error" style={{ margin: 0 }}>{c.pausedReason}</p>}
          {status.waiting && <p className="small muted" style={{ margin: 0 }}>{status.waiting}</p>}
          <div className="tiles">
            <Tile label="Pekerjaan berjalan" value={String(status.objectives.filter((o) => !['completed', 'failed', 'cancelled'].includes(o.status) && o.mode !== 'agenda').length)} sub={`maks ${c?.maxActiveObjectives}`} />
            <Tile label="Agenda berikutnya" value={status.nextAgendaAt && status.state === 'running' ? dateTime(status.nextAgendaAt) : '—'} sub={c?.lastAgendaAt ? `terakhir ${dateTime(c.lastAgendaAt)}` : 'belum ada agenda'} />
            <Tile label="Budget API bulan ini" value={`$${status.spentUsd.toFixed(2)}`} sub={c && c.monthlyBudgetUsd > 0 ? `dari $${c.monthlyBudgetUsd.toFixed(2)}` : 'tanpa API berbayar'} />
            <Tile label="Kuota Claude" value={status.quota ? `${status.quota.used}/${status.quota.max}` : '—'} sub="run dalam jendela" />
          </div>
          <div className="row wrap">
            {status.state === 'running' ? (
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => act('pause')}>Jeda perusahaan</button>
            ) : (
              <button type="button" className="btn" disabled={busy} onClick={() => act('start')}>Jalankan perusahaan</button>
            )}
            {err && <span className="error small">{err}</span>}
          </div>
        </>
      )}
      {status.state === 'unset' || !c ? null : (
        <p className="small muted" style={{ margin: 0 }}>
          Saat berjalan, Anda tidak perlu menyetujui apa pun yang masih dalam batas. Hal yang melewati batas muncul di kotak "Perlu Anda" pada halaman Kantor.
        </p>
      )}
    </section>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="tile">
      <span className="small muted">{label}</span>
      <span className="tile-value" style={{ fontSize: 20 }}>{value}</span>
      <span className="small muted">{sub}</span>
    </div>
  );
}

function ObjectiveList({ status }: { status: CompanyStatus }) {
  const rows = status.objectives.filter((o) => o.mode !== 'agenda');
  const agendas = status.objectives.filter((o) => o.mode === 'agenda').length;
  return (
    <section className="card" aria-labelledby="co-work">
      <h2 id="co-work">Pekerjaan yang diputuskan perusahaan</h2>
      {rows.length === 0 ? (
        <p className="muted small" style={{ margin: 0 }}>Belum ada. Begitu perusahaan dijalankan, CEO menyusun agenda pertamanya.</p>
      ) : (
        <div className="table-box">
          <table style={{ minWidth: 480 }}>
            <thead>
              <tr><th scope="col">Objective</th><th scope="col">Status</th><th scope="col">Dibuat</th></tr>
            </thead>
            <tbody>
              {rows.map((o) => {
                const st = TASK_STATUS[o.status] ?? TASK_STATUS.new!;
                return (
                  <tr key={o.id}>
                    <td><a href={`#/objectives/${o.id}`} style={{ fontWeight: 500 }}>{o.title}</a></td>
                    <td><span className="row" style={{ gap: 6 }}><span className={`dot ${st.dot}`} /><span style={{ color: st.tone, fontWeight: 500 }}>{st.label}</span></span></td>
                    <td className="small muted">{dateTime(o.createdAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {agendas > 0 && <p className="small muted" style={{ margin: 0 }}>{agendas} agenda CEO tercatat. Hasil akhir ada di halaman <a href="#/results">Hasil</a>.</p>}
    </section>
  );
}

function CharterForm({ status, onSaved }: { status: CompanyStatus; onSaved: () => void }) {
  const [f, setF] = useState<CompanyCharter>(status.company ?? EMPTY);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [dirty, setDirty] = useState(false);
  // Isi ulang dari server hanya bila Owner belum mengubah apa pun.
  useEffect(() => {
    if (!dirty && status.company) setF(status.company);
  }, [status.company, dirty]);
  const set = <K extends keyof CompanyCharter>(k: K, v: CompanyCharter[K]) => (setDirty(true), setF((p) => ({ ...p, [k]: v })));
  const valid = f.businessType.trim().length >= 3 && f.product.trim().length >= 3;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await api.saveCompany(f);
      setDirty(false);
      setMsg({ ok: true, text: status.state === 'unset' ? 'Tersimpan. Tekan "Jalankan perusahaan" untuk memulai.' : 'Tersimpan. Berlaku untuk agenda berikutnya.' });
      onSaved();
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card" onSubmit={submit} aria-labelledby="co-charter" style={{ alignSelf: 'start' }}>
      <h2 id="co-charter">Profil dan batas perusahaan</h2>
      <p className="small muted" style={{ margin: 0 }}>Cukup deskripsi usaha dan batas. Perusahaan menentukan sisanya sendiri.</p>

      <div className="field">
        <label htmlFor="co-name">Nama perusahaan (opsional)</label>
        <input id="co-name" value={f.name} onChange={(e) => set('name', e.target.value)} maxLength={120} />
      </div>
      <div className="field">
        <label htmlFor="co-type">Jenis usaha</label>
        <input id="co-type" value={f.businessType} onChange={(e) => set('businessType', e.target.value)} placeholder="mis. Kedai kopi lokal dengan penjualan online" required />
      </div>
      <div className="field">
        <label htmlFor="co-product">Jenis produk</label>
        <textarea id="co-product" rows={2} value={f.product} onChange={(e) => set('product', e.target.value)} placeholder="mis. Biji kopi sangrai dan konten edukasi kopi" required />
      </div>
      <div className="field">
        <label htmlFor="co-aud">Target pasar (opsional)</label>
        <input id="co-aud" value={f.audience} onChange={(e) => set('audience', e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="co-guide">Pedoman (opsional)</label>
        <textarea id="co-guide" rows={2} value={f.guidelines} onChange={(e) => set('guidelines', e.target.value)} placeholder="mis. Bahasa santai, tanpa klaim kesehatan" />
      </div>
      <div className="field">
        <label htmlFor="co-forbid">Larangan keras (satu kata/frasa per baris)</label>
        <textarea id="co-forbid" rows={2} value={f.forbidden} onChange={(e) => set('forbidden', e.target.value)} placeholder={'politik\njudi'} />
        <span className="small muted">Agenda yang memuat kata ini ditolak sebelum dikerjakan.</span>
      </div>

      <strong className="small">Batas</strong>
      <div className="field">
        <label htmlFor="co-budget">Budget API berbayar per bulan (USD, 0 = tidak memakai)</label>
        <input id="co-budget" type="number" min={0} step="0.5" value={f.monthlyBudgetUsd} onChange={(e) => set('monthlyBudgetUsd', Number(e.target.value))} />
        <span className="small muted">Melewati batas ini perusahaan dijeda dan Anda diberi tahu. Pemakaian Claude (langganan) dibatasi lewat kuota run di Pengaturan.</span>
      </div>
      <div className="row wrap">
        <div className="field" style={{ flex: 1, minWidth: 140 }}>
          <label htmlFor="co-active">Pekerjaan bersamaan</label>
          <input id="co-active" type="number" min={1} max={5} value={f.maxActiveObjectives} onChange={(e) => set('maxActiveObjectives', Number(e.target.value))} />
        </div>
        <div className="field" style={{ flex: 1, minWidth: 140 }}>
          <label htmlFor="co-new">Baru per agenda</label>
          <input id="co-new" type="number" min={1} max={5} value={f.maxNewPerCycle} onChange={(e) => set('maxNewPerCycle', Number(e.target.value))} />
        </div>
        <div className="field" style={{ flex: 1, minWidth: 140 }}>
          <label htmlFor="co-cycle">Jeda agenda (jam)</label>
          <input id="co-cycle" type="number" min={1} max={168} value={f.cycleHours} onChange={(e) => set('cycleHours', Number(e.target.value))} />
        </div>
      </div>
      <label className="row small" style={{ alignItems: 'flex-start' }}>
        <input type="checkbox" checked={f.autoPublish} onChange={(e) => set('autoPublish', e.target.checked)} style={{ marginTop: 3 }} />
        <span>Boleh mempublikasikan ke kanal publik (mis. Instagram) tanpa bertanya, bila akses sudah dipasang. Bila tidak dicentang, setiap publikasi menunggu persetujuan Anda.</span>
      </label>

      <div className="row wrap">
        <button type="submit" className="btn" disabled={busy || !valid || !dirty}>Simpan</button>
        {msg && <span className={msg.ok ? 'small' : 'error small'} role="status">{msg.text}</span>}
      </div>
    </form>
  );
}
