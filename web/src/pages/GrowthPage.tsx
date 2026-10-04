import { useState } from 'react';
import { api, useLive, type GrowthPost, type GrowthView } from '../api';
import { LineChart } from '../LineChart';

const RANGES = [7, 30, 90];
const INTERVALS = [
  { v: 0, label: 'Mati' },
  { v: 1, label: '1 jam' },
  { v: 3, label: '3 jam' },
  { v: 6, label: '6 jam' },
  { v: 12, label: '12 jam' },
  { v: 24, label: '24 jam' },
];
const nf = new Intl.NumberFormat('id-ID');
const dateFmt = new Intl.DateTimeFormat('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
const num = (n: number | null | undefined) => (n === null || n === undefined ? '—' : nf.format(n));

function ago(iso: string) {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 90) return 'baru saja';
  if (s < 3600) return `${Math.round(s / 60)} menit lalu`;
  if (s < 86400) return `${Math.round(s / 3600)} jam lalu`;
  return `${Math.round(s / 86400)} hari lalu`;
}

export function GrowthPage() {
  const [account, setAccount] = useState<string | null>(null);
  const [days, setDays] = useState(30);
  const { data, error, refresh } = useLive(() => api.growth(account, days), [account, days]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  if (error && !data) return <main className="page"><p className="error">{error}</p></main>;
  if (!data) return <main className="page"><p className="muted">Memuat…</p></main>;

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      refresh();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const acc = data.status?.accounts.find((a) => a.id === data.accountId);

  return (
    <main className="page growth" aria-label="Pertumbuhan">
      <div className="row wrap between" style={{ gap: 12 }}>
        <h1 className="page-title">Pertumbuhan{data.latest ? ` · @${data.latest.username}` : ''}</h1>
        <div className="row wrap" style={{ gap: 10 }}>
          {data.accounts.length > 1 && (
            <>
              <label className="sr-only" htmlFor="gr-acc">Akun</label>
              <select id="gr-acc" value={data.accountId ?? ''} onChange={(e) => setAccount(e.target.value)}>
                {data.accounts.map((a) => <option key={a.id} value={a.id}>@{a.username}</option>)}
              </select>
            </>
          )}
          <div className="seg" role="group" aria-label="Rentang waktu">
            {RANGES.map((d) => <button key={d} type="button" className={d === days ? 'on' : ''} aria-pressed={d === days} onClick={() => setDays(d)}>{d} hari</button>)}
          </div>
          <button type="button" className="btn btn-ghost" disabled={busy || !data.configured} onClick={() => void run(() => api.growthRefresh())}>{busy ? 'Mengambil…' : 'Perbarui'}</button>
        </div>
      </div>

      <div className="row wrap small muted" style={{ gap: 14 }}>
        <span>{data.status ? `Diperbarui ${ago(data.status.at)}${data.status.trigger === 'manual' ? ' (manual)' : ''}` : 'Belum pernah diambil'}</span>
        <label className="row" style={{ gap: 6 }}>
          Ambil otomatis tiap
          <select aria-label="Interval pengambilan data" value={data.intervalHours} disabled={busy} onChange={(e) => void run(() => api.updateSettings({ metrics_interval_hours: Number(e.target.value) }))}>
            {INTERVALS.map((i) => <option key={i.v} value={i.v}>{i.label}</option>)}
          </select>
        </label>
        {msg && <span className="error" role="alert">{msg}</span>}
      </div>

      <Notices data={data} summary={acc?.summary} media={acc?.media} accError={acc?.error} />

      {data.latest && <Overview data={data} />}
      {data.series.length > 0 && <Charts data={data} />}
      {data.posts.length > 0 && <Posts data={data} />}
    </main>
  );
}

function Notices({ data, summary, media, accError }: { data: GrowthView; summary?: string; media?: string; accError?: string }) {
  const items: { tone: 'amber' | 'blue'; node: React.ReactNode }[] = [];
  if (!data.configured) items.push({ tone: 'blue', node: <>Hubungkan akun Instagram dulu: isi API key NC-WA di halaman <a href="#/access">Akses</a>.</> });
  else if (!data.status) items.push({ tone: 'blue', node: <>Belum ada data. Klik <b>Perbarui</b> untuk mengambil data pertama; sesudahnya data diambil otomatis.</> });
  if (data.status?.error) items.push({ tone: 'amber', node: data.status.error });
  if (summary === 'no_scope') items.push({ tone: 'amber', node: <>API key NC-WA belum punya izin <span className="mono">insights:read</span>, jadi jumlah follower dan jangkauan belum bisa diambil. Di NC-WA › Integrasi › “API untuk aplikasi lain”, buat key baru dengan izin itu (akun juga harus sudah memberi izin insights; hubungkan ulang bila diminta), lalu tempel di <a href="#/access">Akses</a>.</> });
  if (media === 'no_scope') items.push({ tone: 'amber', node: <>API key NC-WA belum punya izin <span className="mono">comments:read</span>, jadi daftar postingan belum bisa diambil.</> });
  if (accError) items.push({ tone: 'amber', node: accError });
  if (data.latest && data.historyDays < 1) items.push({ tone: 'blue', node: <>Riwayat baru terkumpul sejak hari ini. Pertumbuhan 24 jam, 7 hari, dan 30 hari muncul seiring data bertambah; NC-WA tidak menyimpan riwayat, jadi hanya data yang diambil di sini yang tercatat.</> });
  return (
    <>
      {items.map((n, i) => <p key={i} className={`notice${n.tone === 'blue' ? ' notice-blue' : ''}`} role="status" style={{ margin: 0 }}>{n.node}</p>)}
    </>
  );
}

function Delta({ label, v }: { label: string; v: number | null }) {
  if (v === null) return <span className="gr-delta" title="Riwayat belum cukup untuk periode ini">{label} <b>—</b></span>;
  const dir = v > 0 ? 'up' : v < 0 ? 'down' : '';
  return <span className={`gr-delta ${dir}`}>{label} <b>{v > 0 ? '▲ +' : v < 0 ? '▼ ' : ''}{nf.format(v)}</b></span>;
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="tile">
      <span className="small muted">{label}</span>
      <span className="tile-value">{value}</span>
      {sub && <span className="small muted">{sub}</span>}
    </div>
  );
}

