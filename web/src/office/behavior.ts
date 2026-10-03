import type { FloorLayout, PantryLayout, Seat } from './layout';
import type { Pt } from './pathfinding';

/**
 * Perilaku avatar di satu lantai. Murni kosmetik dan berjalan di browser: tidak memakai server
 * dan tidak memakai kuota. Prioritas selalu mengikuti kondisi nyata, jadi tampilan tidak menipu:
 * rapat > serah-terima hasil > bekerja di meja > aktivitas acak (hanya saat benar-benar menganggur).
 */

export type Pose = 'stand' | 'sit' | 'walk';
export type Gesture = 'none' | 'type' | 'idle' | 'drink' | 'brew' | 'stretch' | 'talk' | 'look' | 'give';
export type Activity = 'working' | 'waiting' | 'done' | 'idle' | 'inactive' | 'blocked';

export interface AgentState {
  x: number;
  z: number;
  yaw: number;
  pose: Pose;
  gesture: Gesture;
  cup: boolean;
  paper: boolean;
  /** Kegiatan saat ini, untuk panel detail. */
  label: string;
  /** Gelembung singkat di atas kepala (hanya untuk perilaku acak/rapat). */
  bubble: string | null;
  ghost: boolean;
}

export interface AgentInput {
  id: string;
  name: string;
  roleId: string;
  activity: Activity;
}

export interface EngineInputs {
  agents: AgentInput[];
  /** Karyawan yang sedang rapat strategi. */
  meetingIds: ReadonlySet<string>;
  /** Karyawan yang baru menyelesaikan task → waktu selesai (ms epoch). */
  handovers: ReadonlyMap<string, number>;
  managerId: string | null;
}

interface Rendezvous {
  arrived: Set<string>;
  need: number;
  startedAt: number | null;
  cancelled: boolean;
}

type Step =
  | { t: 'stand' }
  | { t: 'walk'; to: Pt; yaw?: number; cup?: boolean; paper?: boolean }
  | { t: 'sit'; seat: Seat }
  | { t: 'act'; gesture: Gesture; seconds: number; label: string; bubble?: string | null; cup?: boolean; paper?: boolean }
  | { t: 'meet'; spot: Seat; group: Rendezvous; seconds: number; label: string; partner: string };

type Mode = 'ghost' | 'meeting' | 'handover' | 'desk' | 'idle';

interface Mind extends AgentState {
  id: string;
  name: string;
  roleId: string;
  home: Seat;
  input: AgentInput;
  mode: Mode;
  queue: Step[];
  step: Step | null;
  path: Pt[];
  pathIdx: number;
  actEnds: number;
  nextIdleAt: number;
  seatedAt: Seat | null;
  rng: () => number;
  group: Rendezvous | null;
}

export const WALK_SPEED = 1.7;
/** Berapa lama setelah selesai task avatar masih dianggap perlu menyerahkan hasil. */
export const HANDOVER_WINDOW_MS = 9000;

const ROLE_ORDER = ['ceo', 'cfo', 'cto', 'hrd', 'manager', 'researcher', 'market_researcher', 'content_writer'];
const roleRank = (r: string) => (ROLE_ORDER.indexOf(r) === -1 ? 99 : ROLE_ORDER.indexOf(r));

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

const ACTIVITY_LABEL: Record<Activity, string> = {
  working: 'Mengetik',
  waiting: 'Menunggu giliran',
  blocked: 'Ditunda',
  done: 'Duduk santai',
  idle: 'Duduk santai',
  inactive: 'Nonaktif',
};

export class BehaviorEngine {
  private minds = new Map<string, Mind>();
  /** Tempat yang sedang dipakai (kopi, jendela, sofa, ...): satu orang per tempat. */
  private claims = new Map<string, string>();
  private doneHandovers = new Set<string>();
  private inputs: EngineInputs = { agents: [], meetingIds: new Set(), handovers: new Map(), managerId: null };
  private pantry: PantryLayout | undefined;
  private meetingSeats: Seat[];
  private time = 0;

