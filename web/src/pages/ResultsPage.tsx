import { useEffect, useMemo, useState } from 'react';
import { api, useLive, type ObjectiveResult, type ResultFile, type ResultOutput } from '../api';
import { dateTime } from '../format';
import { Markdown } from '../markdown';

const size = (b: number) => (b < 1024 ? `${b} B` : b < 1024 * 1024 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`);
const ext = (n: string) => n.split('.').pop()?.toLowerCase() ?? '';

type Pick = { file: ResultFile | null; output: ResultOutput; objective: ObjectiveResult };
const pillOf = (o: ObjectiveResult): [string, string] => (o.status === 'completed' ? ['Selesai', 'pill-green'] : ['Berjalan', 'pill-blue']);

export function ResultsPage() {
  const { data, error } = useLive(api.results);
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<{ taskId: string; fileId: string | null } | null>(null);

  const q = query.trim().toLowerCase();
  const rows = useMemo(
    () =>
      (data ?? []).flatMap((objective) =>
        objective.outputs
          .filter((output) => output.final)
          .filter((output) => !q || objective.title.toLowerCase().includes(q) || output.title.toLowerCase().includes(q) || output.files.some((f) => f.name.toLowerCase().includes(q)))
          .map((output) => ({ objective, output })),
      ),
    [data, q],
  );

  const current: Pick | null = useMemo(() => {
    const find = (taskId: string) => {
      for (const objective of data ?? []) {
        const output = objective.outputs.find((x) => x.taskId === taskId);
        if (output) return { objective, output };
      }
      return null;
    };
    if (picked) {
      const hit = find(picked.taskId);
      if (hit) return { ...hit, file: picked.fileId ? (hit.output.files.find((f) => f.id === picked.fileId) ?? null) : (hit.output.files[0] ?? null) };
    }
    const first = rows[0];
    return first ? { ...first, file: first.output.files[0] ?? null } : null;
  }, [picked, data, rows]);

  // Layar sempit: pratinjau ada di bawah daftar, jadi gulir ke sana saat memilih.
  useEffect(() => {
    if (picked && window.matchMedia('(max-width: 900px)').matches) document.querySelector('.results-viewer')?.scrollIntoView({ block: 'start' });
  }, [picked]);

  if (error && !data) return <main className="page"><p className="error">{error}</p></main>;
  if (!data) return <main className="page"><p className="muted">Memuat…</p></main>;

  return (
    <main className="page" style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <header className="row wrap between" style={{ gap: 16 }}>
        <h1 className="page-title">Hasil</h1>
        {rows.length > 0 && <input type="search" aria-label="Cari hasil" placeholder="Cari" value={query} onChange={(e) => setQuery(e.target.value)} style={{ width: 220, minHeight: 40 }} />}
      </header>

      {data.length === 0 ? (
        <p className="muted" style={{ margin: 0 }}>Belum ada hasil.</p>
      ) : rows.length === 0 ? (
        <p className="muted" style={{ margin: 0 }}>Tidak ada yang cocok.</p>
      ) : (
        <div className="results-grid">
          <div className="card list" role="list">
            {rows.map(({ objective, output }) => {
              const on = current?.output.taskId === output.taskId;
              const [label, tone] = pillOf(objective);
              return (
                <button key={output.taskId} type="button" role="listitem" className={`res-row${on ? ' on' : ''}`} onClick={() => setPicked({ taskId: output.taskId, fileId: null })}>
                  <span style={{ minWidth: 0, flex: 1 }}>
                    <strong style={{ display: 'block' }}>{output.title}</strong>
                    <span className="muted small">{objective.title} · {output.completedAt ? dateTime(output.completedAt) : ''}</span>
                  </span>
                  <span className={`pill ${tone}`}>{label}</span>
                </button>
              );
            })}
          </div>
          <Viewer current={current} onPickFile={(taskId, fileId) => setPicked({ taskId, fileId })} />
        </div>
      )}
    </main>
  );
}

function Viewer({ current, onPickFile }: { current: Pick | null; onPickFile: (taskId: string, fileId: string) => void }) {
  if (!current) return <section className="card results-viewer" />;
  const { file, output, objective } = current;
  const supporting = objective.outputs.filter((x) => !x.final && x.files.length > 0);
  return (
    <section className="card results-viewer" style={{ padding: 32, gap: 24 }}>
      <div className="row wrap between" style={{ alignItems: 'flex-start', gap: 16 }}>
        <div style={{ minWidth: 0 }}>
          <h2 style={{ fontSize: 25, lineHeight: 1.2, fontWeight: 700, letterSpacing: '-0.015em', wordBreak: 'break-word' }}>{output.title}</h2>
          <span className="muted">{output.agentName ?? objective.title}</span>
        </div>
        <span className="row">
          {file && <a className="btn btn-ghost" href={`/api/artifacts/${file.id}/download`} download>Unduh</a>}
          {objective.fileCount > 0 && <a className="btn btn-ghost" href={`/api/objectives/${objective.id}/download`} download>ZIP</a>}
        </span>
      </div>
      {output.files.length > 1 && (
        <div className="row wrap" style={{ gap: 8 }}>
          {output.files.map((f) => (
            <button key={f.id} type="button" className={`fchip${file?.id === f.id ? ' on' : ''}`} onClick={() => onPickFile(output.taskId, f.id)}>{f.name} <span className="muted">{size(f.bytes)}</span></button>
          ))}
        </div>
      )}
      {file ? <FileView key={file.id} file={file} /> : <OutputSummary output={output} />}
      {supporting.length > 0 && (
        <details>
          <summary className="muted small" style={{ cursor: 'pointer', fontWeight: 600 }}>Bahan pendukung ({supporting.length})</summary>
          <div className="row wrap" style={{ gap: 8, marginTop: 12 }}>
            {supporting.flatMap((x) => x.files.map((f) => (
              <button key={f.id} type="button" className="fchip" onClick={() => onPickFile(x.taskId, f.id)}>{x.title}: {f.name}</button>
            )))}
          </div>
        </details>
      )}
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
