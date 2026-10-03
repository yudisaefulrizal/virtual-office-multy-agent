import { describe, expect, it } from 'vitest';
import { FLOOR_DEPT_CAP, buildBuilding, centerOf, orderStaff, type FloorLayout, type LayoutAgent, type LayoutDepartment, type Seat } from '../web/src/office/layout';
import type { Pt, Rect } from '../web/src/office/pathfinding';

const dept = (i: number): LayoutDepartment => ({ id: `d${i}`, name: `Divisi ${i}`, color: '#888888' });
const staff = (d: number, n: number, offset = 0): LayoutAgent[] =>
  Array.from({ length: n }, (_, k) => ({ id: `a-${d}-${k + offset}`, name: `Staf ${d}.${k}`, roleId: k === 0 ? 'manager' : 'content_writer', department: `d${d}`, isHead: k === 0 }));

const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.z < b.z + b.d && b.z < a.z + a.d;
const inside = (p: Pt, r: Rect) => p.x >= r.x && p.x <= r.x + r.w && p.z >= r.z && p.z <= r.z + r.d;

function checkFloor(f: FloorLayout) {
  // Ruangan tidak boleh tumpang-tindih.
  for (let i = 0; i < f.rooms.length; i++)
    for (let j = i + 1; j < f.rooms.length; j++) expect(overlaps(f.rooms[i]!.rect, f.rooms[j]!.rect), `${f.rooms[i]!.id} x ${f.rooms[j]!.id}`).toBe(false);
  // Semua ruangan di dalam gedung.
  for (const r of f.rooms) expect(r.rect.x + r.rect.w).toBeLessThanOrEqual(f.w);
  for (const r of f.rooms) expect(r.rect.z + r.rect.d).toBeLessThanOrEqual(f.d);

  const hall: Pt = { x: f.corridor.x + f.corridor.w / 2, z: f.corridor.z + f.corridor.d / 2 };
  const targets: [string, Seat | Pt][] = [];
  for (const r of f.rooms) {
    r.desks.forEach((s, i) => targets.push([`${r.id} meja ${i}`, s.seat]));
    r.meetingSeats?.forEach((s, i) => targets.push([`rapat ${i}`, s]));
    if (r.pantry) {
      targets.push(['kopi', r.pantry.coffeeSpot], ['jendela', r.pantry.windowSpot], ['obrol 1', r.pantry.chatSpots[0]], ['obrol 2', r.pantry.chatSpots[1]]);
      r.pantry.sofaSeats.forEach((s, i) => targets.push([`sofa ${i}`, s]));
    }
  }
  for (const [name, p] of targets) {
    expect(f.grid.isReachable(hall, p), `${name} terjangkau dari koridor`).toBe(true);
    const path = f.grid.findPath(hall, p);
    expect(path, name).not.toBeNull();
    // Setiap ruas jalur bebas hambatan (tidak menembus dinding/perabot).
    for (let i = 0; i < path!.length - 1; i++) expect(f.grid.lineClear(path![i]!, path![i + 1]!) || i === path!.length - 2, `${name} ruas ${i}`).toBe(true);
  }
  // Meja tidak boleh di luar interior ruangannya.
  for (const r of f.rooms) for (const s of r.desks) expect(inside(s.seat, r.rect) && inside({ x: s.desk.x, z: s.desk.z }, r.rect) && inside({ x: s.desk.x + s.desk.w, z: s.desk.z + s.desk.d }, r.rect)).toBe(true);
}

