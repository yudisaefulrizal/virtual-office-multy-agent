import { useState } from 'react';
import { api, type InboxItem } from '../api';

const TITLE: Record<InboxItem['kind'], (i: InboxItem) => string> = {
  approval_pending: (i) => `Butuh persetujuan: ${i.title}`,
  decision_pending: (i) => `Keputusan CEO menunggu: ${i.title}`,
  budget_exceeded: (i) => `Budget habis: ${i.title}`,
  review_escalated: (i) => `Perlu keputusan Anda: ${i.title}`,
  owner_notice: (i) => i.title,
  task_failed: (i) => `Task gagal: ${i.title}`,
  task_unassignable: (i) => `Belum ada agent: ${i.title}`,
};

const hrefOf = (i: InboxItem) => (i.kind === 'decision_pending' ? `#/decisions/${i.taskId}` : i.objectiveId ? `#/objectives/${i.objectiveId}` : undefined);

export function Inbox({ items, onChanged }: { items: InboxItem[]; onChanged: () => void }) {
  if (items.length === 0) return null;
  return (
    <section className="card" aria-labelledby="inbox">
      <h2 id="inbox" className="row" style={{ gap: 8 }}>
        Perlu Anda <span className="badge">{items.length}</span>
      </h2>
      {items.map((i) =>
        i.kind === 'approval_pending' ? (
          <ApprovalItem key={i.taskId} item={i} onChanged={onChanged} />
        ) : (
          <a key={`${i.kind}-${i.taskId}`} href={hrefOf(i)} className="notice" style={{ color: 'var(--ink)', textDecoration: 'none', display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontWeight: 600 }}>{TITLE[i.kind](i)}</span>
            <span className="small muted">{i.detail}</span>
          </a>
        ),
      )}
    </section>
  );
}

function ApprovalItem({ item, onChanged }: { item: InboxItem; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const act = async (action: 'approve' | 'reject') => {
    setBusy(true);
    try {
      const r = await api.decideApproval(item.taskId, action);
      if (action === 'approve' && r.ok === false) setMsg(r.message ?? 'Gagal dijalankan');
      onChanged();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="notice" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <span style={{ fontWeight: 600 }}>{TITLE.approval_pending(item)}</span>
      <code className="small" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{item.detail}</code>
      {msg && <span className="error">{msg}</span>}
      <div className="row wrap">
        <button type="button" className="btn" disabled={busy} onClick={() => act('approve')}>Setujui &amp; jalankan</button>
        <button type="button" className="btn btn-danger" disabled={busy} onClick={() => act('reject')}>Tolak</button>
      </div>
    </div>
  );
}
