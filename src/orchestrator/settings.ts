import { eq } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { settings } from '../db/schema';
import type { Company } from './company';
import type { MetricsStatus } from './metrics';

/** Pengaturan Owner beserta nilai default-nya. */
export const SETTING_DEFAULTS = {
  /** always: setiap keputusan CEO menunggu Owner. auto: langsung berlaku kecuali ada permintaan provider/budget/tool. */
  decision_approval: 'always' as 'always' | 'auto',
  /** Kurs untuk menampilkan biaya dalam Rupiah. */
  usd_to_idr: 16000,
  /** Aturan HRD: batas staf aktif per role. Di atas batas, penambahan butuh persetujuan Owner. */
  max_staff_per_role: 3,
  /** auto: HRD merekrut sendiri selama di bawah batas. ask: selalu minta persetujuan Owner. */
  auto_hire: 'auto' as 'auto' | 'ask',
  /** Task siap kerja yang menunggu lebih lama dari ini (detik) memicu pertimbangan menambah staf. */
  hire_wait_seconds: 90,
  /** Aturan HRD menurunkan staf: staf tambahan menganggur selama ini (menit) dirumahkan. 0 = tidak pernah otomatis. */
  suspend_idle_minutes: 30,
  /** Batas run Claude CLI per jendela waktu. -1: ikut .env, 0: tanpa batas (andalkan deteksi rate limit). */
  claude_max_runs_per_window: -1,
  /** Owner mereset hitungan kuota: run sebelum waktu ini (ISO) tidak dihitung. Kosong = tidak pernah direset. */
  quota_counted_since: '',
  /** Kuota model gambar (OpenRouter), jendela bergulir. 0 = tanpa batas. Lewat batas → gambar teks di latar putih. */
  image_max_per_day: 10,
  image_max_cost_usd_per_day: 1,
  /** Alamat server yang bisa dijangkau Instagram (mis. https://kantor.contoh.id); gambar post disajikan di /media/. */
  public_base_url: '',
  /** Jam antar pengambilan data akun Instagram (follower, jangkauan, post). 0 = mati. */
  metrics_interval_hours: 6,
  /** Hasil pengambilan data terakhir (per akun dan per sumber), untuk ditampilkan di halaman Pertumbuhan. */
  metrics_status: null as MetricsStatus | null,
  /** Piagam perusahaan (jenis usaha, produk, batas) dan status operasi otonom. null = belum diisi. */
  company: null as Company | null,
};
export type SettingKey = keyof typeof SETTING_DEFAULTS;

export async function getSetting<K extends SettingKey>(tx: Tx, key: K): Promise<(typeof SETTING_DEFAULTS)[K]> {
  const [row] = await tx.select().from(settings).where(eq(settings.key, key));
  return (row?.value as (typeof SETTING_DEFAULTS)[K]) ?? SETTING_DEFAULTS[key];
}

export async function getAllSettings(tx: Tx) {
  const rows = await tx.select().from(settings);
  const out: Record<string, unknown> = { ...SETTING_DEFAULTS };
  for (const r of rows) if (r.key in SETTING_DEFAULTS) out[r.key] = r.value;
  return out as typeof SETTING_DEFAULTS;
}

export async function setSetting<K extends SettingKey>(tx: Tx, key: K, value: (typeof SETTING_DEFAULTS)[K]) {
  await tx.insert(settings).values({ key, value }).onDuplicateKeyUpdate({ set: { value, updatedAt: new Date() } });
}
