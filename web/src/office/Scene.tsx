import { OrbitControls } from '@react-three/drei';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef, type MutableRefObject, type ReactNode } from 'react';
import { Vector3, type Group } from 'three';
import type { OfficeAgent, OfficeEvent, RuntimeInfo } from '../api';
import { ACTIVITY } from '../format';
import { type AgentState, BehaviorEngine, HANDOVER_WINDOW_MS, type EngineInputs } from './behavior';
import type { FloorLayout, RoomLayout, Seat } from './layout';
import { lookFor, type Look } from './look';
import type { Rect } from './pathfinding';

const ACCENT = '#6f8fff';

interface BlockProps {
  /** Pojok minimum (x, y, z) dan ukuran (w, h, d). */
  at: [number, number, number];
  size: [number, number, number];
  color: string;
  opacity?: number;
  emissive?: string;
}

function Block({ at, size, color, opacity = 1, emissive }: BlockProps) {
  const [x, y, z] = at;
  const [w, h, d] = size;
  return (
    <mesh position={[x + w / 2, y + h / 2, z + d / 2]} castShadow receiveShadow>
      <boxGeometry args={size} />
      <meshLambertMaterial color={color} transparent={opacity < 1} opacity={opacity} emissive={emissive ?? '#000000'} emissiveIntensity={emissive ? 0.9 : 0} />
    </mesh>
  );
}

function RectBlock({ r, y, h, color, opacity, emissive }: { r: Rect; y: number; h: number; color: string; opacity?: number; emissive?: string }) {
  return <Block at={[r.x, y, r.z]} size={[r.w, h, r.d]} color={color} opacity={opacity} emissive={emissive} />;
}

function Chair({ seat, ghost = false }: { seat: Seat; ghost?: boolean }) {
  const o = ghost ? 0.45 : 1;
  const sx = Math.sin(seat.yaw);
  const sz = Math.cos(seat.yaw);
  const alongX = Math.abs(sx) > 0.5;
  const bx = seat.x - sx * 0.3;
  const bz = seat.z - sz * 0.3;
  return (
    <group>
      <Block at={[seat.x - 0.25, 0, seat.z - 0.25]} size={[0.5, 0.4, 0.5]} color="#3a3f47" opacity={o} />
      <Block
        at={[bx - (alongX ? 0.05 : 0.25), 0.4, bz - (alongX ? 0.25 : 0.05)]}
        size={alongX ? [0.1, 0.55, 0.5] : [0.5, 0.55, 0.1]}
        color="#2f343b"
        opacity={o}
      />
    </group>
  );
}

function Desk({ desk, glow, ghost }: { desk: Rect; glow: boolean; ghost: boolean }) {
  const o = ghost ? 0.45 : 1;
  const mx = desk.x + desk.w / 2 + 0.2;
  return (
    <group>
      <Block at={[desk.x, 0, desk.z]} size={[desk.w, 0.5, desk.d]} color="#9a7652" opacity={o} />
      <Block at={[mx - 0.3, 0.5, desk.z + 0.12]} size={[0.6, 0.4, 0.08]} color="#23272d" opacity={o} />
      <Block at={[mx - 0.26, 0.54, desk.z + 0.2]} size={[0.52, 0.32, 0.01]} color={glow ? ACCENT : '#3a4250'} emissive={glow ? ACCENT : undefined} opacity={o} />
    </group>
  );
}

function Plant({ x, z }: { x: number; z: number }) {
  return (
    <group>
      <Block at={[x - 0.2, 0, z - 0.2]} size={[0.4, 0.3, 0.4]} color="#8a5a3b" />
      <Block at={[x - 0.25, 0.3, z - 0.25]} size={[0.5, 0.45, 0.5]} color="#4e8a4a" />
      <Block at={[x - 0.15, 0.75, z - 0.15]} size={[0.3, 0.25, 0.3]} color="#62a85a" />
    </group>
  );
}

