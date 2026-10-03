import { useState } from 'react';
import { api, type ObjectiveMode, type ScheduleInput } from '../api';

export function NewObjective() {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [mode, setMode] = useState<ObjectiveMode>('planned');
  const [repeat, setRepeat] = useState<'none' | 'daily' | 'interval'>('none');
  const [timeOfDay, setTimeOfDay] = useState('09:00');
  const [intervalHours, setIntervalHours] = useState(24);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const schedule: ScheduleInput | undefined =
        repeat === 'daily' ? { kind: 'daily', timeOfDay } : repeat === 'interval' ? { kind: 'interval', intervalHours } : undefined;
      await api.createObjective(title.trim(), description.trim(), mode, schedule);
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
      <div className="field">
        <label htmlFor="repeat">Ulangi</label>
        <div className="row wrap">
          <select id="repeat" value={repeat} onChange={(e) => setRepeat(e.target.value as typeof repeat)}>
            <option value="none">Sekali saja</option>
            <option value="daily">Setiap hari</option>
            <option value="interval">Setiap beberapa jam</option>
          </select>
          {repeat === 'daily' && (
            <>
              <label className="sr-only" htmlFor="tod">Jam</label>
              <input id="tod" type="time" value={timeOfDay} onChange={(e) => setTimeOfDay(e.target.value)} style={{ width: 130 }} />
              <span className="small muted">WIB</span>
            </>
          )}
          {repeat === 'interval' && (
            <>
              <label className="sr-only" htmlFor="ih">Interval jam</label>
              <input id="ih" type="number" min={1} max={720} value={intervalHours} onChange={(e) => setIntervalHours(Number(e.target.value))} style={{ width: 100 }} />
              <span className="small muted">jam</span>
            </>
          )}
        </div>
        {repeat !== 'none' && <span className="small muted">Run berikutnya memakai ulang rencana kerja yang sama; strategi dan perencanaan tidak diulang.</span>}
      </div>
      {error && <p className="error">{error}</p>}
      <button className="btn" type="submit" disabled={busy || title.trim().length < 3}>
        {busy ? 'Mengirim…' : 'Kirim ke kantor'}
      </button>
    </form>
  );
}
