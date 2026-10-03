export interface Pt {
  x: number;
  z: number;
}

export interface Rect {
  x: number;
  z: number;
  w: number;
  d: number;
}

/** Resolusi grid lantai (ubin). */
export const RES = 0.5;

/**
 * Grid jalan kaki satu lantai. Semua sel awalnya tertutup (dinding/luar gedung);
 * koridor, interior ruangan, dan pintu dibuka, lalu perabot menutup kembali sel-selnya.
 */
export class WalkGrid {
  readonly cols: number;
  readonly rows: number;
  private open: Uint8Array;

  constructor(w: number, d: number) {
    this.cols = Math.ceil(w / RES);
    this.rows = Math.ceil(d / RES);
    this.open = new Uint8Array(this.cols * this.rows);
  }

  private inside(i: number, j: number) {
    return i >= 0 && j >= 0 && i < this.cols && j < this.rows;
  }
  isOpen(i: number, j: number) {
    return this.inside(i, j) && this.open[j * this.cols + i] === 1;
  }
  cellOf(p: Pt): [number, number] {
    return [Math.floor(p.x / RES), Math.floor(p.z / RES)];
  }
  center(i: number, j: number): Pt {
    return { x: (i + 0.5) * RES, z: (j + 0.5) * RES };
  }
  isOpenAt(p: Pt) {
    return this.isOpen(...this.cellOf(p));
  }

  private paint(r: Rect, value: 0 | 1, pad = 0) {
    for (let j = 0; j < this.rows; j++) {
      for (let i = 0; i < this.cols; i++) {
        const c = this.center(i, j);
        if (c.x > r.x - pad && c.x < r.x + r.w + pad && c.z > r.z - pad && c.z < r.z + r.d + pad) this.open[j * this.cols + i] = value;
      }
    }
  }
  openRect(r: Rect) {
    this.paint(r, 1);
  }
  blockRect(r: Rect, pad = 0.1) {
    this.paint(r, 0, pad);
  }

  /** Sel terbuka terdekat dari titik (spiral), atau null. */
  nearestOpen(p: Pt, maxRadius = 2): Pt | null {
    const [ci, cj] = this.cellOf(p);
    const max = Math.ceil(maxRadius / RES);
    let best: Pt | null = null;
    let bestD = Infinity;
    for (let dj = -max; dj <= max; dj++) {
      for (let di = -max; di <= max; di++) {
        if (!this.isOpen(ci + di, cj + dj)) continue;
        const c = this.center(ci + di, cj + dj);
        const dist = (c.x - p.x) ** 2 + (c.z - p.z) ** 2;
        if (dist < bestD) (bestD = dist), (best = c);
      }
    }
    return best;
  }

