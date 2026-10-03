import { useState } from 'react';
import { api, type InboxItem } from '../api';

const TITLE: Record<InboxItem['kind'], (i: InboxItem) => string> = {
  approval_pending: (i) => i.title,
  decision_pending: (i) => i.title,
  budget_exceeded: (i) => `Budget habis: ${i.title}`,
  review_escalated: (i) => i.title,
  owner_notice: (i) => i.title,
  task_failed: (i) => `Gagal: ${i.title}`,
  task_unassignable: (i) => `Belum ada agent: ${i.title}`,
};

const hrefOf = (i: InboxItem) => (i.kind === 'decision_pending' ? `#/decisions/${i.taskId}` : i.objectiveId ? `#/objectives/${i.objectiveId}` : undefined);

/** Satu-satunya tempat yang meminta tindakan Owner. Baris ringkas, aksi di kanan. */
export function Inbox({ items, onChanged }: { items: InboxItem[]; onChanged: () => void }) {
  if (items.length === 0) return null;
  return (
    <section className="needs" aria-label="Perlu Anda">
      {items.map((i) =>
        i.kind === 'approval_pending' ? (
          <ApprovalItem key={i.taskId} item={i} onChanged={onChanged} />
        ) : (
          <div key={`${i.kind}-${i.taskId}`} className="needs-row">
            <span className="needs-text">
              <strong>{TITLE[i.kind](i)}</strong>
              {i.detail && <span className="small">{i.detail}</span>}
            </span>
            {hrefOf(i) && <a className="btn btn-sm" href={hrefOf(i)}>Buka</a>}
          </div>
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
    <div className="needs-row">
      <span className="needs-text">
        <strong>{TITLE.approval_pending(item)}</strong>
        <span className="small" style={{ wordBreak: 'break-word' }}>{item.detail}</span>
        {msg && <span className="error">{msg}</span>}
      </span>
      <span className="row">
        <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => act('reject')}>Tolak</button>
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => act('approve')}>Setujui</button>
      </span>
    </div>
  );
}
