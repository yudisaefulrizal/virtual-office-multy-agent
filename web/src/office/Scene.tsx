import { Environment, Lightformer, OrbitControls, RoundedBox, SoftShadows } from '@react-three/drei';
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

/** Material PBR: kayu, kain, logam, kaca dibedakan lewat kekasaran dan kilap. */
interface MatProps {
  color: string;
  rough?: number;
  metal?: number;
  opacity?: number;
  emissive?: string;
  glow?: number;
}
function Mat({ color, rough = 0.7, metal = 0, opacity = 1, emissive, glow = 0.8 }: MatProps) {
  return (
    <meshStandardMaterial
      color={color}
      roughness={rough}
      metalness={metal}
      transparent={opacity < 1}
      opacity={opacity}
      depthWrite={opacity >= 0.5}
      emissive={emissive ?? '#000000'}
      emissiveIntensity={emissive ? glow : 0}
    />
  );
}

interface BlockProps extends MatProps {
  /** Pojok minimum (x, y, z) dan ukuran (w, h, d). */
  at: [number, number, number];
  size: [number, number, number];
  /** Radius tepi membulat; 0 = kotak tajam. */
  r?: number;
  shadow?: boolean;
}

function Block({ at, size, r = 0.02, shadow = true, ...m }: BlockProps) {
  const [x, y, z] = at;
  const [w, h, d] = size;
  const pos: [number, number, number] = [x + w / 2, y + h / 2, z + d / 2];
  const radius = Math.min(r, w / 2 - 0.001, h / 2 - 0.001, d / 2 - 0.001);
  if (radius <= 0.004) {
    return (
      <mesh position={pos} castShadow={shadow} receiveShadow>
        <boxGeometry args={size} />
        <Mat {...m} />
      </mesh>
    );
  }
  return (
    <RoundedBox args={size} radius={radius} smoothness={3} position={pos} castShadow={shadow} receiveShadow>
      <Mat {...m} />
    </RoundedBox>
  );
}

function RectBlock({ r, y, h, r2 = 0.02, shadow, ...m }: { r: Rect; y: number; h: number; r2?: number; shadow?: boolean } & MatProps) {
  return <Block at={[r.x, y, r.z]} size={[r.w, h, r.d]} r={r2} shadow={shadow} {...m} />;
}

function Cyl({ at, radius, h, top, ...m }: { at: [number, number, number]; radius: number; h: number; top?: number } & MatProps) {
  return (
    <mesh position={[at[0], at[1] + h / 2, at[2]]} castShadow receiveShadow>
      <cylinderGeometry args={[top ?? radius, radius, h, 20]} />
      <Mat {...m} />
    </mesh>
  );
}

/** Kursi kantor: dudukan empuk, sandaran, tiang gas, kaki bintang lima beroda. */
function Chair({ seat, ghost = false }: { seat: Seat; ghost?: boolean }) {
  const o = ghost ? 0.5 : 1;
  const fabric = '#2c3138';
  return (
    <group position={[seat.x, 0, seat.z]} rotation={[0, seat.yaw, 0]}>
      {[0, 1, 2, 3, 4].map((i) => (
        <group key={i} rotation={[0, (i * Math.PI * 2) / 5, 0]}>
          <Block at={[-0.02, 0.04, 0]} size={[0.04, 0.03, 0.24]} r={0.01} color="#5b616b" metal={0.6} rough={0.35} opacity={o} />
          <mesh position={[0, 0.03, 0.23]} castShadow>
            <sphereGeometry args={[0.03, 10, 8]} />
            <Mat color="#1a1d22" rough={0.5} opacity={o} />
          </mesh>
        </group>
      ))}
      <Cyl at={[0, 0.06, 0]} radius={0.025} h={0.3} color="#8a9099" metal={0.8} rough={0.25} opacity={o} />
      <Block at={[-0.24, 0.34, -0.22]} size={[0.48, 0.09, 0.46]} r={0.04} color={fabric} rough={0.95} opacity={o} />
      <Block at={[-0.22, 0.44, -0.28]} size={[0.44, 0.52, 0.07]} r={0.035} color={fabric} rough={0.95} opacity={o} />
      <Block at={[-0.03, 0.36, -0.27]} size={[0.06, 0.12, 0.05]} r={0.01} color="#5b616b" metal={0.6} rough={0.35} opacity={o} />
    </group>
  );
}