  constructor(
    private floor: FloorLayout,
    agents: AgentInput[],
  ) {
    this.pantry = floor.rooms.find((r) => r.pantry)?.pantry;
    this.meetingSeats = floor.rooms.find((r) => r.meetingSeats)?.meetingSeats ?? [];
    for (const a of agents) {
      const home = floor.seatOf.get(a.id);
      if (!home) continue;
      this.minds.set(a.id, {
        id: a.id,
        name: a.name,
        roleId: a.roleId,
        home,
        input: a,
        mode: 'desk',
        queue: [],
        step: null,
        path: [],
        pathIdx: 0,
        actEnds: 0,
        nextIdleAt: 2 + (hash(a.id) % 1000) / 100,
        seatedAt: home,
        rng: mulberry32(hash(a.id)),
        group: null,
        x: home.x,
        z: home.z,
        yaw: home.yaw,
        pose: 'sit',
        gesture: 'idle',
        cup: false,
        paper: false,
        label: ACTIVITY_LABEL[a.activity],
        bubble: null,
        ghost: a.activity === 'inactive',
      });
    }
  }

  get(id: string): AgentState | undefined {
    return this.minds.get(id);
  }
  ids() {
    return [...this.minds.keys()];
  }

  /** Sinkronkan dengan kondisi nyata. Murah; aman dipanggil tiap frame. */
  setInputs(inputs: EngineInputs, now: number) {
    this.inputs = inputs;
    this.time = now;
    for (const a of inputs.agents) {
      const m = this.minds.get(a.id);
      if (!m) continue;
      m.input = a;
      m.name = a.name;
      const desired = this.desiredMode(m);
      if (desired !== m.mode) this.applyMode(m, desired, now);
      else this.refreshSeated(m);
    }
  }

  private handoverKey(m: Mind) {
    const start = this.inputs.handovers.get(m.id);
    if (start === undefined || Date.now() - start > HANDOVER_WINDOW_MS) return null;
    const key = `${m.id}:${start}`;
    return this.doneHandovers.has(key) ? null : key;
  }

  private desiredMode(m: Mind): Mode {
    if (m.input.activity === 'inactive') return 'ghost';
    if (this.inputs.meetingIds.has(m.id) && this.meetingSeats.length > 0) return 'meeting';
    if (m.mode === 'handover' && (m.step || m.queue.length)) return 'handover';
    if (this.handoverKey(m) && this.managerSpot(m)) return 'handover';
    const a = m.input.activity;
    return a === 'working' || a === 'waiting' || a === 'blocked' ? 'desk' : 'idle';
  }

  private managerSpot(m: Mind): Seat | null {
    const id = this.inputs.managerId;
    if (!id || id === m.id) return null;
    const seat = this.floor.seatOf.get(id);
    return seat ? { x: seat.x + 1.3, z: seat.z + 0.1, yaw: -Math.PI / 2 } : null;
  }

  private release(m: Mind) {
    for (const [k, v] of this.claims) if (v === m.id) this.claims.delete(k);
    if (m.group) {
      m.group.cancelled = true;
      m.group = null;
    }
  }

  private goHome(m: Mind): Step[] {
    return [{ t: 'stand' }, { t: 'walk', to: m.home, yaw: m.home.yaw }, { t: 'sit', seat: m.home }];
  }

