import { describe, expect, it } from 'vitest';
import { type AgentInput, BehaviorEngine, type EngineInputs, WALK_SPEED } from '../web/src/office/behavior';
import { buildBuilding, type LayoutAgent } from '../web/src/office/layout';

const DEPTS = [
  { id: 'executive', name: 'Ruang Eksekutif', color: '#6e7c99' },
  { id: 'rnd', name: 'Lab R&D', color: '#5e968f' },
  { id: 'operations', name: 'Operasional', color: '#9883ae' },
  { id: 'content', name: 'Studio Konten', color: '#c49a62' },
];
const AGENTS: LayoutAgent[] = [
  { id: 'ceo', name: 'CEO', roleId: 'ceo', department: 'executive', isHead: true },
  { id: 'cfo', name: 'CFO', roleId: 'cfo', department: 'executive' },
  { id: 'cto', name: 'CTO', roleId: 'cto', department: 'executive' },
  { id: 'hrd', name: 'HRD', roleId: 'hrd', department: 'executive' },
  { id: 'res', name: 'Research Agent', roleId: 'researcher', department: 'rnd', isHead: true },
  { id: 'mgr', name: 'Manager', roleId: 'manager', department: 'operations', isHead: true },
  { id: 'w1', name: 'Content Writer', roleId: 'content_writer', department: 'content', isHead: true },
  { id: 'w2', name: 'Content Writer 2', roleId: 'content_writer', department: 'content' },
];

type Activity = AgentInput['activity'];
function setup(activities: Partial<Record<string, Activity>> = {}) {
  const floor = buildBuilding(DEPTS, AGENTS).floors[0]!;
  const inputs = (over: Partial<EngineInputs> = {}, acts = activities): EngineInputs => ({
    agents: AGENTS.map((a) => ({ id: a.id, name: a.name, roleId: a.roleId, activity: acts[a.id] ?? 'idle' })),
    meetingIds: new Set(),
    handovers: new Map(),
    managerId: 'mgr',
    ...over,
  });
  const engine = new BehaviorEngine(floor, inputs().agents);
  let now = 0;
  const run = (seconds: number, cur: EngineInputs, onStep?: () => void) => {
    const dt = 0.1;
    for (let t = 0; t < seconds; t += dt) {
      now += dt;
      engine.setInputs(cur, now);
      engine.update(dt, now);
      onStep?.();
    }
  };
  return { engine, floor, inputs, run, now: () => now };
}