/** Meja kerja: daun meja kayu, kaki logam, monitor bertiang, keyboard. */
function Desk({ desk, glow, ghost }: { desk: Rect; glow: boolean; ghost: boolean }) {
  const o = ghost ? 0.5 : 1;
  const top = 0.56;
  const mx = desk.x + desk.w / 2 + 0.2;
  const legs: [number, number][] = [
    [desk.x + 0.06, desk.z + 0.06],
    [desk.x + desk.w - 0.1, desk.z + 0.06],
    [desk.x + 0.06, desk.z + desk.d - 0.1],
    [desk.x + desk.w - 0.1, desk.z + desk.d - 0.1],
  ];
  return (
    <group>
      <Block at={[desk.x, top - 0.05, desk.z]} size={[desk.w, 0.05, desk.d]} r={0.015} color="#b48a62" rough={0.55} opacity={o} />
      {legs.map(([x, z], i) => (
        <Block key={i} at={[x, 0, z]} size={[0.04, top - 0.05, 0.04]} r={0.01} color="#3a3f47" metal={0.7} rough={0.3} opacity={o} />
      ))}
      {/* Monitor */}
      <Block at={[mx - 0.08, top, desk.z + 0.12]} size={[0.16, 0.012, 0.12]} r={0.005} color="#2a2e34" metal={0.5} rough={0.35} opacity={o} />
      <Block at={[mx - 0.02, top, desk.z + 0.16]} size={[0.04, 0.2, 0.03]} r={0.008} color="#2a2e34" metal={0.5} rough={0.35} opacity={o} />
      <Block at={[mx - 0.32, top + 0.14, desk.z + 0.14]} size={[0.64, 0.38, 0.035]} r={0.015} color="#16191d" metal={0.2} rough={0.4} opacity={o} />
      <Block
        at={[mx - 0.3, top + 0.16, desk.z + 0.176]}
        size={[0.6, 0.34, 0.004]}
        r={0}
        shadow={false}
        color={glow ? '#cfd9ff' : '#20262f'}
        emissive={glow ? ACCENT : undefined}
        glow={1.4}
        rough={0.15}
        opacity={o}
      />
      {/* Keyboard + mouse */}
      <Block at={[mx - 0.22, top, desk.z + desk.d - 0.32]} size={[0.38, 0.018, 0.13]} r={0.006} color="#d9dde3" rough={0.6} opacity={o} />
      <Block at={[mx + 0.24, top, desk.z + desk.d - 0.3]} size={[0.06, 0.02, 0.09]} r={0.02} color="#d9dde3" rough={0.6} opacity={o} />
    </group>
  );
}

/** Tanaman pot: pot keramik + rimbun daun. */
function Plant({ x, z }: { x: number; z: number }) {
  const leaves: [number, number, number, number][] = [
    [0, 0.62, 0, 0.26],
    [0.12, 0.78, 0.05, 0.2],
    [-0.1, 0.8, -0.06, 0.19],
    [0.02, 0.95, -0.02, 0.16],
  ];
  return (
    <group position={[x, 0, z]}>
      <Cyl at={[0, 0, 0]} radius={0.17} top={0.21} h={0.42} color="#e8e2d6" rough={0.35} />
      <Cyl at={[0, 0.4, 0]} radius={0.19} h={0.03} color="#4b3a2b" rough={1} />
      {leaves.map(([lx, ly, lz, r], i) => (
        <mesh key={i} position={[lx, ly, lz]} castShadow>
          <icosahedronGeometry args={[r, 1]} />
          <Mat color={i % 2 ? '#4f8f4a' : '#3f7a3c'} rough={0.8} />
        </mesh>
      ))}
    </group>
  );
}

