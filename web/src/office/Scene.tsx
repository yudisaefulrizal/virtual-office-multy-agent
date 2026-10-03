import { OrbitControls } from '@react-three/drei';
import { Canvas, useFrame } from '@react-three/fiber';
import { useMemo, useRef, type ReactNode, type RefObject } from 'react';
import { Vector3, type Group, type Object3D } from 'three';
import type { OfficeAgent, OfficeEvent, RuntimeInfo } from '../api';
import { ACTIVITY } from '../format';
import { FLOOR, ROOMS, SERVER_ROOM, placeAgents, type Placement } from './layout';
import { lookFor, type Look } from './look';

const ACCENT = '#6f8fff';
/** Lama animasi menyerahkan hasil ke Manager (pergi, berhenti, kembali). */
const WALK_MS = 7000;

interface Walk {
  start: number;
  to: [number, number];
}

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
      <meshLambertMaterial
        color={color}
        transparent={opacity < 1}
        opacity={opacity}
        emissive={emissive ?? '#000000'}
        emissiveIntensity={emissive ? 0.9 : 0}
      />
    </mesh>
  );
}

function Floor() {
  return (
    <group>
      <Block at={[0, -0.3, 0]} size={[FLOOR.w, 0.3, FLOOR.d]} color="#b8946a" />
      {/* Dinding belakang dan kiri */}
      <Block at={[-0.3, -0.3, -0.3]} size={[FLOOR.w + 0.3, 2.4, 0.3]} color="#dcd8cc" />
      <Block at={[-0.3, -0.3, 0]} size={[0.3, 2.4, FLOOR.d]} color="#d2cec2" />
      {[1.5, 4.5, 12, 15.5].map((x) => (
        <Block key={x} at={[x, 0.9, -0.02]} size={[2, 0.9, 0.04]} color="#9cc7e6" emissive="#4a7ea8" />
      ))}
      {[...ROOMS, SERVER_ROOM].map((r) => (
        <Block key={r.key} at={[r.x, 0, r.z]} size={[r.w, 0.04, r.d]} color={r.color} />
      ))}
      {/* Meja rapat eksekutif */}
      <Block at={[3.5, 0, 2.6]} size={[3, 0.45, 1.4]} color="#7a5a3c" />
      <Plant x={8.2} z={1.3} />
      <Plant x={11.3} z={5.2} />
      <Plant x={1.3} z={12.3} />
      <Plant x={15.4} z={12.4} />
      <Block at={[18.2, 0, 1.2]} size={[0.6, 1.5, 1.6]} color="#6e5038" />
      <Block at={[5, 0, 8.4]} size={[1.5, 1.2, 0.1]} color="#f2f1ec" />
    </group>
  );
}

function Plant({ x, z }: { x: number; z: number }) {
  return (
    <group>
      <Block at={[x, 0, z]} size={[0.4, 0.3, 0.4]} color="#8a5a3b" />
      <Block at={[x - 0.05, 0.3, z - 0.05]} size={[0.5, 0.45, 0.5]} color="#4e8a4a" />
      <Block at={[x + 0.1, 0.75, z + 0.1]} size={[0.3, 0.25, 0.3]} color="#62a85a" />
    </group>
  );
}

function Desk({ x, z, glow, ghost }: { x: number; z: number; glow: boolean; ghost: boolean }) {
  const o = ghost ? 0.45 : 1;
  return (
    <group>
      {/* Kursi di belakang avatar */}
      <Block at={[x + 0.3, 0, z - 1.0]} size={[0.5, 0.85, 0.45]} color="#3a3f47" opacity={o} />
      <Block at={[x, 0, z]} size={[1.8, 0.5, 0.8]} color="#9a7652" opacity={o} />
      <Block at={[x + 1.05, 0.5, z + 0.12]} size={[0.55, 0.4, 0.1]} color="#23272d" opacity={o} />
      <Block
        at={[x + 1.1, 0.55, z + 0.22]}
        size={[0.45, 0.3, 0.01]}
        color={glow ? ACCENT : '#3a4250'}
        emissive={glow ? ACCENT : undefined}
        opacity={o}
      />
    </group>
  );
}