function Overview({ data }: { data: GrowthView }) {
  const l = data.latest!;
  const rate = l.reach && l.totalInteractions !== null ? `${((l.totalInteractions / l.reach) * 100).toFixed(1).replace('.', ',')}%` : '—';
  return (
    <div className="gr-top">
      <section className="card" aria-label="Follower">
        <span className="small muted">Follower</span>
        <span className="gr-hero">{nf.format(l.followers)}</span>
        <div className="gr-deltas">
          <Delta label="24 jam" v={data.deltas.d1} />
          <Delta label="7 hari" v={data.deltas.d7} />
          <Delta label="30 hari" v={data.deltas.d30} />
        </div>
      </section>
      <div className="gr-stats">
        <Stat label="Jangkauan" value={num(l.reach)} sub="akun unik, 30 hari terakhir" />
        <Stat label="Interaksi" value={num(l.totalInteractions)} sub={l.likes !== null ? `${num(l.likes)} suka · ${num(l.comments)} komentar · ${num(l.saves)} simpan` : '30 hari terakhir'} />
        <Stat label="Tingkat interaksi" value={rate} sub="interaksi ÷ jangkauan" />
        <Stat label="Kunjungan profil" value={num(l.profileViews)} sub="30 hari terakhir" />
        <Stat label="Postingan" value={num(l.mediaCount ?? data.postStats?.count)} sub={l.following !== null ? `mengikuti ${num(l.following)}` : undefined} />
      </div>
    </div>
  );
}

