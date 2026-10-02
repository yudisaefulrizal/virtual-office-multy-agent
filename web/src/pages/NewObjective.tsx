import { useState } from 'react';
import { api } from '../api';

export function NewObjective() {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.createObjective(title.trim(), description.trim());
      setTitle('');
      setDescription('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card" onSubmit={submit} aria-labelledby="new-obj">
      <h2 id="new-obj">Beri objective</h2>
      <div className="field">
        <label htmlFor="obj-title">Objective</label>
        <input
          id="obj-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Mis. Buat satu caption Instagram tentang kopi lokal"
          required
          minLength={3}
        />
      </div>
      <div className="field">
        <label htmlFor="obj-desc">Detail (opsional)</label>
        <textarea
          id="obj-desc"
          rows={3}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Target, audiens, gaya bahasa, batasan…"
        />
      </div>
      {error && <p className="error">{error}</p>}
      <button className="btn" type="submit" disabled={busy || title.trim().length < 3}>
        {busy ? 'Mengirim…' : 'Kirim ke kantor'}
      </button>
      <p className="small muted" style={{ margin: 0 }}>
        Slice 1: objective langsung dikerjakan Content Writer. Strategi CEO dan tim eksekutif menyusul.
      </p>
    </form>
  );
}