/** Avatar voxel menghadap +z (ke arah kamera). */
function Avatar({ look, working, ghost, selected }: { look: Look; working: boolean; ghost: boolean; selected: boolean }) {
  const body = useRef<Group>(null);
  const armL = useRef<Group>(null);
  const armR = useRef<Group>(null);
  const ring = useRef<Group>(null);
  const seed = useMemo(() => Math.random() * 10, []);
  const o = ghost ? 0.35 : 1;

  useFrame(({ clock }) => {
    const t = clock.elapsedTime + seed;
    if (body.current) body.current.position.y = working ? Math.abs(Math.sin(t * 6)) * 0.03 : Math.sin(t * 1.5) * 0.01;
    if (armL.current) armL.current.rotation.x = working ? Math.sin(t * 12) * 0.35 : 0;
    if (armR.current) armR.current.rotation.x = working ? -Math.sin(t * 12) * 0.35 : 0;
    if (ring.current) ring.current.scale.setScalar(1 + Math.sin(t * 3) * 0.06);
  });

  return (
    <group>
      {selected && (
        <group ref={ring}>
          <mesh position={[0, 0.06, 0]} rotation={[-Math.PI / 2, 0, 0]}>
            <ringGeometry args={[0.38, 0.48, 4, 1, Math.PI / 4]} />
            <meshBasicMaterial color={ACCENT} />
          </mesh>
        </group>
      )}
      <group ref={body}>
        <Block at={[-0.2, 0, -0.1]} size={[0.17, 0.42, 0.2]} color={look.pants} opacity={o} />
        <Block at={[0.03, 0, -0.1]} size={[0.17, 0.42, 0.2]} color={look.pants} opacity={o} />
        <Block at={[-0.24, 0.38, -0.14]} size={[0.48, 0.6, 0.28]} color={look.shirt} opacity={o} />
        <group ref={armL} position={[-0.28, 0.92, 0]}>
          <Block at={[-0.04, -0.5, -0.08]} size={[0.08, 0.5, 0.16]} color={look.shirt} opacity={o} />
        </group>
        <group ref={armR} position={[0.28, 0.92, 0]}>
          <Block at={[-0.04, -0.5, -0.08]} size={[0.08, 0.5, 0.16]} color={look.shirt} opacity={o} />
        </group>
        <Block at={[-0.22, 0.98, -0.22]} size={[0.44, 0.44, 0.44]} color={look.skin} opacity={o} />
        <Block at={[-0.24, 1.36, -0.24]} size={[0.48, 0.16, 0.48]} color={look.hair} opacity={o} />
        <Block at={[-0.24, 1.14, -0.24]} size={[0.48, 0.22, 0.1]} color={look.hair} opacity={o} />
        <Block at={[-0.13, 1.16, 0.22]} size={[0.07, 0.07, 0.01]} color="#1a1a1a" opacity={o} />
        <Block at={[0.06, 1.16, 0.22]} size={[0.07, 0.07, 0.01]} color="#1a1a1a" opacity={o} />
      </group>
    </group>
  );
}

function Person({
  p,
  selected,
  onSelect,
  walk,
  register,
}: {
  p: Placement;
  selected: boolean;
  onSelect: (id: string) => void;
  walk: Walk | null;
  register: (id: string, obj: Object3D | null) => void;
}) {
  const { agent } = p;
  const look = useMemo(() => lookFor(agent.id, agent.department), [agent.id, agent.department]);
  const group = useRef<Group>(null);
  const paper = useRef<Group>(null);

  useFrame(() => {
    const g = group.current;
    if (!g) return;
    const t = walk ? (Date.now() - walk.start) / WALK_MS : 1;
    if (!walk || t < 0 || t >= 1) {
      g.position.set(p.x, 0.04, p.z);
      g.rotation.y = 0;
      if (paper.current) paper.current.visible = false;
      return;
    }
    // 0–0.4 berjalan ke Manager, 0.4–0.6 menyerahkan, 0.6–1 kembali.
    const [tx, tz] = walk.to;
    const k = t < 0.4 ? t / 0.4 : t < 0.6 ? 1 : 1 - (t - 0.6) / 0.4;
    const ease = k * k * (3 - 2 * k);
    g.position.set(p.x + (tx - p.x) * ease, 0.04 + (t < 0.4 || t > 0.6 ? Math.abs(Math.sin(t * 60)) * 0.05 : 0), p.z + (tz - p.z) * ease);
    const dir = t < 0.4 ? 1 : -1;
    g.rotation.y = t >= 0.4 && t <= 0.6 ? Math.PI : Math.atan2((tx - p.x) * dir, (tz - p.z) * dir);
    if (paper.current) paper.current.visible = t < 0.55;
  });

  return (
    <group
      ref={(g) => {
        group.current = g;
        register(agent.id, g);
      }}
      position={[p.x, 0.04, p.z]}
      onClick={(e) => (e.stopPropagation(), onSelect(agent.id))}
      onPointerOver={() => (document.body.style.cursor = 'pointer')}
      onPointerOut={() => (document.body.style.cursor = '')}
    >
      <Avatar look={look} working={agent.activity === 'working'} ghost={agent.activity === 'inactive'} selected={selected} />
      <group ref={paper} visible={false}>
        <Block at={[-0.14, 0.62, 0.2]} size={[0.28, 0.36, 0.03]} color="#f7f6f0" />
      </group>
    </group>
  );
}