/** Sekat kaca antar ruangan: alas padat, kaca bening, rangka aluminium. */
function GlassWall({ r }: { r: Rect }) {
  return (
    <group>
      <RectBlock r={r} y={0} h={0.22} color="#e9e6df" rough={0.8} r2={0.01} />
      <Block at={[r.x + 0.02, 0.22, r.z + 0.02]} size={[Math.max(0.02, r.w - 0.04), 0.86, Math.max(0.02, r.d - 0.04)]} r={0} shadow={false} color="#bcd6ea" rough={0.05} metal={0.1} opacity={0.2} />
      <RectBlock r={r} y={1.08} h={0.04} color="#a9b1bb" metal={0.8} rough={0.3} r2={0.005} />
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
      <meshStandardMaterial ref={mat as never} color="#5a6068" emissiveIntensity={1.5} />
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
    const t = room.table;
    return (
      <group>
        {t && (
          <group>
            <Block at={[t.x, 0.5, t.z]} size={[t.w, 0.06, t.d]} r={0.03} color="#6d4c33" rough={0.35} />
            <Block at={[t.x + t.w * 0.2, 0, t.z + t.d / 2 - 0.12]} size={[0.24, 0.5, 0.24]} r={0.02} color="#2f343b" metal={0.6} rough={0.3} />
            <Block at={[t.x + t.w * 0.8 - 0.24, 0, t.z + t.d / 2 - 0.12]} size={[0.24, 0.5, 0.24]} r={0.02} color="#2f343b" metal={0.6} rough={0.3} />
          </group>
        )}
        {room.meetingSeats?.map((s, i) => <Chair key={i} seat={s} />)}
        {room.whiteboard && (
          <group>
            <Block at={[room.whiteboard.x - 0.03, 0.47, room.whiteboard.z - 0.01]} size={[room.whiteboard.w + 0.06, 1.16, 0.06]} r={0.01} color="#b9c0c8" metal={0.7} rough={0.3} />
            <Block at={[room.whiteboard.x, 0.5, room.whiteboard.z + 0.03]} size={[room.whiteboard.w, 1.1, 0.03]} r={0} color="#fbfbf8" rough={0.2} />
          </group>
        )}
        <Block at={[room.rect.x + room.rect.w - 2.2, 0.5, room.rect.z + 0.2]} size={[1.6, 0.95, 0.06]} r={0.015} color="#111418" rough={0.3} metal={0.3} />
        <Block at={[room.rect.x + room.rect.w - 2.15, 0.54, room.rect.z + 0.262]} size={[1.5, 0.87, 0.004]} r={0} shadow={false} color={meetingActive ? '#cfd9ff' : '#1d232c'} emissive={meetingActive ? ACCENT : undefined} glow={1.2} rough={0.15} />
      </group>
    );
  }
  if (room.kind === 'pantry' && room.pantry) {
    const p = room.pantry;
    return (
      <group>
        <RectBlock r={p.counter} y={0} h={0.66} color="#f1efe9" rough={0.6} />
        <RectBlock r={{ x: p.counter.x - 0.02, z: p.counter.z - 0.02, w: p.counter.w + 0.04, d: p.counter.d + 0.04 }} y={0.66} h={0.05} color="#3b3f45" rough={0.25} metal={0.2} r2={0.01} />
        <Block at={[p.machine.x - 0.22, 0.71, p.machine.z - 0.22]} size={[0.44, 0.5, 0.4]} r={0.04} color="#24282d" metal={0.6} rough={0.3} />
        <BrewLight at={[p.machine.x - 0.1, 0.98, p.machine.z + 0.18]} brewing={brewing} />
        <Block at={[p.machine.x - 0.12, 0.71, p.machine.z + 0.18]} size={[0.24, 0.1, 0.16]} r={0.01} color="#c7cbd1" metal={0.8} rough={0.25} />
        <RectBlock r={p.cooler} y={0} h={1.15} color="#e4e8ec" rough={0.3} metal={0.3} />
        <Block at={[p.cooler.x + 0.05, 0.75, p.cooler.z + p.cooler.d]} size={[Math.max(0.05, p.cooler.w - 0.1), 0.35, 0.02]} r={0.005} color="#9cc7e6" rough={0.1} opacity={0.6} />
        <Block at={[p.table.x, 0.55, p.table.z]} size={[p.table.w, 0.05, p.table.d]} r={0.025} color="#c9a882" rough={0.45} />
        <Cyl at={[p.table.x + p.table.w / 2, 0, p.table.z + p.table.d / 2]} radius={0.05} h={0.55} color="#3a3f47" metal={0.7} rough={0.3} />
        {/* Sofa: dudukan, sandaran, lengan */}
        <Block at={[p.sofa.x, 0.08, p.sofa.z]} size={[p.sofa.w, 0.3, p.sofa.d]} r={0.06} color="#7d4b4b" rough={0.95} />
        <Block at={[p.sofa.x - 0.04, 0.08, p.sofa.z]} size={[0.24, 0.62, p.sofa.d]} r={0.07} color="#6e4040" rough={0.95} />
        <Block at={[p.sofa.x, 0.08, p.sofa.z - 0.02]} size={[p.sofa.w, 0.45, 0.16]} r={0.06} color="#6e4040" rough={0.95} />
        <Block at={[p.sofa.x, 0.08, p.sofa.z + p.sofa.d - 0.14]} size={[p.sofa.w, 0.45, 0.16]} r={0.06} color="#6e4040" rough={0.95} />
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
              <RectBlock r={rack} y={0} h={1.6} color="#1d2126" metal={0.5} rough={0.35} />
              {[0.35, 0.6, 0.85, 1.1, 1.35].map((y) => (
                <Block key={y} at={[rack.x + 0.06, y, rack.z + rack.d]} size={[rack.w - 0.12, 0.16, 0.012]} r={0.004} color="#2b3036" metal={0.6} rough={0.4} />
              ))}
              {[0.95, 1.25].map((y) => (
                <Block key={`l${y}`} at={[rack.x + 0.1, y, rack.z + rack.d + 0.013]} size={[0.5, 0.025, 0.006]} r={0} shadow={false} color={led} emissive={rt?.configured ? led : undefined} glow={2} />
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
      {/* Pelat lantai beton halus */}
      <Block at={[-0.3, -0.3, -0.3]} size={[floor.w + 0.6, 0.3, floor.d + 0.6]} r={0.04} color="#b9b3a8" rough={0.85} />
      {/* Dinding belakang dan kiri dengan jendela besar */}
      <Block at={[-0.3, 0, -0.3]} size={[floor.w + 0.3, 2.5, 0.25]} r={0.02} color="#ece9e2" rough={0.9} />
      <Block at={[-0.3, 0, -0.05]} size={[0.25, 2.5, floor.d + 0.05]} r={0.02} color="#e4e0d8" rough={0.9} />
      {floor.windows.map((wx) => (
        <group key={wx}>
          <Block at={[wx - 1.1, 0.75, -0.08]} size={[2.2, 1.45, 0.05]} r={0.01} color="#9aa3ad" metal={0.8} rough={0.3} />
          <Block at={[wx - 1.02, 0.82, -0.04]} size={[2.04, 1.31, 0.01]} r={0} shadow={false} color="#cfe6ff" emissive="#9cc7ee" glow={0.55} rough={0.05} />
        </group>
      ))}
      <RectBlock r={floor.corridor} y={0} h={0.012} color="#c9c2b5" rough={0.6} r2={0} />
      {floor.rooms.map((room) => {
        const inset = { x: room.rect.x + 0.12, z: room.rect.z + 0.12, w: room.rect.w - 0.24, d: room.rect.d - 0.24 };
        return (
          <group key={room.id}>
            <RectBlock r={room.rect} y={0} h={0.014} color="#d2cbbe" rough={0.7} r2={0} />
            {/* Karpet berwarna divisi */}
            <RectBlock r={inset} y={0.014} h={0.012} color={deptColor(room)} rough={1} r2={0} shadow={false} />
            <RoomProps room={room} agentAt={agentAt} runtimes={runtimes} meetingActive={meetingActive} brewing={brewing} />
          </group>
        );
      })}
      {floor.walls.map((w, i) => (
        <GlassWall key={i} r={w} />
      ))}
      {floor.plants.map((p, i) => (
        <Plant key={i} x={p.x} z={p.z} />
      ))}
    </group>
  );
}

const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** Capsule vertikal (anggota tubuh) dengan pusat di `y`. */
function Limb({ y = 0, z = 0, len, radius, color, opacity = 1, rotX = 0 }: { y?: number; z?: number; len: number; radius: number; color: string; opacity?: number; rotX?: number }) {
  return (
    <mesh position={[0, y, z]} rotation={[rotX, 0, 0]} castShadow>
      <capsuleGeometry args={[radius, len, 6, 14]} />
      <Mat color={color} rough={0.85} opacity={opacity} />
    </mesh>
  );
}

/** Avatar manusia proporsional: pose dan gestur mengikuti state dari BehaviorEngine. */
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
  const shoe = '#1b1d21';

  useFrame(({ clock }, dt) => {
    const s = engine.get(agent.id);
    if (!s || !root.current) return;
    const t = clock.elapsedTime + seed;
    root.current.position.set(s.x, 0.02, s.z);
    yaw.current += wrapAngle(s.yaw - yaw.current) * Math.min(1, dt * 12);
    root.current.rotation.y = yaw.current;

    const walking = s.pose === 'walk';
    const sitting = s.pose === 'sit';
    if (legsStand.current) legsStand.current.visible = !sitting;
    if (legsSit.current) legsSit.current.visible = sitting;
    if (body.current) body.current.position.y = walking ? Math.abs(Math.sin(t * 9)) * 0.025 : Math.sin(t * 1.5) * 0.006;

    const swing = walking ? Math.sin(t * 9) * 0.55 : 0;
    if (legL.current) legL.current.rotation.x = swing;
    if (legR.current) legR.current.rotation.x = -swing;

    let l = walking ? -swing * 0.7 : 0.05;
    let r = walking ? swing * 0.7 : 0.05;
    switch (s.gesture) {
      case 'type': l = -1.1 + Math.sin(t * 18) * 0.08; r = -1.1 + Math.sin(t * 18 + 1.5) * 0.08; break;
      case 'drink': r = -2.2 + Math.sin(t * 2) * 0.05; break;
      case 'brew': l = -1.0 + Math.sin(t * 5) * 0.1; r = -1.1 + Math.sin(t * 5 + 1) * 0.1; break;
      case 'stretch': l = -2.9 + Math.sin(t * 2) * 0.15; r = -2.9 + Math.sin(t * 2 + 0.6) * 0.15; break;
      case 'talk': r = -0.8 + Math.sin(t * 5) * 0.4; l = Math.sin(t * 3) * 0.12; break;
      case 'give': r = -1.4; l = -0.3; break;
      default:
        if (s.paper && walking) r = -1.2;
    }
    if (armL.current) armL.current.rotation.x = l;
    if (armR.current) armR.current.rotation.x = r;

    if (head.current) {
      head.current.rotation.y = s.gesture === 'look' ? Math.sin(t * 0.8) * 0.8 : s.gesture === 'talk' ? Math.sin(t * 2) * 0.25 : Math.sin(t * 0.6) * 0.06;
      head.current.rotation.x = s.gesture === 'drink' ? -0.25 : s.gesture === 'type' ? 0.12 : s.gesture === 'talk' ? Math.sin(t * 4) * 0.06 : 0;
    }
    if (cup.current) cup.current.visible = s.cup;
    if (paper.current) paper.current.visible = s.paper;
    if (ring.current) ring.current.scale.setScalar(1 + Math.sin(t * 3) * 0.06);
  });

  const standLeg = (
    <group>
      <Limb y={-0.21} len={0.3} radius={0.068} color={look.pants} opacity={o} />
      <Block at={[-0.065, -0.47, -0.08]} size={[0.13, 0.07, 0.24]} r={0.03} color={shoe} rough={0.5} opacity={o} />
    </group>
  );
  const sitLeg = (x: number) => (
    <group position={[x, 0, 0]}>
      <Limb y={0.44} z={0.17} len={0.26} radius={0.07} color={look.pants} opacity={o} rotX={Math.PI / 2} />
      <Limb y={0.22} z={0.37} len={0.26} radius={0.062} color={look.pants} opacity={o} />
      <Block at={[-0.065, 0, 0.3]} size={[0.13, 0.07, 0.22]} r={0.03} color={shoe} rough={0.5} opacity={o} />
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
          <mesh position={[0, 0.04, 0]} rotation={[-Math.PI / 2, 0, 0]}>
            <ringGeometry args={[0.36, 0.44, 48]} />
            <meshBasicMaterial color={ACCENT} transparent opacity={0.9} />
          </mesh>
        </group>
      )}
      <group ref={body}>
        <group ref={legsStand}>
          <group ref={legL} position={[-0.09, 0.47, 0]}>{standLeg}</group>
          <group ref={legR} position={[0.09, 0.47, 0]}>{standLeg}</group>
        </group>
        <group ref={legsSit} visible={false}>
          {sitLeg(-0.09)}
          {sitLeg(0.09)}
        </group>
        {/* Pinggul dan badan */}
        <Block at={[-0.17, 0.42, -0.1]} size={[0.34, 0.14, 0.2]} r={0.06} color={look.pants} rough={0.85} opacity={o} />
        <Block at={[-0.2, 0.54, -0.115]} size={[0.4, 0.42, 0.23]} r={0.1} color={look.shirt} rough={0.9} opacity={o} />
        <Cyl at={[0, 0.94, 0]} radius={0.05} h={0.08} color={look.skin} rough={0.6} opacity={o} />
        <group ref={armL} position={[-0.25, 0.9, 0]}>
          <Limb y={-0.17} len={0.24} radius={0.052} color={look.shirt} opacity={o} />
          <mesh position={[0, -0.38, 0]} castShadow>
            <sphereGeometry args={[0.048, 14, 12]} />
            <Mat color={look.skin} rough={0.6} opacity={o} />
          </mesh>
        </group>
        <group ref={armR} position={[0.25, 0.9, 0]}>
          <Limb y={-0.17} len={0.24} radius={0.052} color={look.shirt} opacity={o} />
          <mesh position={[0, -0.38, 0]} castShadow>
            <sphereGeometry args={[0.048, 14, 12]} />
            <Mat color={look.skin} rough={0.6} opacity={o} />
          </mesh>
          <group ref={cup} visible={false}>
            <Cyl at={[0, -0.5, 0.06]} radius={0.045} h={0.11} color="#f4f2ec" rough={0.3} />
            <Cyl at={[0, -0.395, 0.06]} radius={0.04} h={0.005} color="#5a3a22" rough={0.2} />
          </group>
        </group>
        <group ref={head} position={[0, 0.98, 0]}>
          <mesh position={[0, 0.17, 0]} castShadow>
            <sphereGeometry args={[0.155, 28, 22]} />
            <Mat color={look.skin} rough={0.55} opacity={o} />
          </mesh>
          {/* Rambut: tudung yang menutup atas dan belakang kepala */}
          <mesh position={[0, 0.19, -0.012]} rotation={[-0.35, 0, 0]} castShadow>
            <sphereGeometry args={[0.165, 28, 18, 0, Math.PI * 2, 0, Math.PI * 0.55]} />
            <Mat color={look.hair} rough={0.8} opacity={o} />
          </mesh>
          {[-0.052, 0.052].map((ex) => (
            <mesh key={ex} position={[ex, 0.18, 0.142]}>
              <sphereGeometry args={[0.018, 10, 8]} />
              <Mat color="#15171a" rough={0.2} opacity={o} />
            </mesh>
          ))}
          <mesh position={[0, 0.15, 0.155]}>
            <sphereGeometry args={[0.022, 10, 8]} />
            <Mat color={look.skin} rough={0.6} opacity={o} />
          </mesh>
        </group>
        <group ref={paper} visible={false}>
          <Block at={[-0.13, 0.62, 0.22]} size={[0.26, 0.34, 0.012]} r={0.003} color="#fafaf6" rough={0.9} />
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
      <Canvas orthographic shadows dpr={[1, 2]} gl={{ antialias: true }} camera={{ position: [floor.w / 2 + 16, 16, floor.d / 2 + 16], zoom: 30, near: -100, far: 300 }}>
        <color attach="background" args={['#0e131b']} />
        <SoftShadows size={18} samples={10} focus={0.5} />
        <hemisphereLight args={['#dfe7f7', '#2b241d', 0.35]} />
        <ambientLight intensity={0.06} />
        <directionalLight position={[floor.w * 0.35 + 10, 26, floor.d + 12]} intensity={2.2} color="#ffe9cf" castShadow shadow-mapSize={[2048, 2048]} shadow-bias={-0.0004} shadow-normalBias={0.03}>
          <orthographicCamera attach="shadow-camera" args={[-30, 30, 30, -30, 1, 120]} />
        </directionalLight>
        {/* Lingkungan lokal (tanpa unduhan HDR) untuk pantulan logam dan kaca. */}
        <Environment resolution={128} frames={1}>
          <Lightformer form="rect" intensity={1.1} color="#ffffff" position={[0, 10, 0]} rotation-x={Math.PI / 2} scale={[30, 30, 1]} />
          <Lightformer form="rect" intensity={0.7} color="#ffe7c7" position={[-12, 4, -6]} rotation-y={Math.PI / 2} scale={[20, 6, 1]} />
          <Lightformer form="rect" intensity={0.5} color="#cfe0ff" position={[12, 4, 8]} rotation-y={-Math.PI / 2} scale={[20, 6, 1]} />
        </Environment>
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