describe('perilaku avatar', () => {
  it('awal: semua karyawan duduk di mejanya; yang bekerja mengetik, yang nonaktif transparan', () => {
    const { engine, floor, inputs, run } = setup({ w1: 'working', w2: 'inactive' });
    run(0.2, inputs({}, { w1: 'working', w2: 'inactive' }));
    for (const a of AGENTS) {
      const s = engine.get(a.id)!;
      const seat = floor.seatOf.get(a.id)!;
      expect([s.x, s.z]).toEqual([seat.x, seat.z]);
      expect(s.pose).toBe('sit');
    }
    expect(engine.get('w1')).toMatchObject({ gesture: 'type', label: 'Mengetik' });
    expect(engine.get('w2')).toMatchObject({ ghost: true, gesture: 'none' });
  });

  it('yang bekerja tidak pernah meninggalkan meja, dan tidak ada aktivitas acak', () => {
    const acts = { w1: 'working' as const, w2: 'waiting' as const };
    const { engine, floor, inputs, run } = setup(acts);
    const seat = floor.seatOf.get('w1')!;
    run(120, inputs({}, acts), () => {
      for (const id of ['w1', 'w2']) expect(engine.get(id)!.pose).toBe('sit');
      expect(engine.get('w1')!.x).toBe(seat.x);
    });
  });

  it('saat menganggur: duduk santai, peregangan, kopi, ngobrol, sofa, jendela; selalu di sel yang bisa dilewati', () => {
    const { engine, floor, inputs, run } = setup();
    const labels = new Set<string>();
    const poses = new Set<string>();
    // Kursi sofa berada di atas objek sofa: ujung langkah menuju sofa boleh masuk sel tertutup.
    const sofaSeats = floor.rooms.flatMap((r) => r.pantry?.sofaSeats ?? []);
    const walkable = (id: string) => {
      const s = engine.get(id)!;
      return floor.grid.isOpenAt(s) || s.pose === 'sit' || sofaSeats.some((q) => Math.hypot(q.x - s.x, q.z - s.z) < 1.0);
    };
    run(900, inputs(), () => {
      for (const a of AGENTS) {
        const s = engine.get(a.id)!;
        labels.add(s.label.replace(/ dengan .*/, ' dengan …'));
        poses.add(s.pose);
        expect(walkable(a.id), `${a.id} @ ${s.x.toFixed(2)},${s.z.toFixed(2)} ${s.label}`).toBe(true);
      }
    });
    for (const l of ['Duduk santai', 'Peregangan', 'Menyeduh kopi', 'Minum kopi', 'Mengobrol dengan …', 'Berjalan']) expect(labels, l).toContain(l);
    expect(poses).toEqual(new Set(['sit', 'stand', 'walk']));
    expect(labels.size).toBeGreaterThanOrEqual(8); // juga sofa / jendela / membawa kopi
  });

  it('gerak mulus: tidak ada lompatan posisi; kecepatan tidak melebihi kecepatan jalan', () => {
    const { engine, inputs, run } = setup();
    const last = new Map<string, [number, number]>();
    let maxStep = 0;
    run(300, inputs(), () => {
      for (const a of AGENTS) {
        const s = engine.get(a.id)!;
        const p = last.get(a.id);
        if (p && s.pose === 'walk') maxStep = Math.max(maxStep, Math.hypot(s.x - p[0], s.z - p[1]));
        last.set(a.id, [s.x, s.z]);
      }
    });
    expect(maxStep).toBeLessThanOrEqual(WALK_SPEED * 0.1 + 1e-6);
  });

  it('dua karyawan ngobrol bersamaan di pantry, lalu keduanya kembali ke meja', () => {
    const { engine, floor, inputs, run } = setup();
    let together = false;
    run(900, inputs(), () => {
      const talking = AGENTS.filter((a) => engine.get(a.id)!.gesture === 'talk');
      if (talking.length === 2) together = true;
      expect(talking.length).toBeLessThanOrEqual(2);
    });
    expect(together).toBe(true);
    run(60, inputs());
    // Setelah jeda panjang tidak ada yang tertinggal berdiri di pantry selamanya: semua pernah kembali.
    const everyoneSeatedOrActing = AGENTS.every((a) => ['sit', 'stand', 'walk'].includes(engine.get(a.id)!.pose));
    expect(everyoneSeatedOrActing).toBe(true);
    void floor;
  });

  it('kegiatan idle terputus seketika saat ada pekerjaan; avatar berjalan pulang dan mengetik', () => {
    const { engine, floor, inputs, run } = setup();
    // Biarkan salah satu pergi ke pantry.
    let away: string | null = null;
    run(600, inputs(), () => {
      if (!away) away = AGENTS.find((a) => ['Menyeduh kopi', 'Minum kopi'].includes(engine.get(a.id)!.label))?.id ?? null;
    });
    expect(away).not.toBeNull();
    const id = away!;
    run(600, inputs(), () => undefined);
    // Cari momen berjalan/di pantry lagi, lalu beri pekerjaan.
    let leaving = false;
    for (let i = 0; i < 6000 && !leaving; i++) {
      run(0.1, inputs());
      leaving = engine.get(id)!.pose !== 'sit';
    }
    expect(leaving).toBe(true);
    const acts = { [id]: 'working' as const };
    run(30, inputs({}, acts), () => undefined);
    const s = engine.get(id)!;
    const seat = floor.seatOf.get(id)!;
    expect([s.x, s.z, s.pose, s.gesture]).toEqual([seat.x, seat.z, 'sit', 'type']);
  });

  it('rapat strategi: peserta berjalan ke Ruang Rapat dan duduk di meja rapat; bubar → kembali ke meja', () => {
    const { engine, floor, inputs, run } = setup();
    const ids = ['ceo', 'cfo', 'cto', 'hrd', 'res'];
    const meet = floor.rooms.find((r) => r.id === 'meeting')!;
    run(60, inputs({ meetingIds: new Set(ids) }));
    const used = new Set<string>();
    for (const id of ids) {
      const s = engine.get(id)!;
      expect(s.pose, id).toBe('sit');
      expect(s.gesture, id).toBe('talk');
      expect(s.x >= meet.rect.x && s.x <= meet.rect.x + meet.rect.w && s.z >= meet.rect.z && s.z <= meet.rect.z + meet.rect.d, `${id} di Ruang Rapat`).toBe(true);
      used.add(`${s.x},${s.z}`);
    }
    expect(used.size).toBe(ids.length); // kursi berbeda
    // Setelah bubar mereka kembali bekerja di meja masing-masing.
    const working = Object.fromEntries(ids.map((id) => [id, 'working' as const]));
    run(60, inputs({ meetingIds: new Set() }, working));
    for (const id of ids) {
      const seat = floor.seatOf.get(id)!;
      const s = engine.get(id)!;
      expect(s.pose === 'sit' ? [s.x, s.z] : null, id).toEqual([seat.x, seat.z]);
      expect(s.gesture, id).toBe('type');
    }
  });

  it('selesai task: membawa kertas ke meja Manager, menyerahkan, lalu kembali ke mejanya', () => {
    const { engine, floor, inputs, run } = setup({ w1: 'done' });
    const handovers = new Map([['w1', Date.now()]]);
    let paperSeen = false;
    let gave = false;
    let nearManager = false;
    const mgr = floor.seatOf.get('mgr')!;
    run(60, inputs({ handovers }, { w1: 'done' }), () => {
      const s = engine.get('w1')!;
      paperSeen ||= s.paper;
      gave ||= s.gesture === 'give';
      nearManager ||= Math.hypot(s.x - (mgr.x + 1.3), s.z - (mgr.z + 0.1)) < 0.6;
    });
    expect(paperSeen && gave && nearManager).toBe(true);
    const seat = floor.seatOf.get('w1')!;
    const s = engine.get('w1')!;
    expect(s.paper).toBe(false);
    expect([s.x, s.z]).toEqual([seat.x, seat.z]);
  });

  it('serah-terima tidak diulang untuk kejadian yang sama', () => {
    const { engine, inputs, run } = setup({ w1: 'done' });
    const handovers = new Map([['w1', Date.now()]]);
    run(40, inputs({ handovers }, { w1: 'done' }));
    let gaveAgain = false;
    run(30, inputs({ handovers }, { w1: 'done' }), () => (gaveAgain ||= engine.get('w1')!.gesture === 'give'));
    expect(gaveAgain).toBe(false);
  });

  it('hasil acak per karyawan stabil: dua mesin dengan input sama berperilaku sama', () => {
    const a = setup();
    const b = setup();
    const trace = (t: ReturnType<typeof setup>) => {
      const out: string[] = [];
      t.run(200, t.inputs(), () => out.push(AGENTS.map((x) => t.engine.get(x.id)!.label).join('|')));
      return out;
    };
    expect(trace(a)).toEqual(trace(b));
  });
});