const rackLed = (r: RuntimeInfo) =>
  !r.configured ? '#5a6068' : r.cooldownUntil ? '#ff9f5a' : r.inflight > 0 ? ACCENT : '#5fbf7a';
const rackZ = (i: number) => 8.6 + i * 1.5;

function Racks({ runtimes }: { runtimes: RuntimeInfo[] }) {
  return (
    <group>
      {runtimes.slice(0, 3).map((r, i) => {
        const z = rackZ(i);
        const led = rackLed(r);
        return (
          <group key={r.id}>
            <Block at={[17.5, 0, z]} size={[0.9, 1.6, 0.9]} color="#2b3036" />
            {[0.95, 1.25].map((y) => (
              <Block key={y} at={[17.6, y, z + 0.9]} size={[0.7, 0.07, 0.02]} color={led} emissive={r.configured ? led : undefined} />
            ))}
          </group>
        );
      })}
    </group>
  );
}

/** Label DOM di atas canvas; posisinya diproyeksikan dari titik 3D setiap frame. */
interface Label {
  key: string;
  at: [number, number, number];
  /** Ikuti objek 3D yang bergerak (avatar berjalan); `at[1]` menjadi tinggi di atasnya. */
  follow?: string;
  /** Diletakkan di atas titik (tag) atau di tengahnya (papan nama ruangan). */
  anchor: 'above' | 'center';
  node: ReactNode;
}

function LabelProjector({
  labels,
  refs,
  objects,
}: {
  labels: Label[];
  refs: RefObject<Map<string, HTMLDivElement>>;
  objects: RefObject<Map<string, Object3D>>;
}) {
  const v = useMemo(() => new Vector3(), []);
  useFrame(({ camera, size }) => {
    for (const l of labels) {
      const el = refs.current.get(l.key);
      if (!el) continue;
      const obj = l.follow ? objects.current.get(l.follow) : undefined;
      if (obj) v.set(obj.position.x, l.at[1], obj.position.z);
      else v.set(...l.at);
      v.project(camera);
      const x = ((v.x + 1) / 2) * size.width;
      const y = ((1 - v.y) / 2) * size.height;
      el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
      // Yang lebih dekat ke kamera tampil di atas.
      // Papan nama ruangan selalu di bawah label agent.
      el.style.zIndex = String(Math.round((1 - v.z) * 1000) + (l.anchor === 'above' ? 2000 : 0));
    }
  });
  return null;
}

