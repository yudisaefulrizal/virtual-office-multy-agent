import { useState } from 'react';
import { api, type ObjectiveMode } from '../api';

export function NewObjective() {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [mode, setMode] = useState<ObjectiveMode>('planned');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.createObjective(title.trim(), description.trim(), mode);
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
      <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Cara kerja</legend>
        <label className="choice">
          <input type="radio" name="mode" checked={mode === 'strategic'} onChange={() => setMode('strategic')} />
          <span>
            <strong>Strategis</strong>
            <span className="small muted">CEO menyusun visi, konsultasi tim eksekutif, lalu mengusulkan keputusan untuk Anda setujui. ±7–10 run (lebih hemat bila eksekutif di OpenRouter).</span>
          </span>
        </label>
        <label className="choice">
          <input type="radio" name="mode" checked={mode === 'planned'} onChange={() => setMode('planned')} />
          <span>
            <strong>Terencana</strong>
            <span className="small muted">Manager menyusun rencana, tim mengerjakan, Manager mereview. ±4 run.</span>
          </span>
        </label>
        <label className="choice">
          <input type="radio" name="mode" checked={mode === 'direct'} onChange={() => setMode('direct')} />
          <span>
            <strong>Cepat</strong>
            <span className="small muted">Langsung dikerjakan Content Writer. 1 run, tanpa review.</span>
          </span>
        </label>
      </fieldset>
      {error && <p className="error">{error}</p>}
      <button className="btn" type="submit" disabled={busy || title.trim().length < 3}>
        {busy ? 'Mengirim…' : 'Kirim ke kantor'}
      </button>
    </form>
  );
}
