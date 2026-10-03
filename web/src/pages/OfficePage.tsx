import { lazy, Suspense, useMemo, useRef, useState } from 'react';
import { api, useLive, useNow, type OfficeAgent } from '../api';
import { ACTIVITY, duration } from '../format';
import type { BehaviorEngine } from '../office/behavior';
import { buildBuilding } from '../office/layout';
import { lookFor } from '../office/look';

const OfficeScene = lazy(() => import('../office/Scene').then((m) => ({ default: m.OfficeScene })));

export function OfficePage() {
  const { data, error } = useLive(api.office);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [floorIndex, setFloorIndex] = useState(0);
  const engineRef = useRef<BehaviorEngine | null>(null);

  // Tata letak hanya dihitung ulang saat susunan divisi/staf berubah, bukan tiap status berubah.
  const layoutKey = data ? JSON.stringify([data.departments, data.agents.map((a) => [a.id, a.department, a.roleId, a.isHead])]) : '';
  const building = useMemo(
    () => (data ? buildBuilding(data.departments, data.agents) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [layoutKey],
  );

  const selected = useMemo(() => {
    if (!data) return null;
    return (
      data.agents.find((a) => a.id === selectedId) ??
      data.agents.find((a) => a.activity === 'working') ??
      data.agents[0] ??
      null
    );
  }, [data, selectedId]);

  if (error && !data) return <main className="page"><p className="error">Tidak bisa memuat kantor: {error}</p></main>;
  if (!data || !building) return <main className="page"><p className="muted">Memuat kantor…</p></main>;

  const floor = building.floors[Math.min(floorIndex, building.floors.length - 1)]!;
  const deptColors = new Map(data.departments.map((d) => [d.id, d.color]));

  const working = data.agents.filter((a) => a.activity === 'working').length;

  const counts = {
    working: data.agents.filter((a) => a.activity === 'working').length,
    waiting: data.agents.filter((a) => a.activity === 'waiting' || a.activity === 'blocked').length,
    idle: data.agents.filter((a) => a.activity === 'idle' || a.activity === 'done').length,
  };

  return (
    <main className="office">
      <section className="stage" aria-label="Denah kantor">
        <div className="stage-bar">
          {building.floors.length > 1 ? (
            <div role="tablist" aria-label="Lantai" className="tabs-dark">
              {building.floors.map((f) => (
                <button key={f.index} type="button" role="tab" aria-selected={f.index === floor.index} className={f.index === floor.index ? 'on' : undefined} onClick={() => setFloorIndex(f.index)}>
                  Lantai {f.index + 1}
                </button>
              ))}
            </div>
          ) : (
            <h1 style={{ fontSize: 20, fontWeight: 700, color: '#fff' }}>Kantor</h1>
          )}
          <div className="row wrap" style={{ gap: 8 }}>
            <span className="rt-chip">Semua <b className="mono">{data.agents.length}</b></span>
            <span className="rt-chip"><span className="sq dark-fill-blue" />Bekerja <b className="mono">{counts.working}</b></span>
            <span className="rt-chip"><span className="sq dark-fill-orange" />Antre <b className="mono">{counts.waiting}</b></span>
            <span className="rt-chip"><span className="sq dark-ring-grey" />Santai <b className="mono">{counts.idle}</b></span>
          </div>
        </div>
        <div className="scene-canvas">
          <Suspense fallback={<p style={{ padding: 20 }}>Menyiapkan kantor…</p>}>
            <OfficeScene
              key={floor.index}
              floor={floor}
              agents={data.agents}
              runtimes={data.runtimes}
              events={data.events}
              meeting={data.meeting}
              deptColors={deptColors}
              selectedId={selected?.id ?? null}
              onSelect={setSelectedId}
              engineRef={engineRef}
            />
          </Suspense>
        </div>
      </section>

      <aside className="drawer" aria-label="Detail karyawan">
        {selected && <AgentDetail agent={selected} engineRef={engineRef} departmentName={data.departments.find((d) => d.id === selected.department)?.name} />}
      </aside>
    </main>
  );
}

function AgentDetail({ agent, engineRef, departmentName }: { agent: OfficeAgent; engineRef: React.MutableRefObject<BehaviorEngine | null>; departmentName?: string }) {
  const now = useNow();
  // useNow memicu render ulang tiap detik, jadi kegiatan terkini dari mesin perilaku ikut diperbarui.
  const doing = engineRef.current?.get(agent.id)?.label;
  const look = lookFor(agent.id, agent.department);
  const st = ACTIVITY[agent.activity];
  const [stopping, setStopping] = useState(false);

  const stop = async () => {
    if (!agent.task) return;
    setStopping(true);
    await api.cancelTask(agent.task.id).catch(() => undefined);
    setStopping(false);
  };

  return (
    <section className="agent" aria-labelledby="agent-name">
      <div className="row" style={{ gap: 16 }}>
        <div className="portrait" aria-hidden="true" style={{ background: look.skin, width: 56, height: 56 }}>
          <div style={{ left: 0, top: 0, width: 60, height: 16, background: look.hair }} />
          <div style={{ left: 0, top: 16, width: 8, height: 12, background: look.hair }} />
          <div style={{ left: 52, top: 16, width: 8, height: 12, background: look.hair }} />
          <div style={{ left: 14, top: 28, width: 8, height: 8, background: '#1a1a1a' }} />
          <div style={{ left: 38, top: 28, width: 8, height: 8, background: '#1a1a1a' }} />
          <div style={{ left: 0, top: 48, width: 60, height: 12, background: look.shirt }} />
        </div>
        <div style={{ minWidth: 0 }}>
          <h2 id="agent-name" style={{ fontSize: 20, fontWeight: 700 }}>{agent.name}</h2>
          <div className="small" style={{ color: '#a6aeba' }}>{agent.roleName}{departmentName ? ` · ${departmentName}` : ''}</div>
          <span className="row small" style={{ gap: 8, marginTop: 4 }}>
            <span className={`sq ${st.darkDot}`} />
            <strong>{st.label}</strong>
          </span>
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <span className="label" style={{ color: '#7c8696' }}>Sekarang</span>
        <strong style={{ fontSize: 16 }}>{agent.task?.title ?? doing ?? agent.line}</strong>
        {agent.task?.startedAt && agent.task.status === 'running' && <span className="mono small" style={{ color: '#a6aeba' }}>{duration(now - Date.parse(agent.task.startedAt))}</span>}
      </div>
      <dl>
        <dt>Model</dt>
        <dd className="mono">{agent.model ?? agent.runtime}</dd>
        {agent.isHead && (<><dt>Peran</dt><dd>Kepala divisi</dd></>)}
      </dl>
      {agent.task && (
        <div className="row wrap">
          {agent.task.sessionId && <a className="btn btn-sm" style={{ background: '#fff', color: '#111418' }} href={`/api/sessions/${agent.task.sessionId}/log`} target="_blank" rel="noreferrer">Log</a>}
          <button type="button" className="btn btn-sm" style={{ background: 'transparent', borderColor: '#3b4552' }} onClick={stop} disabled={stopping}>
            {stopping ? 'Menghentikan…' : agent.task.status === 'running' ? 'Hentikan' : 'Batalkan'}
          </button>
        </div>
      )}
    </section>
  );
}
