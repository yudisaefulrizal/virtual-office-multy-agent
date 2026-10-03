import { eq } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { settings } from '../db/schema';

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
  /** Batas run Claude CLI per jendela waktu. -1: ikut .env, 0: tanpa batas (andalkan deteksi rate limit). */
  claude_max_runs_per_window: -1,
  /** Owner mereset hitungan kuota: run sebelum waktu ini (ISO) tidak dihitung. Kosong = tidak pernah direset. */
  quota_counted_since: '',
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
