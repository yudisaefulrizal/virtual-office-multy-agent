import { lazy, Suspense, useMemo, useRef, useState } from 'react';
import { api, useLive, useNow, type OfficeAgent, type OfficeView } from '../api';
import { ACTIVITY, duration } from '../format';
import type { BehaviorEngine } from '../office/behavior';
import { buildBuilding } from '../office/layout';
import { lookFor } from '../office/look';

const OfficeScene = lazy(() => import('../office/Scene').then((m) => ({ default: m.OfficeScene })));

/** Kantor penuh: panggung 3D memenuhi layar. */
export function OfficePage() {
  const { data, error } = useLive(api.office);
  if (error && !data) return <main className="page"><p className="error">Tidak bisa memuat kantor: {error}</p></main>;
  if (!data) return <main className="page"><p className="muted">Memuat kantor…</p></main>;
  return (
    <main className="office">
      <OfficeStage data={data} />
    </main>
  );
}

/**
 * Panggung kantor 3D dengan kontrol mengambang (lantai, hitungan status, kartu karyawan terpilih).
 * Dipakai di beranda (ringkas) dan di halaman Kantor (penuh).
 */
export function OfficeStage({ data, expand, showAgent = true }: { data: OfficeView; expand?: boolean; showAgent?: boolean }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [floorIndex, setFloorIndex] = useState(0);
  const engineRef = useRef<BehaviorEngine | null>(null);

  // Tata letak hanya dihitung ulang saat susunan divisi/staf berubah, bukan tiap status berubah.
  const layoutKey = JSON.stringify([data.departments, data.agents.map((a) => [a.id, a.department, a.roleId, a.isHead])]);
  const building = useMemo(
    () => buildBuilding(data.departments, data.agents),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [layoutKey],
  );
  const selected = data.agents.find((a) => a.id === selectedId) ?? null;
  const floor = building.floors[Math.min(floorIndex, building.floors.length - 1)]!;
  const deptColors = new Map(data.departments.map((d) => [d.id, d.color]));
  const counts = {
    working: data.agents.filter((a) => a.activity === 'working').length,
    waiting: data.agents.filter((a) => a.activity === 'waiting' || a.activity === 'blocked').length,
    idle: data.agents.filter((a) => a.activity === 'idle' || a.activity === 'done').length,
  };

  return (
    <section className="stage" aria-label="Kantor 3D">
      <div className="scene-canvas">
        <Suspense fallback={<p style={{ padding: 20 }} className="muted">Menyiapkan kantor…</p>}>
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
      <div className="stage-top">
        {building.floors.length > 1 ? (
          <div role="tablist" aria-label="Lantai" className="glass tabs-dark">
            {building.floors.map((f) => (
              <button key={f.index} type="button" role="tab" aria-selected={f.index === floor.index} className={f.index === floor.index ? 'on' : undefined} onClick={() => setFloorIndex(f.index)}>
                Lantai {f.index + 1}
              </button>
            ))}
          </div>
        ) : (
          <span />
        )}
        <div className="glass counts" aria-label="Status karyawan">
          <span><b>{data.agents.length}</b> staf</span>
          <span><i className="sq dark-fill-blue" />Bekerja <b>{counts.working}</b></span>
          <span><i className="sq dark-fill-orange" />Antre <b>{counts.waiting}</b></span>
          <span><i className="sq dark-ring-grey" />Santai <b>{counts.idle}</b></span>
        </div>
      </div>
      {showAgent && selected && (
        <div className="stage-agent glass">
          <AgentCard agent={selected} engineRef={engineRef} departmentName={data.departments.find((d) => d.id === selected.department)?.name} onClose={() => setSelectedId(null)} />
        </div>
      )}
      {expand && (
        <a className="stage-expand glass btn btn-sm btn-ghost" href="#/office" aria-label="Buka kantor layar penuh">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M8 1h5v5M6 13H1V8M13 1L8 6M1 13l5-5" /></svg>
          Layar penuh
        </a>
      )}
    </section>
  );
}

function AgentCard({ agent, engineRef, departmentName, onClose }: { agent: OfficeAgent; engineRef: React.MutableRefObject<BehaviorEngine | null>; departmentName?: string; onClose: () => void }) {
  const now = useNow();
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
      <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
        <div className="portrait" aria-hidden="true" style={{ background: look.skin }}>
          <div style={{ left: 0, top: 0, width: 48, height: 13, background: look.hair }} />
          <div style={{ left: 0, top: 13, width: 6, height: 10, background: look.hair }} />
          <div style={{ left: 42, top: 13, width: 6, height: 10, background: look.hair }} />
          <div style={{ left: 11, top: 22, width: 6, height: 6, background: '#1a1a1a' }} />
          <div style={{ left: 31, top: 22, width: 6, height: 6, background: '#1a1a1a' }} />
          <div style={{ left: 0, top: 38, width: 48, height: 10, background: look.shirt }} />
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <h2 id="agent-name" style={{ fontSize: 16, fontWeight: 700 }}>{agent.name}</h2>
          <div className="small muted">{agent.roleName}{departmentName ? ` · ${departmentName}` : ''}{agent.isHead ? ' · Kepala' : ''}</div>
        </div>
        <button type="button" className="btn btn-ghost btn-sm" style={{ minHeight: 28, padding: '0 8px', border: 0 }} onClick={onClose} aria-label="Tutup">
          <svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M2 2l8 8M10 2l-8 8" /></svg>
        </button>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span className="row small" style={{ gap: 8, fontWeight: 700 }}>
          <span className={`sq ${st.darkDot}`} />
          {st.label}
          {agent.task?.startedAt && agent.task.status === 'running' && <span className="mono muted" style={{ fontWeight: 400 }}>{duration(now - Date.parse(agent.task.startedAt))}</span>}
        </span>
        <strong style={{ fontSize: 14 }}>{agent.task?.title ?? doing ?? agent.line}</strong>
      </div>
      <div className="row wrap between">
        <span className="mono small muted">{agent.model ?? agent.runtime}</span>
        {agent.task && (
          <span className="row">
            {agent.task.sessionId && <a className="btn btn-sm btn-ghost" href={`/api/sessions/${agent.task.sessionId}/log`} target="_blank" rel="noreferrer">Log</a>}
            <button type="button" className="btn btn-sm btn-danger" onClick={stop} disabled={stopping}>{agent.task.status === 'running' ? 'Hentikan' : 'Batalkan'}</button>
          </span>
        )}
      </div>
    </section>
  );
}