  private applyMode(m: Mind, mode: Mode, now: number): void {
    this.release(m);
    m.mode = mode;
    m.queue = [];
    m.step = null;
    m.bubble = null;
    m.paper = false;
    switch (mode) {
      case 'ghost':
        this.snapHome(m);
        m.ghost = true;
        m.label = ACTIVITY_LABEL.inactive;
        return;
      case 'meeting': {
        m.ghost = false;
        const order = this.inputs.agents.filter((a) => this.inputs.meetingIds.has(a.id) && this.minds.has(a.id)).sort((a, b) => roleRank(a.roleId) - roleRank(b.roleId) || a.id.localeCompare(b.id));
        const i = Math.max(0, order.findIndex((a) => a.id === m.id));
        const seat = this.meetingSeats[i % this.meetingSeats.length]!;
        m.queue = [...(m.seatedAt === seat ? [] : [{ t: 'stand' } as Step, { t: 'walk', to: seat, yaw: seat.yaw } as Step, { t: 'sit', seat } as Step])];
        m.label = 'Menuju Ruang Rapat';
        return;
      }
      case 'handover': {
        m.ghost = false;
        const key = this.handoverKey(m);
        const spot = this.managerSpot(m);
        if (!key || !spot) return this.applyMode(m, this.desiredMode({ ...m, mode: 'idle' } as Mind), now);
        this.doneHandovers.add(key);
        m.queue = [
          { t: 'stand' },
          { t: 'walk', to: spot, yaw: spot.yaw, paper: true },
          { t: 'act', gesture: 'give', seconds: 2.2, label: 'Menyerahkan hasil ke Manager', paper: true },
          { t: 'walk', to: m.home, yaw: m.home.yaw },
          { t: 'sit', seat: m.home },
        ];
        m.label = 'Menyerahkan hasil ke Manager';
        return;
      }
      case 'desk':
        m.ghost = false;
        if (m.seatedAt !== m.home) m.queue = this.goHome(m);
        this.refreshSeated(m);
        return;
      case 'idle':
        m.ghost = false;
        if (m.seatedAt !== m.home) m.queue = this.goHome(m);
        m.nextIdleAt = now + 3 + m.rng() * 6;
        this.refreshSeated(m);
        return;
    }
  }

  private snapHome(m: Mind) {
    Object.assign(m, { x: m.home.x, z: m.home.z, yaw: m.home.yaw, pose: 'sit' as Pose, gesture: 'none' as Gesture, seatedAt: m.home, cup: false, paper: false });
  }

  /** Karyawan yang duduk di mejanya: gerakan tangan mengikuti pekerjaannya. */
  private refreshSeated(m: Mind) {
    if (m.step || m.queue.length || m.pose !== 'sit') return;
    if (m.mode === 'meeting' && m.seatedAt !== m.home) {
      m.gesture = 'talk';
      m.label = 'Rapat strategi';
      m.bubble = null;
      return;
    }
    if (m.seatedAt !== m.home) return;
    if (m.mode === 'desk') {
      m.gesture = m.input.activity === 'working' ? 'type' : 'idle';
      m.label = ACTIVITY_LABEL[m.input.activity];
    } else if (m.mode === 'idle' && m.nextIdleAt !== Infinity) {
      m.gesture = 'idle';
      m.label = ACTIVITY_LABEL[m.input.activity];
    }
  }

  update(dt: number, now: number) {
    this.time = now;
    for (const m of this.minds.values()) this.tick(m, dt, now);
  }

  private tick(m: Mind, dt: number, now: number) {
    if (m.mode === 'ghost') return;
    if (!m.step) {
      m.step = m.queue.shift() ?? null;
      if (m.step) this.begin(m, m.step, now);
    }
    if (m.step) this.advance(m, m.step, dt, now);
    if (m.step) return;

    if (m.queue.length) return;
    // Antrean habis.
    if (m.mode === 'handover') return this.applyMode(m, this.desiredMode({ ...m, mode: 'idle' } as Mind), now);
    this.refreshSeated(m);
    if (m.mode === 'idle' && m.seatedAt === m.home) {
      if (m.nextIdleAt === Infinity) {
        // Perilaku acak selesai dan sudah kembali ke meja.
        this.release(m);
        m.nextIdleAt = now + 5 + m.rng() * 12;
      } else if (now >= m.nextIdleAt) {
        this.startRandomBehavior(m, now);
      }
    }
  }