  /**
   * Garis lurus antara a dan b hanya melewati sel terbuka. `clearance` > 0 juga mensyaratkan
   * ruang bebas selebar itu di kiri-kanan garis (badan avatar tidak menyerempet dinding/perabot).
   */
  lineClear(a: Pt, b: Pt, clearance = 0) {
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const steps = Math.max(1, Math.ceil(len / 0.05));
    const nx = len > 0 ? -(b.z - a.z) / len : 0;
    const nz = len > 0 ? (b.x - a.x) / len : 0;
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      const x = a.x + (b.x - a.x) * t;
      const z = a.z + (b.z - a.z) * t;
      if (!this.isOpenAt({ x, z })) return false;
      if (clearance > 0 && (!this.isOpenAt({ x: x + nx * clearance, z: z + nz * clearance }) || !this.isOpenAt({ x: x - nx * clearance, z: z - nz * clearance }))) return false;
    }
    return true;
  }

  /** A* 8 arah tanpa memotong sudut; hasil dihaluskan. null bila tidak terjangkau. */
  findPath(from: Pt, to: Pt): Pt[] | null {
    const start = this.isOpenAt(from) ? from : this.nearestOpen(from);
    const goal = this.isOpenAt(to) ? to : this.nearestOpen(to);
    if (!start || !goal) return null;
    const [si, sj] = this.cellOf(start);
    const [gi, gj] = this.cellOf(goal);
    const idx = (i: number, j: number) => j * this.cols + i;
    const g = new Float32Array(this.cols * this.rows).fill(Infinity);
    const prev = new Int32Array(this.cols * this.rows).fill(-1);
    const done = new Uint8Array(this.cols * this.rows);
    const octile = (i: number, j: number) => {
      const dx = Math.abs(i - gi);
      const dz = Math.abs(j - gj);
      return Math.max(dx, dz) + 0.414 * Math.min(dx, dz);
    };
    const heap: [number, number][] = []; // [f, index]
    const push = (f: number, k: number) => {
      heap.push([f, k]);
      let n = heap.length - 1;
      while (n > 0) {
        const p = (n - 1) >> 1;
        if (heap[p]![0] <= heap[n]![0]) break;
        [heap[p], heap[n]] = [heap[n]!, heap[p]!];
        n = p;
      }
    };
    const pop = () => {
      const top = heap[0]!;
      const last = heap.pop()!;
      if (heap.length > 0) {
        heap[0] = last;
        let n = 0;
        for (;;) {
          const l = 2 * n + 1;
          const r = l + 1;
          let m = n;
          if (l < heap.length && heap[l]![0] < heap[m]![0]) m = l;
          if (r < heap.length && heap[r]![0] < heap[m]![0]) m = r;
          if (m === n) break;
          [heap[m], heap[n]] = [heap[n]!, heap[m]!];
          n = m;
        }
      }
      return top;
    };

    g[idx(si, sj)] = 0;
    push(octile(si, sj), idx(si, sj));
    let found = false;
    while (heap.length > 0) {
      const [, k] = pop();
      if (done[k]) continue;
      done[k] = 1;
      const i = k % this.cols;
      const j = (k / this.cols) | 0;
      if (i === gi && j === gj) {
        found = true;
        break;
      }
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          if (di === 0 && dj === 0) continue;
          const ni = i + di;
          const nj = j + dj;
          if (!this.isOpen(ni, nj)) continue;
          if (di !== 0 && dj !== 0 && (!this.isOpen(i + di, j) || !this.isOpen(i, j + dj))) continue;
          const nk = idx(ni, nj);
          const cost = g[k]! + (di !== 0 && dj !== 0 ? 1.414 : 1);
          if (cost < g[nk]!) {
            g[nk] = cost;
            prev[nk] = k;
            push(cost + octile(ni, nj), nk);
          }
        }
      }
    }
    if (!found) return null;

    const cells: Pt[] = [];
    for (let k = idx(gi, gj); k !== -1; k = prev[k]!) cells.push(this.center(k % this.cols, (k / this.cols) | 0));
    cells.reverse();
    // Titik awal di sel tertutup (mis. kursi sofa): keluar dulu lewat pusat sel terbuka terdekat.
    const raw: Pt[] = [from, ...(start === from ? [] : [start]), ...cells.slice(1, -1), ...(goal === to ? [to] : [goal, to])];
    // Haluskan: lompat ke titik terjauh yang masih berupa garis lurus bebas.
    const out: Pt[] = [raw[0]!];
    let anchor = 0;
    while (anchor < raw.length - 1) {
      let far = raw.length - 1;
      while (far > anchor + 1 && !this.lineClear(raw[anchor]!, raw[far]!, 0.15)) far--;
      out.push(raw[far]!);
      anchor = far;
    }
    return out;
  }

  reachableFrom(p: Pt): Set<number> {
    const start = this.isOpenAt(p) ? p : this.nearestOpen(p);
    const seen = new Set<number>();
    if (!start) return seen;
    const [si, sj] = this.cellOf(start);
    const stack = [[si, sj] as [number, number]];
    seen.add(sj * this.cols + si);
    while (stack.length) {
      const [i, j] = stack.pop()!;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const k = (j + dj) * this.cols + (i + di);
        if (this.isOpen(i + di, j + dj) && !seen.has(k)) (seen.add(k), stack.push([i + di, j + dj]));
      }
    }
    return seen;
  }

  isReachable(from: Pt, to: Pt) {
    const reach = this.reachableFrom(from);
    const target = this.isOpenAt(to) ? to : this.nearestOpen(to);
    if (!target) return false;
    const [i, j] = this.cellOf(target);
    return reach.has(j * this.cols + i);
  }
}
