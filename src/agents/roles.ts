import type { NativeToolPolicy, RuntimeId } from '../runtimes/runtime';

export interface RoleDef {
  id: string;
  name: string;
  /** departments.id */
  department: string;
  nativeTools: NativeToolPolicy;
  instructions: string;
  /** Boleh dipakai Manager dalam rencana kerja. */
  plannable?: { kind: 'work' | 'research'; description: string };
}

export interface DepartmentDef {
  id: string;
  name: string;
  color: string;
}

/** Divisi awal. Divisi baru dibuat Owner atau diusulkan HRD (disetujui Owner). */
export const DEPARTMENTS: DepartmentDef[] = [
  { id: 'executive', name: 'Ruang Eksekutif', color: '#6e7c99' },
  { id: 'rnd', name: 'Lab R&D', color: '#5e968f' },
  { id: 'operations', name: 'Operasional', color: '#9883ae' },
  { id: 'content', name: 'Studio Konten', color: '#c49a62' },
];

/** Warna untuk divisi baru, berputar. Dipilih agar tetap terbedakan dari karpet divisi awal. */
export const DEPARTMENT_COLORS = ['#b86a6a', '#6a9ab8', '#8fae5e', '#b8873a', '#7a6ab8', '#4f9a8f', '#c26b94', '#7f8896'];

/** Role awal kantor. Agent hanya bisa dibuat dari role yang ada (DESIGN.md A6). */
export const ROLES: RoleDef[] = [
  {
    id: 'ceo',
    name: 'Chief Executive Officer',
    department: 'executive',
    nativeTools: 'read_only',
    instructions:
      'Kamu CEO. Pikirkan visi dan strategi besar lebih dulu, lalu pertimbangkan masukan CFO, CTO, HRD, dan evidence R&D. ' +
      'Kamu mengusulkan keputusan; tindakan nyata tetap tunduk pada izin dan persetujuan Owner.',
  },
  {
    id: 'cfo',
    name: 'Chief Financial Officer',
    department: 'executive',
    nativeTools: 'read_only',
    instructions:
      'Kamu CFO. Analisis biaya, kuota, dan resource. Jangan hanya berkata "terlalu mahal": selalu beri alternatif yang lebih feasible.',
  },
  {
    id: 'cto',
    name: 'Chief Technology Officer',
    department: 'executive',
    nativeTools: 'read_only',
    instructions:
      'Kamu CTO. Nilai arsitektur, keamanan, reliability, dan risiko teknis. Selalu beri alternatif teknis yang aman dan viable.',
  },
  {
    id: 'hrd',
    name: 'HRD',
    department: 'executive',
    nativeTools: 'read_only',
    instructions:
      'Kamu HRD organisasi AI. Kelola struktur, role, dan kebutuhan agent. Hindari membuat agent berlebihan; gabungkan skill jika masuk akal.',
  },
  {
    id: 'researcher',
    name: 'Research Agent',
    department: 'rnd',
    nativeTools: 'research',
    plannable: { kind: 'research', description: 'riset web, menghasilkan catatan riset dengan sumber' },
    instructions:
      'Kamu peneliti R&D. Kumpulkan evidence dan sebutkan sumbernya. Jangan mengarang fakta; tandai hal yang belum terverifikasi. ' +
      'Kamu menyediakan evidence, bukan mengambil keputusan.',
  },
  {
    id: 'market_researcher',
    name: 'Market Researcher',
    department: 'rnd',
    nativeTools: 'read_only',
    instructions: 'Kamu peneliti pasar. Analisis tren, kompetitor, dan audiens berdasarkan data yang diberikan.',
  },
  {
    id: 'manager',
    name: 'Manager',
    department: 'operations',
    nativeTools: 'read_only',
    instructions:
      'Kamu Manager. Terjemahkan keputusan menjadi rencana task dan review hasil kerja. ' +
      'Kamu tidak boleh mengubah objective, budget, atau kebijakan.',
  },
  {
    id: 'content_writer',
    name: 'Content Writer',
    department: 'content',
    nativeTools: 'workspace_write',
    plannable: { kind: 'work', description: 'menulis konten dan menyimpannya sebagai file' },
    instructions:
      'Kamu penulis konten media sosial. Tulis konten yang jelas, bernilai, dan sesuai audiens. ' +
      'Simpan setiap hasil sebagai file Markdown di folder out/.',
  },
];

export interface AgentSeed {
  name: string;
  roleId: string;
  runtime: RuntimeId;
  supervisor?: string;
  status?: 'active' | 'inactive' | 'waiting_provider';
}

/** Karyawan awal. Market Researcher menunggu provider OpenRouter (DESIGN.md §4.5). */
export const INITIAL_AGENTS: AgentSeed[] = [
  { name: 'CEO', roleId: 'ceo', runtime: 'claude-cli' },
  { name: 'CFO', roleId: 'cfo', runtime: 'claude-cli', supervisor: 'CEO' },
  { name: 'CTO', roleId: 'cto', runtime: 'claude-cli', supervisor: 'CEO' },
  { name: 'HRD', roleId: 'hrd', runtime: 'claude-cli', supervisor: 'CEO' },
  { name: 'Manager', roleId: 'manager', runtime: 'claude-cli', supervisor: 'CEO' },
  { name: 'Research Agent', roleId: 'researcher', runtime: 'claude-cli', supervisor: 'Manager' },
  { name: 'Market Researcher', roleId: 'market_researcher', runtime: 'openrouter', supervisor: 'Manager', status: 'waiting_provider' },
  { name: 'Content Writer', roleId: 'content_writer', runtime: 'claude-cli', supervisor: 'Manager' },
];