  private begin(m: Mind, s: Step, now: number) {
    switch (s.t) {
      case 'stand':
        m.pose = 'stand';
        m.gesture = 'none';
        m.seatedAt = null;
        m.step = null;
        return;
      case 'sit':
        Object.assign(m, { x: s.seat.x, z: s.seat.z, yaw: s.seat.yaw, pose: 'sit' as Pose, seatedAt: s.seat, cup: false, paper: false });
        m.step = null;
        return;
      case 'walk': {
        m.cup = !!s.cup;
        m.paper = !!s.paper;
        const path = this.floor.grid.findPath({ x: m.x, z: m.z }, s.to);
        if (!path || path.length < 2) {
          // Tidak terjangkau: langsung tiba (tidak boleh terjadi pada tata letak yang valid).
          Object.assign(m, { x: s.to.x, z: s.to.z });
          m.step = null;
          return;
        }
        m.path = path;
        m.pathIdx = 1;
        m.pose = 'walk';
        m.gesture = 'none';
        m.seatedAt = null;
        m.bubble = null;
        m.label = m.paper ? 'Membawa hasil kerja' : m.cup ? 'Membawa kopi' : 'Berjalan';
        return;
      }
      case 'act':
        m.gesture = s.gesture;
        m.label = s.label;
        m.bubble = s.bubble ?? null;
        m.cup = !!s.cup;
        m.paper = !!s.paper;
        m.actEnds = now + s.seconds;
        return;
      case 'meet':
        m.pose = 'stand';
        m.gesture = 'idle';
        m.yaw = s.spot.yaw;
        m.label = `Menunggu ${s.partner}`;
        s.group.arrived.add(m.id);
        m.group = s.group;
        m.actEnds = now + 25; // batas tunggu bila rekan tidak datang
        return;
    }
  }

  private advance(m: Mind, s: Step, dt: number, now: number) {
    if (s.t === 'walk') {
      let budget = WALK_SPEED * dt;
      while (budget > 0 && m.pathIdx < m.path.length) {
        const target = m.path[m.pathIdx]!;
        const dx = target.x - m.x;
        const dz = target.z - m.z;
        const dist = Math.hypot(dx, dz);
        if (dist > 0.001) m.yaw = Math.atan2(dx, dz);
        if (dist <= budget) {
          m.x = target.x;
          m.z = target.z;
          budget -= dist;
          m.pathIdx++;
        } else {
          m.x += (dx / dist) * budget;
          m.z += (dz / dist) * budget;
          budget = 0;
        }
      }
      if (m.pathIdx >= m.path.length) {
        m.pose = 'stand';
        m.gesture = 'none';
        if (s.yaw !== undefined) m.yaw = s.yaw;
        m.step = null;
      }
      return;
    }
    if (s.t === 'act') {
      if (now >= m.actEnds) {
        m.bubble = null;
        m.step = null;
      }
      return;
    }
    if (s.t === 'meet') {
      const g = s.group;
      // Rekan tidak datang dalam batas tunggu, atau rekan membatalkan: bubar.
      if (g.cancelled || (g.startedAt === null && now >= m.actEnds)) {
        m.bubble = null;
        m.step = null;
        return;
      }
      if (g.startedAt === null && g.arrived.size >= g.need) g.startedAt = now;
      if (g.startedAt !== null) {
        m.gesture = 'talk';
        m.label = s.label;
        m.bubble = 'Ngobrol';
        if (now >= g.startedAt + s.seconds) m.step = null;
      }
    }
  }

  private idleAndHome(m: Mind) {
    return m.mode === 'idle' && !m.step && m.queue.length === 0 && m.seatedAt === m.home && m.nextIdleAt !== Infinity;
  }

  private claim(m: Mind, key: string) {
    const owner = this.claims.get(key);
    if (owner && owner !== m.id) return false;
    this.claims.set(key, m.id);
    return true;
  }

