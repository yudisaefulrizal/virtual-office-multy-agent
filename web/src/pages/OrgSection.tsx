import { useState } from 'react';
import { api, useLive, type Org, type OrgChange, type Settings } from '../api';

/** Susunan organisasi: divisi (ruangan), role, staf, dan aturan HRD menambah staf. */
export function OrgSection() {
  const org = useLive(api.org);
  const settings = useLive(api.settings);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const apply = async (body: OrgChange) => {
    setBusy(true);
    setError(null);
    try {
      await api.applyOrg(body);
      org.refresh();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const data = org.data;
  return (
    <section className="card" aria-labelledby="org">
      <h2 id="org">Organisasi</h2>
      {error && <p className="error">{error}</p>}
      {data?.departments.map((d) => (
        <div key={d.id} style={{ border: '1px solid var(--line)', borderRadius: 12, padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div className="row between wrap">
            <span className="row" style={{ gap: 8 }}>
              <span aria-hidden="true" style={{ width: 14, height: 14, background: d.color, border: '1px solid var(--ink)' }} />
              <strong>{d.name}</strong>
              <span className="small muted">{d.staff} staf aktif</span>
            </span>
            <span className="small muted">{d.createdBy === 'system' ? 'Bawaan' : `Dibuat ${d.createdBy}`}</span>
          </div>
          {d.roles.length === 0 && <span className="small muted">Belum ada role.</span>}
          {d.roles.map((r) => (
            <div key={r.id} className="row between wrap small">
              <span>
                <strong>{r.name}</strong> <span className="mono muted">{r.id}</span>
                {r.plannable && <span className="muted"> · bisa dipakai Manager ({r.taskKind})</span>}
                <span className="muted"> · file: {r.nativeTools}</span>
              </span>
              <span className="row">
                <span className="mono">{r.staff} staf</span>
                <button type="button" className="btn btn-ghost" style={{ minHeight: 32, padding: '4px 10px', fontSize: 12 }} disabled={busy} onClick={() => apply({ type: 'hire', role_id: r.id, reason: 'Ditambah Owner' })}>
                  + Rekrut
                </button>
              </span>
            </div>
          ))}
        </div>
      ))}
      {data && <AddDepartment busy={busy} onSubmit={apply} />}
      {data && <AddRole org={data} busy={busy} onSubmit={apply} />}
      {settings.data && <HiringRules limits={settings.data} onSaved={() => (settings.refresh(), org.refresh())} />}
    </section>
  );
}

function AddDepartment({ busy, onSubmit }: { busy: boolean; onSubmit: (b: OrgChange) => Promise<boolean> }) {
  const [name, setName] = useState('');
  return (
    <form
      className="row wrap"
      onSubmit={async (e) => {
        e.preventDefault();
        if (await onSubmit({ type: 'new_department', name: name.trim(), reason: 'Dibuat Owner' })) setName('');
      }}
    >
      <label htmlFor="dept-name" className="small" style={{ flexBasis: '100%' }}>Divisi baru (ruangan baru di kantor)</label>
      <input id="dept-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Mis. Desain Visual" style={{ flex: '1 1 220px', width: 'auto' }} minLength={3} />
      <button type="submit" className="btn btn-ghost" disabled={busy || name.trim().length < 3}>Tambah divisi</button>
    </form>
  );
}

function AddRole({ org, busy, onSubmit }: { org: Org; busy: boolean; onSubmit: (b: OrgChange) => Promise<boolean> }) {
  const [name, setName] = useState('');
  const [dept, setDept] = useState('');
  const [instructions, setInstructions] = useState('');
  const [tools, setTools] = useState<'read_only' | 'workspace_write' | 'research'>('workspace_write');
  const [plannable, setPlannable] = useState(true);
  const [description, setDescription] = useState('');
  const department = dept || org.departments[0]?.id || '';
  const valid = name.trim().length >= 3 && instructions.trim().length >= 20 && department && (!plannable || description.trim().length >= 5);

  return (
    <form
      className="field"
      style={{ borderTop: '1px solid var(--line-soft)', paddingTop: 12 }}
      onSubmit={async (e) => {
        e.preventDefault();
        const ok = await onSubmit({
          type: 'new_role', name: name.trim(), department_id: department, instructions: instructions.trim(), native_tools: tools,
          ...(plannable ? { task_kind: tools === 'research' ? 'research' : 'work', description: description.trim() } : {}), reason: 'Dibuat Owner',
        });
        if (ok) (setName(''), setInstructions(''), setDescription(''));
      }}
    >
      <strong className="small">Role baru (otomatis merekrut satu staf)</strong>
      <div className="row wrap">
        <label className="sr-only" htmlFor="role-name">Nama role</label>
        <input id="role-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Nama role, mis. Visual Designer" style={{ flex: '1 1 200px', width: 'auto' }} />
        <label className="sr-only" htmlFor="role-dept">Divisi</label>
        <select id="role-dept" value={department} onChange={(e) => setDept(e.target.value)}>
          {org.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        <label className="sr-only" htmlFor="role-tools">Akses file</label>
        <select id="role-tools" value={tools} onChange={(e) => setTools(e.target.value as typeof tools)}>
          <option value="read_only">Hanya baca</option>
          <option value="workspace_write">Baca &amp; tulis file</option>
          <option value="research">+ riset web</option>
        </select>
      </div>
      <label className="sr-only" htmlFor="role-ins">Instruksi role</label>
      <textarea id="role-ins" rows={3} value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="Instruksi kerja (minimal 20 karakter): tugas, gaya, batasan." />
      <label className="row small" style={{ fontWeight: 400 }}>
        <input type="checkbox" style={{ width: 'auto' }} checked={plannable} onChange={(e) => setPlannable(e.target.checked)} />
        Manager boleh memakai role ini dalam rencana kerja
      </label>
      {plannable && (
        <>
          <label className="sr-only" htmlFor="role-desc">Kemampuan role</label>
          <input id="role-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Satu kalimat kemampuan, mis. membuat brief visual" />
        </>
      )}
      <span className="small muted">Role baru hanya mendapat tool berisiko rendah (cari knowledge, kabari Owner).</span>
      <button type="submit" className="btn btn-ghost" style={{ alignSelf: 'flex-start' }} disabled={busy || !valid}>Buat role</button>
    </form>
  );
}

function HiringRules({ limits, onSaved }: { limits: Settings; onSaved: () => void }) {
  const [max, setMax] = useState(limits.max_staff_per_role);
  const [wait, setWait] = useState(limits.hire_wait_seconds);
  const [mode, setMode] = useState(limits.auto_hire);
  const [idle, setIdle] = useState(limits.suspend_idle_minutes);
  const [busy, setBusy] = useState(false);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    await api.updateSettings({ max_staff_per_role: max, hire_wait_seconds: wait, auto_hire: mode, suspend_idle_minutes: idle }).catch(() => undefined);
    setBusy(false);
    onSaved();
  };
  return (
    <form className="field" onSubmit={save} style={{ borderTop: '1px solid var(--line-soft)', paddingTop: 12 }}>
      <strong className="small">Aturan HRD menambah staf</strong>
      <div className="row wrap">
        <label htmlFor="hr-mode" className="small">Penambahan</label>
        <select id="hr-mode" value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
          <option value="auto">Otomatis di bawah batas</option>
          <option value="ask">Selalu minta persetujuan saya</option>
        </select>
        <label htmlFor="hr-max" className="small">Batas staf per role</label>
        <input id="hr-max" type="number" min={1} max={20} value={max} onChange={(e) => setMax(Number(e.target.value))} style={{ width: 80 }} />
        <label htmlFor="hr-wait" className="small">Menunggu lebih dari (detik)</label>
        <input id="hr-wait" type="number" min={10} max={3600} value={wait} onChange={(e) => setWait(Number(e.target.value))} style={{ width: 100 }} />
        <label htmlFor="hr-idle" className="small">Rumahkan staf tambahan setelah menganggur (menit, 0 = tidak otomatis)</label>
        <input id="hr-idle" type="number" min={0} max={1440} value={idle} onChange={(e) => setIdle(Number(e.target.value))} style={{ width: 90 }} />
        <button type="submit" className="btn btn-ghost" disabled={busy}>Simpan aturan</button>
      </div>
    </form>
  );
}