const rackLed = (r: RuntimeInfo) => (!r.configured ? '#5a6068' : r.cooldownUntil ? '#ff9f5a' : r.inflight > 0 ? ACCENT : '#5fbf7a');

/** Lampu mesin kopi menyala saat ada yang menyeduh. */
function BrewLight({ at, brewing }: { at: [number, number, number]; brewing: MutableRefObject<boolean> }) {
  const mat = useRef<{ color: { set: (c: string) => void }; emissive: { set: (c: string) => void } } | null>(null);
  useFrame(() => {
    const on = brewing.current;
    mat.current?.color.set(on ? '#ff9f5a' : '#5a6068');
    mat.current?.emissive.set(on ? '#ff9f5a' : '#000000');
  });
  return (
    <mesh position={[at[0] + 0.04, at[1] + 0.04, at[2] + 0.01]}>
      <boxGeometry args={[0.08, 0.08, 0.02]} />
      <meshLambertMaterial ref={mat as never} color="#5a6068" />
    </mesh>
  );
}

function RoomProps({
  room,
  agentAt,
  runtimes,
  meetingActive,
  brewing,
}: {
  room: RoomLayout;
  agentAt: Map<string, OfficeAgent>;
  runtimes: RuntimeInfo[];
  meetingActive: boolean;
  brewing: MutableRefObject<boolean>;
}) {
  if (room.kind === 'department') {
    return (
      <group>
        {room.desks.map((slot, i) => {
          const who = agentAt.get(`${slot.seat.x},${slot.seat.z}`);
          const idle = !who || who.activity === 'inactive';
          return (
            <group key={i}>
              <Chair seat={slot.seat} ghost={idle} />
              <Desk desk={slot.desk} glow={who?.activity === 'working'} ghost={idle} />
            </group>
          );
        })}
      </group>
    );
  }
  if (room.kind === 'meeting') {
    return (
      <group>
        {room.table && <RectBlock r={room.table} y={0} h={0.55} color="#7a5a3c" />}
        {room.meetingSeats?.map((s, i) => <Chair key={i} seat={s} />)}
        {room.whiteboard && <Block at={[room.whiteboard.x, 0.5, room.whiteboard.z]} size={[room.whiteboard.w, 1.1, 0.06]} color="#f2f1ec" />}
        <Block at={[room.rect.x + room.rect.w - 2.2, 0.5, room.rect.z + 0.2]} size={[1.6, 1.0, 0.06]} color={meetingActive ? ACCENT : '#2a2f36'} emissive={meetingActive ? ACCENT : undefined} />
      </group>
    );
  }
  if (room.kind === 'pantry' && room.pantry) {
    const p = room.pantry;
    return (
      <group>
        <RectBlock r={p.counter} y={0} h={0.7} color="#8d7d66" />
        <Block at={[p.machine.x - 0.25, 0.7, p.machine.z - 0.25]} size={[0.5, 0.55, 0.45]} color="#2b3036" />
        <BrewLight at={[p.machine.x - 0.1, 0.95, p.machine.z + 0.2]} brewing={brewing} />
        <Block at={[p.machine.x - 0.15, 0.7, p.machine.z + 0.25]} size={[0.3, 0.12, 0.2]} color="#e9e6dc" />
        <RectBlock r={p.cooler} y={0} h={1.1} color="#9cc7e6" />
        <RectBlock r={p.table} y={0} h={0.6} color="#a7916f" />
        <RectBlock r={p.sofa} y={0} h={0.45} color="#8a4b4b" />
        <Block at={[p.sofa.x - 0.02, 0.45, p.sofa.z]} size={[0.25, 0.5, p.sofa.d]} color="#7a3f3f" />
      </group>
    );
  }
  if (room.kind === 'runtime' && room.racks) {
    return (
      <group>
        {room.racks.map((rack, i) => {
          const rt = runtimes[i];
          const led = rt ? rackLed(rt) : '#5a6068';
          return (
            <group key={i}>
              <RectBlock r={rack} y={0} h={1.6} color="#2b3036" />
              {[0.95, 1.25].map((y) => (
                <Block key={y} at={[rack.x + 0.1, y, rack.z + rack.d]} size={[0.7, 0.07, 0.02]} color={led} emissive={rt?.configured ? led : undefined} />
              ))}
            </group>
          );
        })}
      </group>
    );
  }
  return null;
}

