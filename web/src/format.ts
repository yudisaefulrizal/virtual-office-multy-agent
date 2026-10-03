import type { Activity } from './api';

export const ACTIVITY: Record<Activity, { label: string; tone: string; dot: string; darkDot: string }> = {
  working: { label: 'Bekerja', tone: 'var(--blue)', dot: 'dot-fill-blue', darkDot: 'dark-fill-blue' },
  waiting: { label: 'Menunggu', tone: 'var(--blue)', dot: 'dot-ring-blue', darkDot: 'dark-ring-blue' },
  done: { label: 'Selesai', tone: 'var(--green)', dot: 'dot-fill-green', darkDot: 'dark-fill-green' },
  idle: { label: 'Idle', tone: 'var(--ink-2)', dot: 'dot-ring-grey', darkDot: 'dark-ring-grey' },
  blocked: { label: 'Ditunda', tone: 'var(--orange)', dot: 'dot-fill-orange', darkDot: 'dark-fill-orange' },
  inactive: { label: 'Nonaktif', tone: 'var(--ink-3)', dot: 'dot-dash-grey', darkDot: 'dark-dash-grey' },
};

export const TASK_STATUS: Record<string, { label: string; dot: string; tone: string }> = {
  pending: { label: 'Menunggu', dot: 'dot-ring-blue', tone: 'var(--blue)' },
  queued: { label: 'Antre', dot: 'dot-ring-blue', tone: 'var(--blue)' },
  running: { label: 'Berjalan', dot: 'dot-fill-blue', tone: 'var(--blue)' },
  completed: { label: 'Selesai', dot: 'dot-fill-green', tone: 'var(--green)' },
  failed: { label: 'Gagal', dot: 'dot-fill-orange', tone: 'var(--orange)' },
  cancelled: { label: 'Dibatalkan', dot: 'dot-dash-grey', tone: 'var(--ink-3)' },
  // status objective & project
  new: { label: 'Baru', dot: 'dot-ring-grey', tone: 'var(--ink-2)' },
  active: { label: 'Aktif', dot: 'dot-fill-blue', tone: 'var(--blue)' },
  strategizing: { label: 'Strategi', dot: 'dot-ring-blue', tone: 'var(--blue)' },
  awaiting_approval: { label: 'Menunggu Anda', dot: 'dot-fill-orange', tone: 'var(--orange)' },
};

export const SESSION_STATUS: Record<string, string> = {
  running: 'Berjalan',
  ok: 'OK',
  error: 'Error',
  timeout: 'Timeout',
  aborted: 'Dihentikan',
  rate_limited: 'Kena limit',
  invalid_output: 'Output tidak valid',
};

