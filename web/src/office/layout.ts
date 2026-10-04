import { type Pt, type Rect, WalkGrid } from './pathfinding';

/**
 * Gedung modular. Setiap divisi punya ruangan sendiri yang ukurannya mengikuti jumlah stafnya;
 * ada Ruang Rapat, Pantry, dan Ruang Runtime. Divisi baru = ruangan baru, gedung otomatis membesar
 * (dan menambah lantai setelah FLOOR_DEPT_CAP divisi). Koordinat: 1 satuan = 1 ubin,
 * x ke kanan-bawah, z ke kiri-bawah (kamera isometrik), y ke atas.
 */

export interface LayoutDepartment {
  id: string;
  name: string;
  color: string;
}

export interface LayoutAgent {
  id: string;
  name: string;
  roleId: string;
  /** departments.id */
  department: string;
  isHead?: boolean;
}

/** Posisi duduk/berdiri beserta arah hadap (yaw; 0 = menghadap +z, ke arah kamera). */
export interface Seat extends Pt {
  yaw: number;
}

export interface DeskSlot {
  seat: Seat;
  desk: Rect;
}

export type RoomKind = 'department' | 'meeting' | 'pantry' | 'runtime';

export interface PantryLayout {
  counter: Rect;
  machine: Pt;
  coffeeSpot: Seat;
  cooler: Rect;
  table: Rect;
  chatSpots: [Seat, Seat];
  sofa: Rect;
  sofaSeats: Seat[];
  windowSpot: Seat;
}

export interface RoomLayout {
  id: string;
  kind: RoomKind;
  name: string;
  color: string;
  rect: Rect;
  /** Sisi pintu menuju koridor. */
  doorSide: 'top' | 'bottom';
  door: Rect;
  /** department */
  desks: DeskSlot[];
  /** meeting */
  table?: Rect;
  meetingSeats?: Seat[];
  whiteboard?: Rect;
  pantry?: PantryLayout;
  /** runtime */
  racks?: Rect[];
}

export interface FloorLayout {
  index: number;
  w: number;
  d: number;
  corridor: Rect;
  rooms: RoomLayout[];
  /** Segmen dinding rendah antar ruangan (sudah dikurangi celah pintu). */
  walls: Rect[];
  /** Dinding luar: geometri yang sama dipakai renderer dan collider. */
  shellWalls: Rect[];
  /** Posisi jendela di dinding belakang (x). */
  windows: number[];
  plants: Pt[];
  obstacles: Rect[];
  grid: WalkGrid;
  /** Kursi tiap karyawan di lantai ini. */
  seatOf: Map<string, Seat>;
  roomOf: Map<string, string>;
}

export interface BuildingLayout {
  floors: FloorLayout[];
  floorOf: Map<string, number>;
}

export const FLOOR_DEPT_CAP = 6;

const WALL = 0.15;
const DESK_PITCH_X = 2.6;
const DESK_PITCH_Z = 2.4;
const DOOR_BAND = 1.5;
const ROOM_GAP = 0.3;
const CORRIDOR = 2.4;
const ORIGIN = 0.6;

const ROLE_ORDER = ['ceo', 'cfo', 'cto', 'hrd', 'manager', 'researcher', 'market_researcher', 'content_writer'];
const rank = (roleId: string) => {
  const i = ROLE_ORDER.indexOf(roleId);
  return i === -1 ? ROLE_ORDER.length : i;
};

/** Kepala divisi dulu, lalu urutan role, lalu nama: kursi tiap karyawan tetap stabil. */
export function orderStaff(agents: LayoutAgent[]) {
  return [...agents].sort(
    (a, b) => Number(!!b.isHead) - Number(!!a.isHead) || rank(a.roleId) - rank(b.roleId) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  );
}

function gridShape(n: number) {
  const cols = n <= 4 ? 2 : n <= 9 ? 3 : 4;
  return { cols, rows: Math.ceil(n / cols) };
}

interface Plan {
  id: string;
  kind: RoomKind;
  name: string;
  color: string;
  w: number;
  d: number;
  staff: LayoutAgent[];
}

function planDepartment(dep: LayoutDepartment, staff: LayoutAgent[]): Plan {
  const n = Math.max(2, staff.length);
  const { cols, rows } = gridShape(n);
  return { id: dep.id, kind: 'department', name: dep.name, color: dep.color, w: cols * DESK_PITCH_X + 1.0, d: rows * DESK_PITCH_Z + DOOR_BAND + 0.4, staff };
}