function Building({
  floor,
  deptColor,
  agentAt,
  runtimes,
  meetingActive,
  brewing,
}: {
  floor: FloorLayout;
  deptColor: (r: RoomLayout) => string;
  agentAt: Map<string, OfficeAgent>;
  runtimes: RuntimeInfo[];
  meetingActive: boolean;
  brewing: MutableRefObject<boolean>;
}) {
  return (
    <group>
      <Block at={[0, -0.3, 0]} size={[floor.w, 0.3, floor.d]} color="#b8a98c" />
      {/* Dinding belakang dan kiri gedung */}
      <Block at={[-0.3, -0.3, -0.3]} size={[floor.w + 0.3, 2.6, 0.3]} color="#dcd8cc" />
      <Block at={[-0.3, -0.3, 0]} size={[0.3, 2.6, floor.d]} color="#d2cec2" />
      {floor.windows.map((wx) => (
        <Block key={wx} at={[wx - 1, 1.0, -0.02]} size={[2, 1.0, 0.04]} color="#9cc7e6" emissive="#4a7ea8" />
      ))}
      <RectBlock r={floor.corridor} y={0} h={0.03} color="#d4cbb8" />
      {floor.rooms.map((room) => (
        <group key={room.id}>
          <RectBlock r={room.rect} y={0} h={0.04} color={deptColor(room)} />
          <RoomProps room={room} agentAt={agentAt} runtimes={runtimes} meetingActive={meetingActive} brewing={brewing} />
        </group>
      ))}
      {floor.walls.map((w, i) => (
        <RectBlock key={i} r={w} y={0} h={0.75} color="#ebe8de" />
      ))}
      {floor.plants.map((p, i) => (
        <Plant key={i} x={p.x} z={p.z} />
      ))}
    </group>
  );
}