const EVENT_TEXT: Record<string, string> = {
  'objective.created': 'membuat objective',
  'objective.activated': 'mengaktifkan objective',
  'objective.completed': 'objective selesai',
  'objective.failed': 'objective gagal',
  'objective.cancelled': 'objective dibatalkan',
  'decision.approved': 'menyetujui keputusan',
  'project.created': 'membuat project',
  'project.completed': 'project selesai',
  'project.failed': 'project gagal',
  'task.created': 'membuat task',
  'task.assigned': 'menugaskan task',
  'task.unassignable': 'tidak menemukan agent untuk task',
  'task.started': 'mulai mengerjakan task',
  'task.completed': 'menyelesaikan task',
  'task.failed': 'task gagal',
  'task.retry_scheduled': 'menjadwalkan ulang task',
  'task.deferred': 'menunda task (limit)',
  'task.cancelled': 'membatalkan task',
  'session.started': 'membuka sesi terminal',
  'session.ended': 'menutup sesi terminal',
  'artifact.created': 'menyimpan artifact',
  'agent.created': 'merekrut agent',
  'plan.created': 'menyusun rencana kerja',
  'objective.strategizing': 'memulai rapat strategi',
  'strategy.consultations_requested': 'meminta konsultasi tim',
  'decision.proposed': 'mengusulkan keputusan',
  'decision.revision_requested': 'meminta revisi keputusan',
  'decision.rejected': 'menolak keputusan',
  'decision.superseded': 'mengganti keputusan lama',
  'team.change_pending': 'menunda perubahan tim (provider belum ada)',
  'agent.activated': 'mengaktifkan agent',
  'agent.updated': 'mengubah agent',
  'provider.configured': 'memasang provider',
  'setting.updated': 'mengubah pengaturan',
  'knowledge.created': 'menyimpan knowledge',
  'tool.executed': 'memakai tool',
  'tool.failed': 'gagal memakai tool',
  'tool.denied': 'ditolak memakai tool',
  'tool.credential_set': 'memasang credential tool',
  'approval.requested': 'meminta persetujuan Owner',
  'approval.approved': 'menyetujui permintaan',
  'approval.rejected': 'menolak permintaan',
  'owner.notified': 'mengirim pesan ke Owner',
  'budget.exceeded': 'menahan task: budget habis',
  'budget.updated': 'mengubah budget',
  'schedule.updated': 'mengatur jadwal',
  'schedule.removed': 'menghapus jadwal',
  'schedule.ran': 'menjalankan run terjadwal',
  'schedule.skipped': 'melewati run terjadwal',
  'knowledge.updated': 'memverifikasi ulang knowledge',
  'knowledge.deleted': 'menghapus knowledge',
  'review.accepted': 'menerima hasil kerja',
  'review.revision_requested': 'meminta revisi',
  'review.escalated': 'menyerahkan keputusan ke Owner',
  'runtime.rate_limited': 'runtime kena rate limit',
  'runtime.quota_reached': 'kuota jendela habis',
  'runtime.quota_available': 'kuota tersedia lagi',
};

export function eventText(type: string, payload: Record<string, unknown>) {
  const base = EVENT_TEXT[type] ?? type;
  const title = typeof payload.title === 'string' ? `: ${payload.title}` : '';
  const path = typeof payload.path === 'string' ? `: ${payload.path.split('/').pop()}` : '';
  return base + (title || path);
}

export const time = (iso: string) => new Date(iso).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
export const dateTime = (iso: string) =>
  new Date(iso).toLocaleString('id-ID', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** 0:07, 3:12, 1j 05m */
export function duration(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}:${String(s % 60).padStart(2, '0')}`;
  return `${Math.floor(m / 60)}j ${String(m % 60).padStart(2, '0')}m`;
}

export const tokens = (n: number | null | undefined) =>
  n == null ? '—' : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

export const usd = (micros: number | null | undefined) => (micros == null ? '—' : `$${(micros / 1_000_000).toFixed(3)}`);

export const DECISION_STATUS: Record<string, { label: string; dot: string; tone: string }> = {
  proposed: { label: 'Menunggu Anda', dot: 'dot-fill-orange', tone: 'var(--orange)' },
  approved: { label: 'Disetujui', dot: 'dot-fill-green', tone: 'var(--green)' },
  rejected: { label: 'Ditolak / direvisi', dot: 'dot-dash-grey', tone: 'var(--ink-3)' },
  superseded: { label: 'Digantikan', dot: 'dot-ring-grey', tone: 'var(--ink-3)' },
};

export const KIND_LABEL: Record<string, string> = {
  framing: 'Kerangka CEO',
  consultation: 'Konsultasi',
  decision: 'Keputusan',
  planning: 'Perencanaan',
  research: 'Riset',
  work: 'Kerja',
  review: 'Review',
};

export function describeSchedule(s: { kind: string; timeOfDay?: string | null; intervalHours?: number | null; timezone?: string }) {
  return s.kind === 'daily' ? `Setiap hari ${s.timeOfDay} (${s.timezone ?? 'Asia/Jakarta'})` : `Setiap ${s.intervalHours} jam`;
}