function furnish(plan: Plan, rect: Rect, doorSide: 'top' | 'bottom'): RoomLayout {
  const cx = rect.x + rect.w / 2;
  const doorW = 2;
  const wallZ = doorSide === 'bottom' ? rect.z + rect.d : rect.z;
  const door: Rect = { x: cx - doorW / 2, z: wallZ - 0.5, w: doorW, d: 1 };
  const room: RoomLayout = { id: plan.id, kind: plan.kind, name: plan.name, color: plan.color, rect, doorSide, door, desks: [] };

  if (plan.kind === 'department') {
    const n = Math.max(2, plan.staff.length);
    const { cols } = gridShape(n);
    const firstZ = rect.z + (doorSide === 'top' ? DOOR_BAND : 0) + 0.9;
    for (let k = 0; k < n; k++) {
      const c = k % cols;
      const r = Math.floor(k / cols);
      const sx = rect.x + 0.5 + 1.3 + c * DESK_PITCH_X;
      const sz = firstZ + r * DESK_PITCH_Z;
      room.desks.push({ seat: { x: sx, z: sz, yaw: 0 }, desk: { x: sx - 0.9, z: sz + 0.4, w: 1.8, d: 0.8 } });
    }
  } else if (plan.kind === 'meeting') {
    const table: Rect = { x: cx - 2.8, z: rect.z + rect.d / 2 - 1.2, w: 5.6, d: 1.5 };
    room.table = table;
    room.meetingSeats = [];
    for (let k = 0; k < 4; k++) room.meetingSeats.push({ x: table.x + 0.7 + k * 1.4, z: table.z - 0.55, yaw: 0 });
    for (let k = 0; k < 4; k++) room.meetingSeats.push({ x: table.x + 0.7 + k * 1.4, z: table.z + table.d + 0.55, yaw: Math.PI });
    room.whiteboard = { x: cx - 1.3, z: rect.z + 0.2, w: 2.6, d: 0.1 };
  } else if (plan.kind === 'pantry') {
    const x = rect.x;
    const z = rect.z;
    room.pantry = {
      counter: { x: x + 0.6, z: z + 0.3, w: 3.2, d: 0.8 },
      machine: { x: x + 1.6, z: z + 0.7 },
      coffeeSpot: { x: x + 1.6, z: z + 1.5, yaw: Math.PI },
      cooler: { x: x + 4.4, z: z + 0.4, w: 0.5, d: 0.5 },
      table: { x: x + 4.2, z: z + 2.6, w: 1.2, d: 1.2 },
      chatSpots: [
        { x: x + 3.3, z: z + 3.2, yaw: Math.PI / 2 },
        { x: x + 6.0, z: z + 3.2, yaw: -Math.PI / 2 },
      ],
      sofa: { x: x + 0.5, z: z + 3.0, w: 0.9, d: 2.3 },
      sofaSeats: [
        { x: x + 0.95, z: z + 3.55, yaw: Math.PI / 2 },
        { x: x + 0.95, z: z + 4.5, yaw: Math.PI / 2 },
      ],
      windowSpot: { x: x + 5.6, z: z + 1.3, yaw: Math.PI },
    };
  } else {
    // Rak di sisi jauh dari pintu (pintu di atas → rak di bawah).
    room.racks = [0, 1, 2].map((i) => ({ x: rect.x + 0.6 + i * 1.15, z: rect.z + rect.d - 1.4, w: 0.9, d: 0.9 }));
  }
  return room;
}

/** Tembok tipis di sekeliling ruangan, dengan celah pintu pada sisi koridor. */
function wallsOf(room: RoomLayout): Rect[] {
  const { rect: r, door } = room;
  const t = WALL;
  const segs: Rect[] = [
    { x: r.x, z: r.z, w: t, d: r.d },
    { x: r.x + r.w - t, z: r.z, w: t, d: r.d },
  ];
  const horizontal = (z: number, gap: boolean): Rect[] =>
    gap
      ? [
          { x: r.x, z, w: door.x - r.x, d: t },
          { x: door.x + door.w, z, w: r.x + r.w - (door.x + door.w), d: t },
        ]
      : [{ x: r.x, z, w: r.w, d: t }];
  segs.push(...horizontal(r.z, room.doorSide === 'top'));
  segs.push(...horizontal(r.z + r.d - t, room.doorSide === 'bottom'));
  return segs;
}