export const MAX_REVISION_ROUNDS = 2;

export interface PlannableRole {
  id: string;
  kind: 'work' | 'research';
  description: string;
}

/** Daftar role yang tersedia diambil dari database saat perencanaan, bukan dari kode. */
export function planningInstructions(plannable: PlannableRole[]) {
  const roles = plannable.map((r) => `- ${r.id}: ${r.description}`).join('\n');
  return [
    'Susun rencana kerja untuk objective di bawah.',
    '',
    'Role yang tersedia:',
    roles,
    '',
    'Aturan:',
    '- Gunakan task sesedikit mungkin (1–4). Kuota terbatas: tambahkan riset hanya bila benar-benar meningkatkan hasil.',
    '- Task yang memakai hasil task lain wajib mencantumkannya di depends_on.',
    '- Instruksi tiap task harus spesifik dan bisa dikerjakan tanpa bertanya balik.',
    '- Jangan membuat task review; Manager mereview setelah semua task selesai.',
  ].join('\n');
}

export function reviewInstructions(reviewFocus: string, round: number) {
  return [
    `Review hasil kerja tim (putaran ${round}). File hasil setiap task ada di folder context/.`,
    '',
    `Fokus review: ${reviewFocus}`,
    '',
    '- Pilih accept bila hasil layak dipakai untuk objective.',
    '- Pilih revise hanya untuk masalah nyata, dan tulis instruksi revisi yang spesifik per task_key.',
    `- Revisi dibatasi ${MAX_REVISION_ROUNDS} putaran; setelah itu hasil diserahkan ke Owner.`,
  ].join('\n');
}

export function revisionInstructions(original: string, feedback: string, specific: string, key: string) {
  return [
    original,
    '',
    '## Revisi dari Manager',
    '',
    feedback,
    '',
    `Yang harus diperbaiki: ${specific}`,
    '',
    `Versi sebelumnya ada di context/${key}/. Perbaiki dan simpan hasil baru di out/.`,
  ].join('\n');
}

/** Siapa yang boleh dikonsultasi CEO, dan task kind-nya. R&D menyediakan evidence (riset web). */
export const CONSULTABLE_ROLES: Record<string, { kind: 'consultation' | 'research'; focus: string }> = {
  cfo: { kind: 'consultation', focus: 'biaya, kuota, resource, ROI' },
  cto: { kind: 'consultation', focus: 'teknologi, keamanan, reliability, integrasi' },
  hrd: { kind: 'consultation', focus: 'struktur tim dan kebutuhan agent' },
  researcher: { kind: 'research', focus: 'evidence dan data dari riset' },
};

export function framingInstructions() {
  const roles = Object.entries(CONSULTABLE_ROLES)
    .map(([id, r]) => `- ${id}: ${r.focus}`)
    .join('\n');
  return [
    'Pahami objective dari Owner dan kembangkan visi besarnya lebih dulu.',
    '',
    'Lalu tentukan konsultasi yang benar-benar dibutuhkan sebelum mengambil keputusan:',
    roles,
    '',
    '- Konsultasi bersifat selektif: setiap konsultasi memakai kuota. Jangan bertanya ke semua bila tidak relevan.',
    '- Tulis pertanyaan yang spesifik untuk tiap role.',
  ].join('\n');
}

export function consultationInstructions(question: string, vision: string) {
  return [
    `CEO meminta analisismu: ${question}`,
    '',
    `Visi CEO: ${vision}`,
    '',
    'Berikan analisis, risiko, rekomendasi, dan alternatif yang lebih feasible. Jangan hanya menolak; tawarkan jalan keluar.',
  ].join('\n');
}

export function decisionInstructions(ownerFeedback?: string) {
  return [
    'Ambil keputusan strategis berdasarkan visimu dan hasil konsultasi tim.',
    '',
    '- Usulan ini menunggu persetujuan Owner sebelum dijalankan.',
    '- Tim hanya boleh memakai role yang sudah ada. Pilih runtime openrouter untuk role yang cukup bernalar (hemat kuota Claude), claude-cli untuk yang butuh file atau riset web.',
    '- Tuliskan di owner_requests hal yang perlu Owner sediakan (provider, budget, akses tool). Jangan pernah meminta API key dituliskan.',
    '- execution_brief adalah arahan untuk Manager menyusun rencana kerja.',
    ownerFeedback ? `\n## Catatan revisi dari Owner\n\n${ownerFeedback}` : '',
  ].join('\n');
}

export function executionPlanningInstructions(
  decision: { strategy: string; execution_brief: string; success_metrics: string[] },
  plannable: PlannableRole[],
) {
  return [
    planningInstructions(plannable),
    '',
    '## Keputusan CEO yang sudah disetujui Owner',
    '',
    `Strategi: ${decision.strategy}`,
    `Arahan untuk Manager: ${decision.execution_brief}`,
    `Metrik keberhasilan: ${decision.success_metrics.join('; ')}`,
  ].join('\n');
}
