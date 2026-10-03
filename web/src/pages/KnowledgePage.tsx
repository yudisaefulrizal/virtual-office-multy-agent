import { useState } from 'react';
import { api, useLive } from '../api';
import { dateTime } from '../format';

const CATEGORIES = ['api', 'pricing', 'policy', 'market', 'trend', 'content', 'technology', 'general'];
const CONFIDENCE: Record<string, string> = { low: 'Rendah', medium: 'Sedang', high: 'Tinggi' };

export function KnowledgePage() {
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const { data, error, refresh } = useLive(() => api.knowledge(query, category), [query, category]);

  const remove = async (id: string, topic: string) => {
    if (!window.confirm(`Hapus knowledge "${topic}"?`)) return;
    await api.deleteKnowledge(id);
    refresh();
  };

  return (
    <main className="page" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <section className="card">
        <h2>Knowledge organisasi</h2>
        <p className="small muted" style={{ margin: 0 }}>
          Hasil riset R&amp;D yang disimpan dan dipakai ulang oleh agent. Keyakinan dihitung dari jumlah sumber; knowledge yang lewat masa
          berlakunya akan diverifikasi ulang saat dibutuhkan.
        </p>
        <form
          className="row wrap"
          onSubmit={(e) => {
            e.preventDefault();
            setQuery(q.trim());
          }}
        >
          <label className="sr-only" htmlFor="kq">Cari knowledge</label>
          <input id="kq" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Cari topik atau isi…" style={{ flex: '1 1 240px', width: 'auto' }} />
          <label className="sr-only" htmlFor="kc">Kategori</label>
          <select id="kc" value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">Semua kategori</option>
            {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <button className="btn btn-ghost" type="submit">Cari</button>
        </form>
      </section>
      {error && <p className="error">{error}</p>}
      {data && data.length === 0 && <p className="muted">Belum ada knowledge{query ? ' yang cocok' : ''}. Knowledge terisi saat Research Agent menyelesaikan riset.</p>}
      {data?.map((k) => (
        <article key={k.id} className="card" style={{ gap: 8 }}>
          <div className="row wrap between">
            <div>
              <div className="eyebrow">{k.category} · keyakinan {CONFIDENCE[k.confidence] ?? k.confidence}</div>
              <h2>{k.topic}</h2>
            </div>
            <div className="row">
              {k.stale ? <span className="chip" style={{ color: 'var(--orange-ink)', borderColor: 'var(--orange)' }}>Perlu verifikasi ulang</span> : <span className="chip">Valid sampai {dateTime(k.recheckAfter)}</span>}
              <button type="button" className="btn btn-ghost" style={{ minHeight: 36, padding: '6px 12px' }} onClick={() => remove(k.id, k.topic)}>Hapus</button>
            </div>
          </div>
          <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{k.content}</p>
          <div className="small muted">
            Diriset {dateTime(k.researchedAt)} · diverifikasi {dateTime(k.lastVerifiedAt)}
            {k.objectiveId && <> · <a href={`#/objectives/${k.objectiveId}`}>objective asal</a></>}
          </div>
          {k.sources.length > 0 && (
            <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
              {k.sources.map((s) => (
                <li key={s}>{/^https?:\/\//.test(s) ? <a href={s} target="_blank" rel="noreferrer">{s}</a> : s}</li>
              ))}
            </ul>
          )}
        </article>
      ))}
    </main>
  );
}