function buildFloor(index: number, plans: Plan[], has: { meeting: boolean; runtime: boolean }): FloorLayout {
  const pantry: Plan = { id: 'pantry', kind: 'pantry', name: 'Pantry', color: '#a89a82', w: 7, d: 6, staff: [] };
  const meeting: Plan = { id: 'meeting', kind: 'meeting', name: 'Ruang Rapat', color: '#7b8aa5', w: 9, d: 7, staff: [] };
  const runtime: Plan = { id: 'runtime', kind: 'runtime', name: 'Ruang Runtime', color: '#5a6068', w: 4, d: 6.5, staff: [] };

  // Baris A (di atas koridor, pintu ke bawah) memuat fasilitas yang butuh jendela; divisi mengisi yang lebih pendek.
  const rowA: Plan[] = [...(has.meeting ? [meeting] : []), pantry];
  const rowB: Plan[] = [...(has.runtime ? [runtime] : [])];
  const width = (row: Plan[]) => row.reduce((s, p) => s + p.w + ROOM_GAP, 0);
  for (const p of plans) (width(rowA) <= width(rowB) ? rowA : rowB).push(p);

  const depthA = Math.max(...rowA.map((p) => p.d));
  const depthB = rowB.length ? Math.max(...rowB.map((p) => p.d)) : 0;
  const zA = ORIGIN;
  const corridorZ = zA + depthA + ROOM_GAP;
  const zB = corridorZ + CORRIDOR;
  const W = Math.max(width(rowA), width(rowB)) + ORIGIN + 0.6;
  const D = (depthB ? zB + depthB : corridorZ + CORRIDOR) + 0.6;

  const rooms: RoomLayout[] = [];
  const place = (row: Plan[], z: number, depth: number, side: 'top' | 'bottom') => {
    let x = ORIGIN;
    for (const p of row) {
      rooms.push(furnish(p, { x, z, w: p.w, d: depth }, side));
      x += p.w + ROOM_GAP;
    }
  };
  place(rowA, zA, depthA, 'bottom');
  place(rowB, zB, depthB, 'top');

  const corridor: Rect = { x: ORIGIN - 0.3, z: corridorZ - 0.15, w: W - ORIGIN, d: CORRIDOR + 0.3 };
  const grid = new WalkGrid(W, D);
  grid.openRect(corridor);
  const obstacles: Rect[] = [];
  const seatOf = new Map<string, Seat>();
  const roomOf = new Map<string, string>();

  for (const room of rooms) {
    grid.openRect({ x: room.rect.x + 0.25, z: room.rect.z + 0.25, w: room.rect.w - 0.5, d: room.rect.d - 0.5 });
    grid.openRect(room.door);
    if (room.kind === 'department') {
      const plan = plans.find((p) => p.id === room.id)!;
      orderStaff(plan.staff).forEach((a, i) => {
        const slot = room.desks[i];
        if (!slot) return;
        seatOf.set(a.id, slot.seat);
        roomOf.set(a.id, room.id);
      });
      obstacles.push(...room.desks.map((s) => s.desk));
    }
    if (room.table) obstacles.push(room.table);
    if (room.racks) obstacles.push(...room.racks);
    if (room.pantry) obstacles.push(room.pantry.counter, room.pantry.cooler, room.pantry.table, room.pantry.sofa);
  }
  const plants: Pt[] = [
    { x: ORIGIN + 0.4, z: corridorZ + CORRIDOR / 2 },
    { x: W - 1.2, z: corridorZ + CORRIDOR / 2 },
  ];
  obstacles.push(...plants.map((p) => ({ x: p.x - 0.25, z: p.z - 0.25, w: 0.5, d: 0.5 })));
  for (const o of obstacles) grid.blockRect(o, 0.1);
  const walls = rooms.flatMap(wallsOf);
  const shellWalls = [
    { x: -0.3, z: -0.3, w: W + 0.3, d: 0.25 },
    { x: -0.3, z: -0.05, w: 0.25, d: D + 0.05 },
  ];
  // Setelah pintu/interior dibuka: dinding fisik tidak boleh terbuka lagi oleh rasterisasi grid.
  grid.blockWalls([...walls, ...shellWalls]);
  for (const room of rooms) {
    if (!room.pantry) continue;
    for (const seat of room.pantry.sofaSeats) {
      const approach = { x: room.pantry.sofa.x + room.pantry.sofa.w + 0.6, z: seat.z };
      grid.registerSeat(seat, approach);
    }
  }

  const windows = rooms.filter((r) => r.doorSide === 'bottom').map((r) => (r.pantry ? r.rect.x + 5.6 : r.rect.x + r.rect.w / 2));
  return { index, w: W, d: D, corridor, rooms, walls, shellWalls, windows, plants, obstacles, grid, seatOf, roomOf };
}

/** Susun gedung dari divisi (berurutan) dan karyawan. Divisi tak dikenal dibuat sebagai ruangan sendiri. */
export function buildBuilding(departments: LayoutDepartment[], agents: LayoutAgent[]): BuildingLayout {
  const deps = [...departments];
  for (const a of agents) if (!deps.some((d) => d.id === a.department)) deps.push({ id: a.department, name: a.department, color: '#7f8896' });
  const byDept = new Map<string, LayoutAgent[]>();
  for (const a of agents) byDept.set(a.department, [...(byDept.get(a.department) ?? []), a]);

  const floors: FloorLayout[] = [];
  const floorOf = new Map<string, number>();
  const count = Math.max(1, Math.ceil(deps.length / FLOOR_DEPT_CAP));
  for (let f = 0; f < count; f++) {
    const slice = deps.slice(f * FLOOR_DEPT_CAP, (f + 1) * FLOOR_DEPT_CAP);
    const plans = slice.map((d) => planDepartment(d, byDept.get(d.id) ?? []));
    const floor = buildFloor(f, plans, { meeting: f === 0, runtime: f === 0 });
    floors.push(floor);
    for (const id of floor.seatOf.keys()) floorOf.set(id, f);
  }
  return { floors, floorOf };
}

export const roomById = (floor: FloorLayout, id: string) => floor.rooms.find((r) => r.id === id);
export const centerOf = (r: Rect): Pt => ({ x: r.x + r.w / 2, z: r.z + r.d / 2 });
