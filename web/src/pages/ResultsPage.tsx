import { useEffect, useMemo, useState } from 'react';
import { api, useLive, type ObjectiveResult, type ResultFile, type ResultOutput } from '../api';
import { TASK_STATUS, dateTime } from '../format';
import { Markdown } from '../markdown';

const KIND: Record<string, string> = { work: 'Pekerjaan', research: 'Riset' };
const size = (b: number) => (b < 1024 ? `${b} B` : b < 1024 * 1024 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`);
const ext = (n: string) => n.split('.').pop()?.toLowerCase() ?? '';

type Pick = { file: ResultFile; output: ResultOutput; objective: ObjectiveResult } | { file: null; output: ResultOutput; objective: ObjectiveResult };

export function ResultsPage() {
  const { data, error } = useLive(api.results);
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<{ objectiveId: string; taskId: string; fileId: string | null } | null>(null);

  // Di layar sempit pratinjau ada di bawah daftar: gulir ke sana saat Owner memilih sesuatu.
  useEffect(() => {
    if (picked && window.matchMedia('(max-width: 900px)').matches) document.querySelector('.results-viewer')?.scrollIntoView({ block: 'start' });
  }, [picked]);

  const q = query.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      (data ?? [])
        .map((o) => ({
          ...o,
          outputs: o.outputs.filter(
            (x) => !q || o.title.toLowerCase().includes(q) || x.title.toLowerCase().includes(q) || x.files.some((f) => f.name.toLowerCase().includes(q)),
          ),
        }))
        .filter((o) => o.outputs.length > 0),
    [data, q],
  );

  // Pilihan otomatis: file pertama dari hasil terbaru, sampai Owner memilih sendiri.
  const current: Pick | null = useMemo(() => {
    const lookup = (sel: NonNullable<typeof picked>): Pick | null => {
      const objective = (data ?? []).find((o) => o.id === sel.objectiveId);
      const output = objective?.outputs.find((x) => x.taskId === sel.taskId);
      if (!objective || !output) return null;
      const file = sel.fileId ? output.files.find((f) => f.id === sel.fileId) : null;
      return sel.fileId && !file ? null : ({ file: file ?? null, output, objective } as Pick);
    };
    if (picked) return lookup(picked);
    const o = filtered[0];
    const out = o?.outputs.find((x) => x.files.length > 0) ?? o?.outputs[0];
    return o && out ? { file: out.files[0] ?? null, output: out, objective: o } : null;
  }, [picked, data, filtered]);

  if (error && !data) return <main className="page"><p className="error">{error}</p></main>;
  if (!data) return <main className="page"><p className="muted">Memuat…</p></main>;

  return (
    <main className="page" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="row wrap between">
        <h1 style={{ fontSize: 24, fontWeight: 600 }}>Hasil kerja</h1>
        <input
          type="search"
          aria-label="Cari hasil"
          placeholder="Cari objective, task, atau nama file"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ minHeight: 44, minWidth: 260, padding: '8px 12px', border: '1px solid var(--grey)', font: 'inherit' }}
        />
      </div>

      {data.length === 0 ? (
        <section className="card">
          <p className="muted">Belum ada hasil. File dan ringkasan muncul di sini begitu ada task pekerjaan atau riset yang selesai.</p>
        </section>
      ) : filtered.length === 0 ? (
        <p className="muted">Tidak ada hasil yang cocok dengan “{query}”.</p>
      ) : (
        <div className="results-grid">
          <div className="results-list">
            {filtered.map((o) => (
              <ObjectiveCard key={o.id} objective={o} current={current} onPick={(output, file) => setPicked({ objectiveId: o.id, taskId: output.taskId, fileId: file?.id ?? null })} />
            ))}
          </div>
          <Viewer current={current} />
        </div>
      )}
    </main>
  );
}

function ObjectiveCard({ objective: o, current, onPick }: { objective: ObjectiveResult; current: Pick | null; onPick: (o: ResultOutput, f: ResultFile | null) => void }) {
  const st = TASK_STATUS[o.status] ?? TASK_STATUS.new!;
  return (
    <section className="card" style={{ gap: 10 }}>
      <div className="row between" style={{ alignItems: 'flex-start' }}>
        <div style={{ minWidth: 0 }}>
          <a href={`#/objectives/${o.id}`} style={{ fontWeight: 600 }}>{o.title}</a>
          <div className="row small muted" style={{ gap: 6, marginTop: 2, flexWrap: 'wrap' }}>
            <span className={`dot ${st.dot}`} />
            <span style={{ color: st.tone, fontWeight: 500 }}>{st.label}</span>
            <span>· {o.fileCount} file · {size(o.totalBytes)}</span>
            {o.updatedAt && <span>· {dateTime(o.updatedAt)}</span>}
          </div>
        </div>
        {o.fileCount > 0 && (
          <a className="btn btn-ghost" style={{ minHeight: 36, padding: '6px 12px', flex: 'none' }} href={`/api/objectives/${o.id}/download`} download>
            Unduh ZIP
          </a>
        )}
      </div>
      {o.outputs.map((out) => (
        <div key={out.taskId} style={{ borderTop: '1px solid var(--line-soft)', paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <button
            type="button"
            className="pick"
            aria-current={current?.output.taskId === out.taskId && !current.file ? 'true' : undefined}
            onClick={() => onPick(out, null)}
          >
            <span style={{ fontWeight: 500 }}>{out.title}</span>
            <span className="small muted">{KIND[out.kind] ?? out.kind}{out.agentName ? ` · ${out.agentName}` : ''}</span>
          </button>
          {out.files.map((f) => (
            <div key={f.id} className="row" style={{ gap: 4 }}>
              <button type="button" className="pick file" style={{ flex: 1 }} aria-current={current?.file?.id === f.id ? 'true' : undefined} onClick={() => onPick(out, f)}>
                {f.name} <span className="muted">· {size(f.bytes)}</span>
              </button>
              <a className="small" href={`/api/artifacts/${f.id}/download`} download aria-label={`Unduh ${f.name}`}>Unduh</a>
            </div>
          ))}
        </div>
      ))}
    </section>
  );
}

function Viewer({ current }: { current: Pick | null }) {
  if (!current) return <section className="card"><p className="muted">Pilih file atau task untuk dilihat.</p></section>;
  const { file, output, objective } = current;
  return (
    <section className="card results-viewer" style={{ gap: 12 }}>
      <div className="row wrap between">
        <div style={{ minWidth: 0 }}>
          <div className="small muted">{objective.title} › {output.title}</div>
          <h2 style={{ wordBreak: 'break-word' }}>{file ? file.name : output.title}</h2>
        </div>
        {file && (
          <span className="row">
            <a className="btn btn-ghost" style={{ minHeight: 36, padding: '6px 12px' }} href={`/api/artifacts/${file.id}/content`} target="_blank" rel="noreferrer">Buka</a>
            <a className="btn" style={{ minHeight: 36, padding: '6px 12px' }} href={`/api/artifacts/${file.id}/download`} download>Unduh</a>
          </span>
        )}
      </div>
      {file ? <FileView key={file.id} file={file} /> : <OutputSummary output={output} />}
    </section>
  );
}

function OutputSummary({ output }: { output: ResultOutput }) {
  return output.summary ? <Markdown source={output.summary} /> : <p className="muted">Task ini tidak mencatat ringkasan.</p>;
}

function FileView({ file }: { file: ResultFile }) {
  const e = ext(file.name);
  const mime = file.mimeType ?? '';
  const isImage = /^image\//.test(mime) && !/svg/.test(mime);
  const textual = !isImage && (!mime || /^text\/|json|svg/.test(mime));
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [raw, setRaw] = useState(false);

  useEffect(() => {
    if (!textual) return;
    let alive = true;
    fetch(`/api/artifacts/${file.id}/content`)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(r.status === 410 ? 'File sudah tidak ada di disk' : `HTTP ${r.status}`))))
      .then((t) => alive && setText(t))
      .catch((err: Error) => alive && setFailed(err.message));
    return () => {
      alive = false;
    };
  }, [file.id, textual]);

  if (isImage) return <img src={`/api/artifacts/${file.id}/content`} alt={file.name} style={{ maxWidth: '100%', alignSelf: 'flex-start', border: '1px solid var(--line)' }} />;
  if (!textual) return <p className="muted">Pratinjau tidak tersedia untuk tipe ini ({mime || e || 'tidak dikenal'}). Gunakan Unduh.</p>;
  if (failed) return <p className="error">Tidak bisa memuat: {failed}</p>;
  if (text === null) return <p className="muted">Memuat…</p>;

  const isMd = e === 'md' || e === 'markdown' || /markdown/.test(mime);
  const isHtml = e === 'html' || e === 'htm' || mime === 'text/html';
  const isSvg = e === 'svg' || /svg/.test(mime);

  if (isSvg) return <img src={`data:image/svg+xml;utf8,${encodeURIComponent(text)}`} alt={file.name} style={{ maxWidth: '100%', alignSelf: 'flex-start', border: '1px solid var(--line)', background: '#fff' }} />;
  if (isHtml || isMd) {
    return (
      <>
        <div className="row small">
          <button type="button" className="btn btn-ghost" style={{ minHeight: 32, padding: '4px 10px' }} aria-pressed={raw} onClick={() => setRaw(!raw)}>
            {raw ? 'Tampilan' : 'Teks mentah'}
          </button>
          {isHtml && !raw && <span className="muted">Skrip dimatikan di pratinjau ini.</span>}
        </div>
        {raw ? <pre className="artifact" style={{ maxHeight: 'none' }}>{text}</pre> : isHtml ? <iframe title={file.name} sandbox="" srcDoc={text} className="html-preview" /> : <Markdown source={text} />}
      </>
    );
  }
  if (e === 'csv') return <CsvTable text={text} />;
  return <pre className="artifact" style={{ maxHeight: 'none' }}>{e === 'json' ? prettyJson(text) : text}</pre>;
}

function prettyJson(t: string) {
  try {
    return JSON.stringify(JSON.parse(t), null, 2);
  } catch {
    return t;
  }
}

function CsvTable({ text }: { text: string }) {
  const rows = text.trim().split(/\r?\n/).map((l) => l.split(',').map((c) => c.trim().replace(/^"|"$/g, '')));
  const [head, ...body] = rows;
  if (!head) return <p className="muted">File kosong.</p>;
  return (
    <div className="table-box">
      <table>
        <thead><tr>{head.map((c, i) => <th key={i} scope="col">{c}</th>)}</tr></thead>
        <tbody>{body.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}