const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** Avatar voxel: pose dan gestur mengikuti state dari BehaviorEngine. */
function Person({
  agent,
  look,
  engine,
  selected,
  onSelect,
}: {
  agent: OfficeAgent;
  look: Look;
  engine: BehaviorEngine;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const root = useRef<Group>(null);
  const body = useRef<Group>(null);
  const head = useRef<Group>(null);
  const legsStand = useRef<Group>(null);
  const legsSit = useRef<Group>(null);
  const legL = useRef<Group>(null);
  const legR = useRef<Group>(null);
  const armL = useRef<Group>(null);
  const armR = useRef<Group>(null);
  const cup = useRef<Group>(null);
  const paper = useRef<Group>(null);
  const ring = useRef<Group>(null);
  const yaw = useRef(0);
  const seed = useMemo(() => (agent.id.charCodeAt(0) + agent.id.charCodeAt(5)) % 17, [agent.id]);
  const ghost = agent.activity === 'inactive';
  const o = ghost ? 0.35 : 1;

  useFrame(({ clock }, dt) => {
    const s = engine.get(agent.id);
    if (!s || !root.current) return;
    const t = clock.elapsedTime + seed;
    root.current.position.set(s.x, 0.04, s.z);
    yaw.current += wrapAngle(s.yaw - yaw.current) * Math.min(1, dt * 12);
    root.current.rotation.y = yaw.current;

    const walking = s.pose === 'walk';
    const sitting = s.pose === 'sit';
    if (legsStand.current) legsStand.current.visible = !sitting;
    if (legsSit.current) legsSit.current.visible = sitting;
    if (body.current) body.current.position.y = walking ? Math.abs(Math.sin(t * 9)) * 0.04 : Math.sin(t * 1.5) * 0.008;

    const swing = walking ? Math.sin(t * 9) * 0.65 : 0;
    if (legL.current) legL.current.rotation.x = swing;
    if (legR.current) legR.current.rotation.x = -swing;

    // Lengan: ayun saat berjalan; gestur menentukan sisanya.
    let l = walking ? -swing * 0.8 : 0;
    let r = walking ? swing * 0.8 : 0;
    switch (s.gesture) {
      case 'type': l = -1.25 + Math.sin(t * 18) * 0.12; r = -1.25 + Math.sin(t * 18 + 1.5) * 0.12; break;
      case 'drink': r = -2.3 + Math.sin(t * 2) * 0.05; break;
      case 'brew': l = -1.0 + Math.sin(t * 5) * 0.1; r = -1.1 + Math.sin(t * 5 + 1) * 0.1; break;
      case 'stretch': l = -2.9 + Math.sin(t * 2) * 0.15; r = -2.9 + Math.sin(t * 2 + 0.6) * 0.15; break;
      case 'talk': r = -0.9 + Math.sin(t * 5) * 0.45; l = Math.sin(t * 3) * 0.15; break;
      case 'give': r = -1.45; l = -0.3; break;
      default:
        if (s.paper && walking) r = -1.2;
    }
    if (armL.current) armL.current.rotation.x = l;
    if (armR.current) armR.current.rotation.x = r;

    if (head.current) {
      head.current.rotation.y = s.gesture === 'look' ? Math.sin(t * 0.8) * 0.8 : s.gesture === 'talk' ? Math.sin(t * 2) * 0.25 : Math.sin(t * 0.6) * 0.06;
      head.current.rotation.x = s.gesture === 'drink' ? -0.25 : s.gesture === 'talk' ? Math.sin(t * 4) * 0.08 : 0;
    }
    if (cup.current) cup.current.visible = s.cup;
    if (paper.current) paper.current.visible = s.paper;
    if (ring.current) ring.current.scale.setScalar(1 + Math.sin(t * 3) * 0.06);
  });

  const legBlock = <Block at={[-0.085, -0.42, -0.1]} size={[0.17, 0.42, 0.2]} color={look.pants} opacity={o} />;
  const sitLeg = (x: number) => (
    <group>
      <Block at={[x - 0.085, 0.3, -0.1]} size={[0.17, 0.14, 0.5]} color={look.pants} opacity={o} />
      <Block at={[x - 0.085, 0, 0.28]} size={[0.17, 0.32, 0.14]} color={look.pants} opacity={o} />
    </group>
  );

  return (
    <group
      ref={root}
      onClick={(e) => (e.stopPropagation(), onSelect(agent.id))}
      onPointerOver={() => (document.body.style.cursor = 'pointer')}
      onPointerOut={() => (document.body.style.cursor = '')}
    >
      {selected && (
        <group ref={ring}>
          <mesh position={[0, 0.06, 0]} rotation={[-Math.PI / 2, 0, 0]}>
            <ringGeometry args={[0.38, 0.48, 4, 1, Math.PI / 4]} />
            <meshBasicMaterial color={ACCENT} />
          </mesh>
        </group>
      )}
      <group ref={body}>
        <group ref={legsStand}>
          <group ref={legL} position={[-0.1, 0.42, 0]}>{legBlock}</group>
          <group ref={legR} position={[0.1, 0.42, 0]}>{legBlock}</group>
        </group>
        <group ref={legsSit} visible={false}>
          {sitLeg(-0.1)}
          {sitLeg(0.1)}
        </group>
        <Block at={[-0.24, 0.38, -0.14]} size={[0.48, 0.6, 0.28]} color={look.shirt} opacity={o} />
        <group ref={armL} position={[-0.28, 0.92, 0]}>
          <Block at={[-0.04, -0.5, -0.08]} size={[0.08, 0.5, 0.16]} color={look.shirt} opacity={o} />
        </group>
        <group ref={armR} position={[0.28, 0.92, 0]}>
          <Block at={[-0.04, -0.5, -0.08]} size={[0.08, 0.5, 0.16]} color={look.shirt} opacity={o} />
          <group ref={cup} visible={false}>
            <Block at={[-0.06, -0.62, 0.02]} size={[0.12, 0.14, 0.12]} color="#f2f1ec" />
            <Block at={[-0.05, -0.5, 0.03]} size={[0.1, 0.03, 0.1]} color="#6b4a2b" />
          </group>
        </group>
        <group ref={head} position={[0, 0.98, 0]}>
          <Block at={[-0.22, 0, -0.22]} size={[0.44, 0.44, 0.44]} color={look.skin} opacity={o} />
          <Block at={[-0.24, 0.38, -0.24]} size={[0.48, 0.16, 0.48]} color={look.hair} opacity={o} />
          <Block at={[-0.24, 0.16, -0.24]} size={[0.48, 0.22, 0.1]} color={look.hair} opacity={o} />
          <Block at={[-0.13, 0.18, 0.22]} size={[0.07, 0.07, 0.01]} color="#1a1a1a" opacity={o} />
          <Block at={[0.06, 0.18, 0.22]} size={[0.07, 0.07, 0.01]} color="#1a1a1a" opacity={o} />
        </group>
        <group ref={paper} visible={false}>
          <Block at={[-0.14, 0.62, 0.3]} size={[0.28, 0.36, 0.03]} color="#f7f6f0" />
        </group>
      </group>
    </group>
  );
}

/** Label DOM di atas canvas; posisinya diproyeksikan dari titik 3D setiap frame. */
interface Label {
  key: string;
  at: [number, number, number];
  /** Ikuti avatar (posisi dari engine); at[1] jadi tinggi di atasnya. */
  follow?: string;
  anchor: 'above' | 'center';
  node: ReactNode;
}

function LabelProjector({ labels, refs, engine }: { labels: Label[]; refs: MutableRefObject<Map<string, HTMLDivElement>>; engine: BehaviorEngine }) {
  const v = useMemo(() => new Vector3(), []);
  useFrame(({ camera, size }) => {
    for (const l of labels) {
      const el = refs.current.get(l.key);
      if (!el) continue;
      const s = l.follow ? engine.get(l.follow) : undefined;
      if (s) v.set(s.x, l.at[1], s.z);
      else v.set(...l.at);
      v.project(camera);
      el.style.transform = `translate(${(((v.x + 1) / 2) * size.width).toFixed(1)}px, ${(((1 - v.y) / 2) * size.height).toFixed(1)}px)`;
      // Papan nama ruangan selalu di bawah label agent.
      el.style.zIndex = String(Math.round((1 - v.z) * 1000) + (l.anchor === 'above' ? 2000 : 0));
    }
  });
  return null;
}

/** Atur zoom dan titik pandang agar seluruh lantai muat di layar. */
function FitCamera({ floor }: { floor: FloorLayout }) {
  const { camera, size } = useThree();
  useEffect(() => {
    const span = floor.w + floor.d;
    const zoomX = size.width / (span * 0.7071 * 1.12);
    const zoomY = size.height / (span * 0.408 + 4.2);
    camera.zoom = Math.max(8, Math.min(zoomX, zoomY));
    camera.position.set(floor.w / 2 + 16, 16, floor.d / 2 + 16);
    camera.lookAt(floor.w / 2, 0, floor.d / 2);
    camera.updateProjectionMatrix();
  }, [camera, floor, size.width, size.height]);
  return null;
}

/** Tick mesin perilaku dan sinkronkan inputnya dengan data terbaru. */
function Behavior({ engine, inputs, brewing }: { engine: BehaviorEngine; inputs: MutableRefObject<EngineInputs>; brewing: MutableRefObject<boolean> }) {
  useFrame(({ clock }, dt) => {
    const now = clock.elapsedTime;
    engine.setInputs(inputs.current, now);
    engine.update(Math.min(dt, 0.1), now);
    brewing.current = engine.ids().some((id) => engine.get(id)?.gesture === 'brew');
  });
  return null;
}

/** requestAnimationFrame untuk komponen DOM yang berada di luar <Canvas>. */
function useDomFrame(fn: () => void) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      ref.current();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
}