function Charts({ data }: { data: GrowthView }) {
  const f = data.series.map((p) => ({ t: Date.parse(p.t), v: p.followers }));
  const r = data.series.filter((p) => p.reach !== null).map((p) => ({ t: Date.parse(p.t), v: p.reach! }));
  return (
    <>
      <div className="gr-charts">
        <section className="card" aria-label="Follower dari waktu ke waktu">
          <h2>Follower</h2>
          {f.length > 1 ? <LineChart points={f} label="Follower" /> : <p className="muted small">Butuh minimal dua pengambilan data untuk menggambar grafik.</p>}
        </section>
        <section className="card" aria-label="Jangkauan dari waktu ke waktu">
          <h2>Jangkauan 30 hari <span className="small muted" style={{ fontWeight: 400 }}>(jendela bergulir)</span></h2>
          {r.length > 1 ? <LineChart points={r} label="Jangkauan" /> : <p className="muted small">Butuh minimal dua pengambilan data untuk menggambar grafik.</p>}
        </section>
      </div>
      <details>
        <summary>Lihat data grafik sebagai tabel</summary>
        <div className="table-box" style={{ marginTop: 8, maxHeight: 320, overflowY: 'auto' }}>
          <table>
            <thead><tr><th scope="col">Waktu</th><th scope="col" style={{ textAlign: 'right' }}>Follower</th><th scope="col" style={{ textAlign: 'right' }}>Jangkauan 30 hari</th><th scope="col" style={{ textAlign: 'right' }}>Interaksi 30 hari</th></tr></thead>
            <tbody>
              {[...data.series].reverse().map((p) => (
                <tr key={p.t}>
                  <td className="small">{new Date(p.t).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' })}</td>
                  <td className="mono small" style={{ textAlign: 'right' }}>{num(p.followers)}</td>
                  <td className="mono small" style={{ textAlign: 'right' }}>{num(p.reach)}</td>
                  <td className="mono small" style={{ textAlign: 'right' }}>{num(p.interactions)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </>
  );
}

function Posts({ data }: { data: GrowthView }) {
  const [sort, setSort] = useState<'new' | 'best'>('new');
  const rows: GrowthPost[] = sort === 'new' ? data.posts : [...data.posts].sort((a, b) => b.engagement - a.engagement);
  const max = Math.max(1, ...data.posts.map((p) => p.engagement));
  const s = data.postStats;
  return (
    <section className="card" aria-label="Postingan">
      <div className="row wrap between" style={{ gap: 10 }}>
        <h2>Postingan</h2>
        <div className="seg" role="group" aria-label="Urutan">
          <button type="button" className={sort === 'new' ? 'on' : ''} aria-pressed={sort === 'new'} onClick={() => setSort('new')}>Terbaru</button>
          <button type="button" className={sort === 'best' ? 'on' : ''} aria-pressed={sort === 'best'} onClick={() => setSort('best')}>Terbaik</button>
        </div>
      </div>
      {s && s.system.count > 0 && (
        <p className="small muted" style={{ margin: 0 }}>
          Diterbitkan sistem: <b style={{ color: 'var(--ink)' }}>{s.system.count}</b> post, rata-rata {num(s.system.avgEngagement)} interaksi · Lainnya: <b style={{ color: 'var(--ink)' }}>{s.other.count}</b> post, rata-rata {num(s.other.avgEngagement)} interaksi
        </p>
      )}
      <div className="table-box">
        <table style={{ minWidth: 640 }}>
          <thead>
            <tr>
              <th scope="col" style={{ width: 56 }}><span className="sr-only">Gambar</span></th>
              <th scope="col">Postingan</th>
              <th scope="col" style={{ textAlign: 'right' }}>Suka</th>
              <th scope="col" style={{ textAlign: 'right' }}>Komentar</th>
              <th scope="col">Interaksi</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id}>
                <td>{p.mediaUrl && p.mediaType !== 'VIDEO' ? <img className="gr-thumb" src={p.mediaUrl} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <span className="gr-thumb" aria-hidden="true" />}</td>
                <td>
                  <div className="gr-caption">{p.caption?.trim() || <span className="muted">(tanpa keterangan)</span>}</div>
                  <div className="row small muted" style={{ gap: 8, marginTop: 4 }}>
                    <span>{p.postedAt ? dateFmt.format(new Date(p.postedAt)) : '—'}</span>
                    {p.bySystem && <span className="pill pill-blue">Dari sistem</span>}
                    {p.permalink && <a href={p.permalink} target="_blank" rel="noopener noreferrer">Buka ↗</a>}
                  </div>
                </td>
                <td className="mono small" style={{ textAlign: 'right' }}>{nf.format(p.likes)}</td>
                <td className="mono small" style={{ textAlign: 'right' }}>{nf.format(p.comments)}</td>
                <td>
                  <div className="row" style={{ gap: 8 }}>
                    <div className="gr-bar" role="img" aria-label={`${p.engagement} interaksi`}><span style={{ width: `${(p.engagement / max) * 100}%` }} /></div>
                    <span className="mono small">{nf.format(p.engagement)}</span>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