export function OfficeScene({
  agents,
  runtimes,
  events,
  meeting,
  selectedId,
  onSelect,
}: {
  agents: OfficeAgent[];
  runtimes: RuntimeInfo[];
  events: OfficeEvent[];
  meeting: { objectiveId: string; title: string } | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const placements = useMemo(() => placeAgents(agents), [agents]);
  const target: [number, number, number] = [FLOOR.w / 2, 0, FLOOR.d / 2];
  const labelRefs = useRef(new Map<string, HTMLDivElement>());
  const people = useRef(new Map<string, Object3D>());
  const register = (id: string, obj: Object3D | null) => {
    if (obj) people.current.set(id, obj);
    else people.current.delete(id);
  };

  // Agent yang baru menyelesaikan task berjalan ke depan meja Manager untuk menyerahkan hasil.
  const manager = placements.find((p) => p.agent.roleId === 'manager');
  const walks = new Map<string, Walk>();
  if (manager) {
    const to: [number, number] = [manager.x + 0.5, manager.z + 1.6];
    for (const e of events) {
      if (e.type !== 'task.completed' || !e.actor.startsWith('agent:')) continue;
      const id = e.actor.slice(6);
      const start = Date.parse(e.createdAt);
      if (id === manager.agent.id || walks.has(id) || Date.now() - start > WALK_MS) continue;
      walks.set(id, { start, to });
    }
  }

  const labels: Label[] = [
    ...[...ROOMS, SERVER_ROOM].map((r): Label => ({
      key: `room-${r.key}`,
      at: [r.x + 0.3, 0.1, r.z + r.d - 0.3],
      anchor: 'center',
      node: <span className="sign">{r.name}</span>,
    })),
    ...(meeting
      ? [
          {
            key: 'meeting',
            at: [5, 1.6, 3.3] as [number, number, number],
            anchor: 'above' as const,
            node: (
              <a className="bubble warn" href={`#/objectives/${meeting.objectiveId}`} style={{ pointerEvents: 'auto', textDecoration: 'none' }}>
                Rapat strategi: {meeting.title}
              </a>
            ),
          },
        ]
      : []),
    ...runtimes.slice(0, 3).map((r, i): Label => ({
      key: `rack-${r.id}`,
      at: [17.95, 1.85, rackZ(i) + 0.45],
      anchor: 'above',
      node: (
        <span className="tag-name" style={{ pointerEvents: 'none' }}>
          <span className="sq" style={{ background: rackLed(r) }} />
          {r.id}
          {r.quota ? ` · ${r.quota.used}/${r.quota.max}` : ''}
        </span>
      ),
    })),
    ...placements.map(({ agent, x, z }): Label => {
      const selected = agent.id === selectedId;
      const bubble =
        agent.activity === 'working'
          ? { text: agent.line, cls: 'work' }
          : agent.activity === 'blocked'
            ? { text: agent.line, cls: 'warn' }
            : selected
              ? { text: agent.line, cls: '' }
              : null;
      return {
        key: `agent-${agent.id}`,
        at: [x, 1.8, z],
        follow: agent.id,
        anchor: 'above',
        node: (
          <>
            {bubble && <span className={`bubble ${bubble.cls}`}>{bubble.text}</span>}
            <button type="button" className={`tag-name${selected ? ' selected' : ''}`} onClick={() => onSelect(agent.id)} aria-pressed={selected}>
              <span className={`sq ${ACTIVITY[agent.activity].darkDot}`} />
              {agent.name}
            </button>
          </>
        ),
      };
    }),
  ];

  return (
    <div className="scene-wrap">
      <Canvas
        orthographic
        shadows
        camera={{ position: [FLOOR.w / 2 + 16, 16, FLOOR.d / 2 + 16], zoom: 36, near: -100, far: 200 }}
      >
        <color attach="background" args={['#1c222b']} />
        <ambientLight intensity={0.75} />
        <directionalLight position={[24, 30, 12]} intensity={1.2} castShadow shadow-mapSize={[2048, 2048]}>
          <orthographicCamera attach="shadow-camera" args={[-16, 16, 16, -16, 1, 80]} />
        </directionalLight>
        <OrbitControls
          target={target}
          enableRotate
          minPolarAngle={Math.PI / 6}
          maxPolarAngle={Math.PI / 2.6}
          minZoom={20}
          maxZoom={90}
          enableDamping
        />

        <Floor />
        {placements.map((p) =>
          p.desk ? (
            <Desk key={`d-${p.agent.id}`} x={p.desk.x} z={p.desk.z} glow={p.agent.activity === 'working'} ghost={p.agent.activity === 'inactive'} />
          ) : null,
        )}
        {placements.map((p) => (
          <Person key={p.agent.id} p={p} selected={p.agent.id === selectedId} onSelect={onSelect} walk={walks.get(p.agent.id) ?? null} register={register} />
        ))}
        <Racks runtimes={runtimes} />
        <LabelProjector labels={labels} refs={labelRefs} objects={people} />
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
