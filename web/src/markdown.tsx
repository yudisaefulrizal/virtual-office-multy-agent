import type { ReactNode } from 'react';

/**
 * Renderer Markdown kecil untuk menampilkan hasil kerja agent: heading, paragraf, daftar,
 * kutipan, blok kode, tabel, garis, serta tebal/miring/kode/tautan. Semua keluaran berupa
 * elemen React (tanpa innerHTML); tautan hanya http(s) dan mailto.
 */
function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*|__[^_]+__)|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)|(\[[^\]]+\]\([^)\s]+\))|(https?:\/\/[^\s<>)]+)/g;
  let last = 0;
  let n = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const key = `${keyBase}-${n++}`;
    if (m[1]) out.push(<code key={key}>{tok.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={key}>{inline(tok.slice(2, -2), key)}</strong>);
    else if (m[3]) out.push(<em key={key}>{inline(tok.slice(1, -1), key)}</em>);
    else if (m[4]) {
      const [, label, href] = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok)!;
      out.push(
        /^(https?:|mailto:)/i.test(href!) ? (
          <a key={key} href={href} target="_blank" rel="noreferrer noopener">{label}</a>
        ) : (
          <span key={key}>{label}</span>
        ),
      );
    } else out.push(<a key={key} href={tok} target="_blank" rel="noreferrer noopener">{tok}</a>);
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const isTableSep = (l: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
const cells = (l: string) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

export function Markdown({ source }: { source: string }) {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  const key = () => `b${blocks.length}`;

  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = /^\s*(```|~~~)/.exec(line);
    if (fence) {
      const buf: string[] = [];
      for (i++; i < lines.length && !lines[i]!.trim().startsWith(fence[1]!); i++) buf.push(lines[i]!);
      i++;
      blocks.push(<pre key={key()} className="md-code">{buf.join('\n')}</pre>);
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1]!.length;
      const Tag = `h${level}` as 'h1';
      blocks.push(<Tag key={key()}>{inline(h[2]!, key())}</Tag>);
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push(<hr key={key()} />);
      i++;
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1]!)) {
      const head = cells(line);
      const rows: string[][] = [];
      for (i += 2; i < lines.length && lines[i]!.includes('|') && lines[i]!.trim(); i++) rows.push(cells(lines[i]!));
      const k = key();
      blocks.push(
        <div key={k} className="table-box">
          <table>
            <thead>
              <tr>{head.map((c, j) => <th key={j} scope="col">{inline(c, `${k}h${j}`)}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>{r.map((c, j) => <td key={j}>{inline(c, `${k}r${ri}c${j}`)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (/^\s*>/.test(line)) {
      const buf: string[] = [];
      for (; i < lines.length && /^\s*>/.test(lines[i]!); i++) buf.push(lines[i]!.replace(/^\s*>\s?/, ''));
      blocks.push(<blockquote key={key()}>{inline(buf.join(' '), key())}</blockquote>);
      continue;
    }
    const li = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) {
      const ordered = /\d/.test(li[2]!);
      const items: { depth: number; text: string }[] = [];
      for (; i < lines.length; i++) {
        const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]!);
        if (m) items.push({ depth: Math.min(2, Math.floor(m[1]!.length / 2)), text: m[3]! });
        else if (/^\s{2,}\S/.test(lines[i]!) && items.length) items[items.length - 1]!.text += ` ${lines[i]!.trim()}`;
        else break;
      }
      const k = key();
      const Tag = ordered ? 'ol' : 'ul';
      blocks.push(
        <Tag key={k}>
          {items.map((it, j) => (
            <li key={j} style={{ marginLeft: it.depth * 18 }}>{inline(it.text, `${k}-${j}`)}</li>
          ))}
        </Tag>,
      );
      continue;
    }
    const buf: string[] = [];
    for (; i < lines.length && lines[i]!.trim() && !/^\s*(```|~~~|#{1,6}\s|>|[-*+]\s|\d+[.)]\s)/.test(lines[i]!); i++) buf.push(lines[i]!.trim());
    if (buf.length === 0) {
      buf.push(line.trim());
      i++;
    }
    blocks.push(<p key={key()}>{inline(buf.join(' '), key())}</p>);
  }
  return <div className="md">{blocks}</div>;
}