/** Nama + gelembung. Gelembung dari mesin perilaku (kopi, ngobrol) diperbarui tanpa render ulang React. */
function AgentTag({ agent, selected, engine, onSelect }: { agent: OfficeAgent; selected: boolean; engine: BehaviorEngine; onSelect: (id: string) => void }) {
  const bubbleRef = useRef<HTMLSpanElement>(null);
  useDomFrame(() => {
    const el = bubbleRef.current;
    if (!el) return;
    const s: AgentState | undefined = engine.get(agent.id);
    const text = s?.bubble ?? '';
    if (el.textContent !== text) el.textContent = text;
    el.style.display = text ? '' : 'none';
  });
  const status =
    agent.activity === 'working'
      ? { text: agent.line, cls: 'work' }
      : agent.activity === 'blocked'
        ? { text: agent.line, cls: 'warn' }
        : selected
          ? { text: agent.line, cls: '' }
          : null;
  return (
    <>
      {status && <span className={`bubble ${status.cls}`}>{status.text}</span>}
      <span ref={bubbleRef} className="bubble" style={{ display: 'none' }} />
      <button type="button" className={`tag-name${selected ? ' selected' : ''}`} onClick={() => onSelect(agent.id)} aria-pressed={selected}>
        <span className={`sq ${ACTIVITY[agent.activity].darkDot}`} />
        {agent.name}
      </button>
    </>
  );
}

