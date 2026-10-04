import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { SecretBox } from '../../secrets';

const SESSION_MS = 7 * 24 * 3600_000;
const FAIL_WINDOW_MS = 15 * 60_000;
const MAX_FAILS_PER_IP = 5;
/** Jaring pengaman bila penyerang memalsukan header IP: total kegagalan semua alamat. */
const MAX_FAILS_TOTAL = 100;
export const COOKIE = 'vo_session';
export const MIN_CODE_LENGTH = 10;

const sha = (s: string) => createHash('sha256').update(s).digest();
const header = (req: FastifyRequest, name: string) => {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
};

/**
 * Gerbang akses dashboard. Dari komputer ini langsung (tanpa header proxy) dashboard terbuka seperti biasa.
 * Lewat alamat publik/tunnel, dashboard hanya terbuka bila VO_ACCESS_CODE diisi dan pengunjung sudah masuk
 * dengan kode itu; tanpa kode, semuanya 404 seperti sebelumnya. Sesi = cookie bertanda tangan (HMAC) yang
 * kuncinya diturunkan dari kode, jadi mengganti kode memutus semua sesi.
 */
export class AccessGate {
  private codeHash: Buffer | undefined;
  private key: Buffer | undefined;
  private fails = new Map<string, { count: number; since: number }>();
  private total = { count: 0, since: 0 };

  constructor(code: string | undefined, secrets: SecretBox) {
    if (!code) return;
    if (code.length < MIN_CODE_LENGTH) throw new Error(`VO_ACCESS_CODE minimal ${MIN_CODE_LENGTH} karakter`);
    this.codeHash = sha(code);
    this.key = secrets.derive(`session|${code}`);
  }

  get enabled() {
    return !!this.codeHash;
  }

  /** Permintaan langsung dari komputer ini: Host loopback dan tidak ada header proxy/tunnel. */
  isLocal(req: FastifyRequest) {
    const host = (req.headers.host ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    const proxied = ['cf-connecting-ip', 'x-forwarded-for', 'x-forwarded-host', 'forwarded', 'x-real-ip'].some((h) => req.headers[h] !== undefined);
    return ['localhost', '127.0.0.1', '::1'].includes(host) && !proxied;
  }

  private sign(exp: number) {
    return createHmac('sha256', this.key!).update(String(exp)).digest('base64url');
  }

  authenticated(req: FastifyRequest) {
    if (!this.key) return false;
    const raw = (req.headers.cookie ?? '').split(';').map((c) => c.trim()).find((c) => c.startsWith(`${COOKIE}=`));
    const [exp, sig] = (raw?.slice(COOKIE.length + 1) ?? '').split('.');
    if (!exp || !sig || !/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
    const expected = Buffer.from(this.sign(Number(exp)));
    const given = Buffer.from(sig);
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  private clientId(req: FastifyRequest) {
    return (header(req, 'cf-connecting-ip') ?? header(req, 'x-forwarded-for')?.split(',')[0] ?? req.ip).trim();
  }

  /** Detik tersisa bila alamat ini (atau semua alamat) sedang dikunci, selain itu 0. */
  locked(req: FastifyRequest, now = Date.now()) {
    const left = (e: { count: number; since: number } | undefined, max: number) => (e && now - e.since < FAIL_WINDOW_MS && e.count >= max ? Math.ceil((FAIL_WINDOW_MS - (now - e.since)) / 1000) : 0);
    return Math.max(left(this.fails.get(this.clientId(req)), MAX_FAILS_PER_IP), left(this.total, MAX_FAILS_TOTAL));
  }

  /** Cookie sesi bila kode benar, null bila salah. Kegagalan dihitung per alamat. */
  attempt(req: FastifyRequest, code: string, now = Date.now()) {
    const id = this.clientId(req);
    if (timingSafeEqual(sha(code), this.codeHash!)) {
      this.fails.delete(id);
      return this.cookie(now + SESSION_MS, SESSION_MS, req);
    }
    const bump = (e: { count: number; since: number } | undefined) => (e && now - e.since < FAIL_WINDOW_MS ? { count: e.count + 1, since: e.since } : { count: 1, since: now });
    this.fails.set(id, bump(this.fails.get(id)));
    this.total = bump(this.total);
    if (this.fails.size > 1000) for (const [k, v] of this.fails) if (now - v.since >= FAIL_WINDOW_MS) this.fails.delete(k);
    return null;
  }

  private cookie(exp: number, maxAgeMs: number, req: FastifyRequest) {
    const secure = (header(req, 'x-forwarded-proto') ?? '').includes('https') ? '; Secure' : '';
    return `${COOKIE}=${exp}.${this.sign(exp)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(maxAgeMs / 1000)}${secure}`;
  }

  logoutCookie() {
    return `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
  }
}
