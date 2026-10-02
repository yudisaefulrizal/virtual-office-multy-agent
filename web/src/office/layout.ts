import type { OfficeAgent } from '../api';

/** Koordinat lantai: x ke kanan-bawah, z ke kiri-bawah (kamera isometrik), 1 = satu ubin. */
export interface Room {
  key: string;
  name: string;
  x: number;
  z: number;
  w: number;
  d: number;
  color: string;
  /** Posisi berdiri avatar. Meja diletakkan di depannya untuk ruangan bertipe desk. */
  seats: [number, number][];
  kind: 'meeting' | 'desk';
}

export const FLOOR = { w: 20, d: 14 };

export const ROOMS: Room[] = [
  {
    key: 'executive', name: 'Ruang Eksekutif', x: 1, z: 1, w: 8, d: 5, color: '#6e7c99', kind: 'meeting',
    // Disebar agar label tidak bertumpuk di kamera isometrik (x − z berbeda cukup jauh).
    seats: [[3.0, 2.2], [3.0, 4.4], [5.0, 4.6], [7.0, 3.3], [5.0, 2.1], [6.4, 4.8]],
  },
  {
    key: 'rnd', name: 'Lab R&D', x: 11, z: 1, w: 8, d: 5, color: '#5e968f', kind: 'desk',
    seats: [[12.55, 2.4], [15.55, 2.4], [12.55, 4.6], [15.55, 4.6]],
  },
  {
    key: 'operations', name: 'Meja Manager', x: 1, z: 8, w: 6, d: 5, color: '#9883ae', kind: 'desk',
    seats: [[3.05, 9.4], [3.05, 11.6]],
  },
  {
    key: 'content', name: 'Studio Konten', x: 9, z: 8, w: 7, d: 5, color: '#c49a62', kind: 'desk',
    seats: [[10.55, 9.4], [13.55, 9.4], [10.55, 11.6], [13.55, 11.6]],
  },
];

export const SERVER_ROOM = { key: 'server', name: 'Ruang Runtime', x: 17, z: 8, w: 2.6, d: 5, color: '#5a6068' };

export interface Placement {
  agent: OfficeAgent;
  room: Room;
  x: number;
  z: number;
  /** Meja di depan avatar (null untuk ruang rapat). */
  desk: { x: number; z: number } | null;
}

const ROLE_ORDER = ['ceo', 'cfo', 'cto', 'hrd', 'manager', 'researcher', 'market_researcher', 'content_writer'];
const rank = (roleId: string) => {
  const i = ROLE_ORDER.indexOf(roleId);
  return i === -1 ? ROLE_ORDER.length : i;
};

/** Tempatkan agent ke ruangan berdasarkan department; kursi berikutnya jika sudah terisi. */
export function placeAgents(agents: OfficeAgent[]): Placement[] {
  const used = new Map<string, number>();
  const ordered = [...agents].sort((a, b) => rank(a.roleId) - rank(b.roleId) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return ordered.map((agent) => {
    const room = ROOMS.find((r) => r.key === agent.department) ?? ROOMS[ROOMS.length - 1]!;
    const i = used.get(room.key) ?? 0;
    used.set(room.key, i + 1);
    const seat = room.seats[i] ?? overflowSeat(room, i - room.seats.length);
    const [x, z] = seat;
    return { agent, room, x, z, desk: room.kind === 'desk' ? { x: x - 0.55, z: z + 0.35 } : null };
  });
}

function overflowSeat(room: Room, n: number): [number, number] {
  const perRow = Math.max(1, Math.floor(room.w / 1.2));
  return [room.x + 0.7 + (n % perRow) * 1.2, room.z + room.d - 0.5 - Math.floor(n / perRow) * 0.9];
}