  private startRandomBehavior(m: Mind, now: number) {
    const p = this.pantry;
    type Option = { weight: number; run: () => Step[] | null };
    const options: Option[] = [
      { weight: 3, run: () => [{ t: 'act', gesture: 'idle', seconds: 6 + m.rng() * 6, label: 'Duduk santai' }] },
      { weight: 2, run: () => [{ t: 'stand' }, { t: 'act', gesture: 'stretch', seconds: 3.4, label: 'Peregangan' }, { t: 'sit', seat: m.home }] },
    ];
    if (p) {
      options.push(
        {
          weight: 3,
          run: () =>
            this.claim(m, 'coffee')
              ? [
                  { t: 'stand' },
                  { t: 'walk', to: p.coffeeSpot, yaw: p.coffeeSpot.yaw },
                  { t: 'act', gesture: 'brew', seconds: 4.2, label: 'Menyeduh kopi', bubble: 'Kopi dulu' },
                  { t: 'act', gesture: 'drink', seconds: 5.5, label: 'Minum kopi', cup: true },
                  { t: 'walk', to: m.home, yaw: m.home.yaw, cup: true },
                  { t: 'sit', seat: m.home },
                ]
              : null,
        },
        {
          weight: 1,
          run: () =>
            this.claim(m, 'window')
              ? [
                  { t: 'stand' },
                  { t: 'walk', to: p.windowSpot, yaw: p.windowSpot.yaw },
                  { t: 'act', gesture: 'look', seconds: 6, label: 'Melihat keluar jendela' },
                  { t: 'walk', to: m.home, yaw: m.home.yaw },
                  { t: 'sit', seat: m.home },
                ]
              : null,
        },
        {
          weight: 1.5,
          run: () => {
            const i = [0, 1].find((k) => !this.claims.has(`sofa${k}`));
            if (i === undefined || !this.claim(m, `sofa${i}`)) return null;
            const seat = p.sofaSeats[i]!;
            return [
              { t: 'stand' },
              { t: 'walk', to: seat, yaw: seat.yaw },
              { t: 'sit', seat },
              { t: 'act', gesture: 'idle', seconds: 9 + m.rng() * 6, label: 'Duduk di sofa' },
              { t: 'stand' },
              { t: 'walk', to: m.home, yaw: m.home.yaw },
              { t: 'sit', seat: m.home },
            ];
          },
        },
        {
          weight: 2,
          run: () => {
            const partner = [...this.minds.values()].find((o) => o.id !== m.id && this.idleAndHome(o) && !this.claims.has(`chat:${o.id}`));
            if (!partner || !this.claim(m, 'chat')) return null;
            const group: Rendezvous = { arrived: new Set(), need: 2, startedAt: null, cancelled: false };
            const seconds = 7 + m.rng() * 4;
            const plan = (who: Mind, other: Mind, spot: Seat): Step[] => [
              { t: 'stand' },
              { t: 'walk', to: spot, yaw: spot.yaw },
              { t: 'meet', spot, group, seconds, label: `Mengobrol dengan ${other.name}`, partner: other.name },
              { t: 'walk', to: who.home, yaw: who.home.yaw },
              { t: 'sit', seat: who.home },
            ];
            this.release(partner);
            partner.queue = plan(partner, m, p.chatSpots[1]);
            partner.step = null;
            partner.nextIdleAt = Infinity;
            partner.label = 'Diajak ngobrol';
            this.claims.set(`chat:${partner.id}`, partner.id);
            return plan(m, partner, p.chatSpots[0]);
          },
        },
      );
    }
    // Pilih berbobot; bila pilihan gagal (tempat terpakai), coba yang lain.
    const pool = [...options];
    while (pool.length) {
      const total = pool.reduce((s, o) => s + o.weight, 0);
      let r = m.rng() * total;
      const idx = pool.findIndex((o) => (r -= o.weight) < 0);
      const [opt] = pool.splice(Math.max(0, idx), 1);
      const steps = opt!.run();
      if (steps) {
        m.queue = steps;
        m.nextIdleAt = Infinity;
        return;
      }
    }
    m.nextIdleAt = now + 4 + m.rng() * 6;
  }
}
