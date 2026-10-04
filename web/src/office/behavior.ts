import type { FloorLayout, PantryLayout, Seat } from './layout';
import type { Pt } from './pathfinding';

/**
 * Perilaku avatar di satu lantai. Murni kosmetik dan berjalan di browser: tidak memakai server
 * dan tidak memakai kuota. Prioritas selalu mengikuti kondisi nyata, jadi tampilan tidak menipu:
 * nonaktif > rapat > pekerjaan/antrean nyata > serah-terima hasil > aktivitas acak.
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
  handover: string | null;
  retryAt: number;
}

export const WALK_SPEED = 1.7;
/** Jendela penerimaan event baru; event yang sudah diterima boleh antre hingga satu menit. */
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
  private pendingHandovers = new Map<string, number>();
  private inputs: EngineInputs = { agents: [], meetingIds: new Set(), handovers: new Map(), managerId: null };
  private pantry: PantryLayout | undefined;
  private meetingSeats: Seat[];
  private meetingPlaces = new Map<string, { seat: Seat; sit: boolean }>();
  private meetingKey = '';
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
        handover: null,
        retryAt: 0,
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
    const wallNow = Date.now();
    for (const [id, start] of inputs.handovers) {
      if (Number.isFinite(start) && start <= wallNow && wallNow - start <= HANDOVER_WINDOW_MS && start > (this.pendingHandovers.get(id) ?? -Infinity) && !this.doneHandovers.has(`${id}:${start}`)) this.pendingHandovers.set(id, start);
    }
    for (const [id, start] of this.pendingHandovers) {
      if (wallNow - start > 60_000 || this.doneHandovers.has(`${id}:${start}`)) this.pendingHandovers.delete(id);
    }
    for (const a of inputs.agents) {
      const m = this.minds.get(a.id);
      if (!m) continue;
      m.input = a;
      m.name = a.name;
      m.roleId = a.roleId;
    }
    this.syncMeetingPlaces();
    for (const a of inputs.agents) {
      const m = this.minds.get(a.id);
      if (!m) continue;
      const desired = this.desiredMode(m);
      if (desired !== m.mode) this.applyMode(m, desired, now);
      else this.refreshSeated(m);
    }
  }

  /** Pertahankan tempat peserta lama; peserta tambahan memakai tempat berdiri yang unik. */
  private syncMeetingPlaces() {
    const participants = this.inputs.agents.filter((a) => this.minds.has(a.id) && a.activity !== 'inactive' && this.inputs.meetingIds.has(a.id));
    const key = JSON.stringify(participants.map((a) => a.id).sort());
    if (key === this.meetingKey) return;
    this.meetingKey = key;
    const ids = new Set(participants.map((a) => a.id));
    for (const id of this.meetingPlaces.keys()) if (!ids.has(id)) this.meetingPlaces.delete(id);
    const room = this.floor.rooms.find((r) => r.kind === 'meeting');
    if (!room) return;
    const places = this.meetingSeats.map((seat) => ({ seat, sit: true }));
    for (let z = room.rect.z + 1; z < room.rect.z + room.rect.d - 0.6; z += 1) {
      for (let x = room.rect.x + 0.8; x < room.rect.x + room.rect.w - 0.6; x += 1) {
        const seat = { x, z, yaw: Math.atan2(room.rect.x + room.rect.w / 2 - x, room.rect.z + room.rect.d / 2 - z) };
        if (this.floor.grid.lineClear(seat, seat) && places.every((p) => Math.hypot(p.seat.x - x, p.seat.z - z) >= 0.9)) places.push({ seat, sit: false });
      }
    }
    const used = new Set([...this.meetingPlaces.values()].map((p) => p.seat));
    // Kursi berdiri dibuat ulang; koordinat dipakai untuk menjaga alokasi tetap stabil.
    const occupied = (seat: Seat) => used.has(seat) || [...this.meetingPlaces.values()].some((p) => p.seat.x === seat.x && p.seat.z === seat.z);
    for (const a of participants.sort((a, b) => roleRank(a.roleId) - roleRank(b.roleId) || a.id.localeCompare(b.id))) {
      if (this.meetingPlaces.has(a.id)) continue;
      const place = places.find((p) => !occupied(p.seat));
      if (place) this.meetingPlaces.set(a.id, place);
    }
  }

  private handoverKey(m: Mind) {
    const start = this.pendingHandovers.get(m.id);
    if (start === undefined) return null;
    const key = `${m.id}:${start}`;
    return this.doneHandovers.has(key) ? null : key;
  }

  private desiredMode(m: Mind): Mode {
    if (m.input.activity === 'inactive') return 'ghost';
    if (this.meetingPlaces.has(m.id)) return 'meeting';
    const a = m.input.activity;
    if (a === 'working' || a === 'waiting' || a === 'blocked' || this.inputs.meetingIds.has(m.id)) return 'desk';
    // Manager tetap di mejanya selama ada staf yang sedang mengantarkan hasil.
    if (this.claims.has(`handover:${m.id}`)) return 'desk';
    if (m.mode === 'handover' && (m.step || m.queue.length)) return this.managerSpot(m) ? 'handover' : 'idle';
    const owner = this.claims.get(`handover:${this.inputs.managerId}`);
    if (this.time >= m.retryAt && (!owner || owner === m.id) && this.handoverKey(m) && this.managerSpot(m)) return 'handover';
    return 'idle';
  }

  private managerSpot(m: Mind): Seat | null {
    const id = this.inputs.managerId;
    if (!id || id === m.id) return null;
    const manager = this.minds.get(id);
    if (!manager || manager.input.activity === 'inactive' || this.inputs.meetingIds.has(id) || manager.seatedAt !== manager.home) return null;
    const seat = this.floor.seatOf.get(id);
    const spot = seat ? { x: seat.x + 1.3, z: seat.z + 0.1, yaw: -Math.PI / 2 } : null;
    return spot && this.floor.grid.isOpenAt(spot) ? spot : null;
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
    m.cup = false;
    m.paper = false;
    m.handover = null;
    m.gesture = 'none';
    switch (mode) {
      case 'ghost':
        if (m.seatedAt !== m.home) m.queue = this.goHome(m);
        m.ghost = true;
        m.label = ACTIVITY_LABEL.inactive;
        return;
      case 'meeting': {
        m.ghost = false;
        const place = this.meetingPlaces.get(m.id)!;
        const seat = place.seat;
        m.queue = [{ t: 'stand' }, { t: 'walk', to: seat, yaw: seat.yaw }, ...(place.sit ? [{ t: 'sit', seat } as Step] : [])];
        m.label = 'Menuju Ruang Rapat';
        return;
      }
      case 'handover': {
        m.ghost = false;
        const key = this.handoverKey(m);
        const spot = this.managerSpot(m);
        if (!key || !spot) return this.applyMode(m, this.desiredMode({ ...m, mode: 'idle' } as Mind), now);
        this.claim(m, `handover:${this.inputs.managerId}`);
        m.handover = key;
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

  /** Karyawan yang duduk di mejanya: gerakan tangan mengikuti pekerjaannya. */
  private refreshSeated(m: Mind) {
    if (m.step || m.queue.length) return;
    const meetingPlace = this.meetingPlaces.get(m.id);
    if (m.mode === 'meeting' && meetingPlace && Math.hypot(m.x - meetingPlace.seat.x, m.z - meetingPlace.seat.z) < 0.01) {
      m.gesture = 'talk';
      m.label = 'Rapat strategi';
      m.bubble = null;
      return;
    }
    if (m.pose !== 'sit') return;
    if (m.seatedAt !== m.home) return;
    if (m.mode === 'desk') {
      m.gesture = m.input.activity === 'working' ? 'type' : 'idle';
      m.label = ACTIVITY_LABEL[m.input.activity];
      if (this.inputs.meetingIds.has(m.id)) {
        m.gesture = 'talk';
        m.label = 'Mengikuti rapat dari meja';
      }
    } else if (m.mode === 'ghost') {
      m.gesture = 'none';
      m.label = ACTIVITY_LABEL.inactive;
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
    if (m.mode === 'ghost' && m.seatedAt === m.home && !m.step && !m.queue.length) return;
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
    if (m.mode !== 'meeting' && m.seatedAt !== m.home && now >= m.retryAt) {
      m.queue = this.goHome(m);
      return;
    }
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
        if (Math.hypot(m.x - s.seat.x, m.z - s.seat.z) > 0.01 || !this.floor.grid.wallsClear(m, s.seat)) {
          this.cancelRoute(m, now);
          return;
        }
        Object.assign(m, { x: s.seat.x, z: s.seat.z, yaw: s.seat.yaw, pose: 'sit' as Pose, seatedAt: s.seat, cup: false, paper: false });
        m.step = null;
        return;
      case 'walk': {
        m.cup = !!s.cup;
        m.paper = !!s.paper;
        const path = this.floor.grid.findPath({ x: m.x, z: m.z }, s.to);
        if (!path || path.length < 2) {
          this.cancelRoute(m, now);
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

  private cancelRoute(m: Mind, now: number) {
    this.release(m);
    m.queue = [];
    m.step = null;
    m.path = [];
    m.pose = 'stand';
    m.gesture = 'none';
    m.cup = false;
    m.paper = false;
    m.label = 'Jalur tidak tersedia';
    m.nextIdleAt = now + 10;
    m.retryAt = now + 10;
  }

  private advance(m: Mind, s: Step, dt: number, now: number) {
    if (s.t === 'walk') {
      let budget = WALK_SPEED * dt;
      while (budget > 0 && m.pathIdx < m.path.length) {
        const target = m.path[m.pathIdx]!;
        const dx = target.x - m.x;
        const dz = target.z - m.z;
        const dist = Math.hypot(dx, dz);
        const next = dist <= budget ? target : { x: m.x + (dx / dist) * budget, z: m.z + (dz / dist) * budget };
        // Guard tiap frame memakai collider fisik, termasuk ruas khusus sofa dan path yang lama.
        if (!this.floor.grid.wallsClear(m, next)) {
          this.cancelRoute(m, now);
          return;
        }
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
        if (s.gesture === 'give' && m.handover) this.doneHandovers.add(m.handover);
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
            m.group = group;
            partner.group = group;
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