export interface SceneProps {
  floor: FloorLayout;
  agents: OfficeAgent[];
  runtimes: RuntimeInfo[];
  events: OfficeEvent[];
  meeting: { objectiveId: string; title: string; participants: string[] } | null;
  deptColors: Map<string, string>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Dibaca panel detail untuk menampilkan kegiatan saat ini. */
  engineRef: MutableRefObject<BehaviorEngine | null>;
}

export function OfficeScene({ floor, agents, runtimes, events, meeting, deptColors, selectedId, onSelect, engineRef }: SceneProps) {
  const onFloor = useMemo(() => agents.filter((a) => floor.seatOf.has(a.id)), [agents, floor]);
  const engine = useMemo(
    () => new BehaviorEngine(floor, onFloor.map((a) => ({ id: a.id, name: a.name, roleId: a.roleId, activity: a.activity }))),
    // Mesin dibuat ulang hanya saat tata letak berubah (staf/divisi baru).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [floor],
  );
  engineRef.current = engine;

  const manager = agents.find((a) => a.roleId === 'manager');
  const handovers = new Map<string, number>();
  for (const e of events) {
    if (e.type !== 'task.completed' || !e.actor.startsWith('agent:')) continue;
    const id = e.actor.slice(6);
    const start = Date.parse(e.createdAt);
    if (Date.now() - start <= HANDOVER_WINDOW_MS && !handovers.has(id)) handovers.set(id, start);
  }
  const inputs = useRef<EngineInputs>({ agents: [], meetingIds: new Set(), handovers, managerId: null });
  inputs.current = {
    agents: onFloor.map((a) => ({ id: a.id, name: a.name, roleId: a.roleId, activity: a.activity })),
    meetingIds: new Set(meeting?.participants ?? []),
    handovers,
    managerId: manager?.id ?? null,
  };
  const brewing = useRef(false);

  const agentAt = useMemo(() => {
    const m = new Map<string, OfficeAgent>();
    for (const a of onFloor) {
      const s = floor.seatOf.get(a.id);
      if (s) m.set(`${s.x},${s.z}`, a);
    }
    return m;
  }, [onFloor, floor]);

  const labelRefs = useRef(new Map<string, HTMLDivElement>());
  const meetingRoom = floor.rooms.find((r) => r.kind === 'meeting');

  const labels: Label[] = [
    ...floor.rooms.map(
      (r): Label => ({
        key: `room-${r.id}`,
        at: [r.rect.x + r.rect.w / 2, 0.85, r.rect.z + r.rect.d],
        anchor: 'center',
        node: <span className="sign">{r.name}</span>,
      }),
    ),
    ...(meeting && meetingRoom
      ? [
          {
            key: 'meeting',
            at: [meetingRoom.rect.x + meetingRoom.rect.w / 2, 1.8, meetingRoom.rect.z + meetingRoom.rect.d / 2] as [number, number, number],
            anchor: 'above' as const,
            node: (
              <a className="bubble warn" href={`#/objectives/${meeting.objectiveId}`} style={{ pointerEvents: 'auto', textDecoration: 'none' }}>
                Rapat strategi: {meeting.title}
              </a>
            ),
          },
        ]
      : []),
    ...floor.rooms.flatMap((r) =>
      r.kind === 'runtime' && r.racks
        ? runtimes.slice(0, 3).map(
            (rt, i): Label => ({
              key: `rack-${rt.id}`,
              at: [r.racks![i]!.x + 0.45, 1.85, r.racks![i]!.z + 0.45],
              anchor: 'above',
              node: (
                <span className="tag-name" style={{ pointerEvents: 'none' }}>
                  <span className="sq" style={{ background: rackLed(rt) }} />
                  {rt.id}
                  {rt.quota ? ` · ${rt.quota.used}/${rt.quota.max}` : ''}
                </span>
              ),
            }),
          )
        : [],
    ),
    ...onFloor.map(
      (agent): Label => ({
        key: `agent-${agent.id}`,
        at: [0, 1.85, 0],
        follow: agent.id,
        anchor: 'above',
        node: <AgentTag agent={agent} selected={agent.id === selectedId} engine={engine} onSelect={onSelect} />,
      }),
    ),
  ];

  return (
    <div className="scene-wrap">
      <Canvas orthographic shadows camera={{ position: [floor.w / 2 + 16, 16, floor.d / 2 + 16], zoom: 30, near: -100, far: 300 }}>
        <color attach="background" args={['#0e131b']} />
        <ambientLight intensity={0.75} />
        <directionalLight position={[floor.w + 8, 30, floor.d + 4]} intensity={1.2} castShadow shadow-mapSize={[2048, 2048]}>
          <orthographicCamera attach="shadow-camera" args={[-30, 30, 30, -30, 1, 120]} />
        </directionalLight>
        <FitCamera floor={floor} />
        <OrbitControls target={[floor.w / 2, 0, floor.d / 2]} enableRotate minPolarAngle={Math.PI / 6} maxPolarAngle={Math.PI / 2.6} minZoom={8} maxZoom={110} enableDamping />
        <Building
          floor={floor}
          deptColor={(r) => (r.kind === 'department' ? deptColors.get(r.id) ?? r.color : r.color)}
          agentAt={agentAt}
          runtimes={runtimes}
          meetingActive={!!meeting}
          brewing={brewing}
        />
        {onFloor.map((a) => (
          <Person key={a.id} agent={a} look={lookFor(a.id, a.department)} engine={engine} selected={a.id === selectedId} onSelect={onSelect} />
        ))}
        <Behavior engine={engine} inputs={inputs} brewing={brewing} />
        <LabelProjector labels={labels} refs={labelRefs} engine={engine} />
      </Canvas>
      <div className="labels-layer">
        {labels.map((l) => (
          <div
            key={l.key}
            className="label-anchor"
            ref={(el) => {
              if (el) labelRefs.current.set(l.key, el);
              else labelRefs.current.delete(l.key);
            }}
          >
            <div className={l.anchor === 'above' ? 'tag' : 'label-center'}>{l.node}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