describe('tata letak gedung', () => {
  it('kantor awal: 4 divisi, rapat + pantry + runtime, semua kursi terjangkau', () => {
    const deps = [0, 1, 2, 3].map(dept);
    const agents = [...staff(0, 4), ...staff(1, 2), ...staff(2, 1), ...staff(3, 1)];
    const b = buildBuilding(deps, agents);
    expect(b.floors).toHaveLength(1);
    const f = b.floors[0]!;
    expect(f.rooms.map((r) => r.id).sort()).toEqual(['d0', 'd1', 'd2', 'd3', 'meeting', 'pantry', 'runtime']);
    expect(f.seatOf.size).toBe(8);
    checkFloor(f);
  });

  it('ukuran ruangan mengikuti jumlah staf dan semua variasi tetap valid', () => {
    for (const n of [0, 1, 2, 3, 4, 5, 6, 9, 10, 13]) {
      const b = buildBuilding([dept(0), dept(1)], [...staff(0, n), ...staff(1, 2)]);
      checkFloor(b.floors[0]!);
      expect(b.floors[0]!.seatOf.size).toBe(n + 2);
    }
    const small = buildBuilding([dept(0)], staff(0, 2)).floors[0]!.rooms.find((r) => r.id === 'd0')!;
    const big = buildBuilding([dept(0)], staff(0, 12)).floors[0]!.rooms.find((r) => r.id === 'd0')!;
    expect(big.rect.w * big.rect.d).toBeGreaterThan(small.rect.w * small.rect.d * 2);
  });

  it('divisi baru = ruangan baru; lebih dari batas divisi → lantai baru tanpa rapat/runtime', () => {
    const deps = Array.from({ length: FLOOR_DEPT_CAP + 3 }, (_, i) => dept(i));
    const agents = deps.flatMap((d, i) => staff(i, 2));
    const b = buildBuilding(deps, agents);
    expect(b.floors).toHaveLength(2);
    expect(b.floors[0]!.rooms.filter((r) => r.kind === 'department')).toHaveLength(FLOOR_DEPT_CAP);
    expect(b.floors[1]!.rooms.filter((r) => r.kind === 'department')).toHaveLength(3);
    expect(b.floors[1]!.rooms.some((r) => r.kind === 'meeting')).toBe(false);
    expect(b.floors[1]!.rooms.some((r) => r.kind === 'pantry')).toBe(true); // tiap lantai punya pantry
    expect(b.floorOf.get('a-8-0')).toBe(1);
    expect(b.floorOf.get('a-0-0')).toBe(0);
    b.floors.forEach(checkFloor);
  });

  it('tiap karyawan punya kursi sendiri di ruangan divisinya; kepala divisi di kursi pertama', () => {
    const agents = staff(0, 5);
    const b = buildBuilding([dept(0)], agents);
    const f = b.floors[0]!;
    const seats = agents.map((a) => f.seatOf.get(a.id)!);
    expect(new Set(seats.map((s) => `${s.x},${s.z}`)).size).toBe(5);
    expect(f.roomOf.get(agents[0]!.id)).toBe('d0');
    const head = orderStaff(agents)[0]!;
    expect(head.isHead).toBe(true);
    expect(f.seatOf.get(head.id)).toEqual(f.rooms.find((r) => r.id === 'd0')!.desks[0]!.seat);
  });

  it('divisi yang tidak terdaftar tetap mendapat ruangan', () => {
    const b = buildBuilding([dept(0)], [...staff(0, 1), { id: 'x', name: 'X', roleId: 'zz', department: 'tak-dikenal' }]);
    expect(b.floors[0]!.rooms.some((r) => r.id === 'tak-dikenal')).toBe(true);
  });

  it('pathfinding: berjalan dari kursi ke kursi lain lewat pintu dan koridor, tidak menembus dinding', () => {
    const deps = [0, 1, 2].map(dept);
    const agents = [...staff(0, 3), ...staff(1, 3), ...staff(2, 3)];
    const f = buildBuilding(deps, agents).floors[0]!;
    const a = f.seatOf.get('a-0-1')!;
    const z = f.seatOf.get('a-2-2')!;
    const path = f.grid.findPath(a, z)!;
    expect(path[0]).toEqual(a);
    expect(path.at(-1)).toEqual(z);
    expect(path.length).toBeGreaterThan(2); // harus berbelok lewat pintu
    // Harus melewati koridor.
    expect(path.some((p) => inside(p, f.corridor))).toBe(true);
    // Jalur lurus langsung (menembus dinding) tidak diperbolehkan.
    expect(f.grid.lineClear(a, z)).toBe(false);
    void centerOf;
  });
});
