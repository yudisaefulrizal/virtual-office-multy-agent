import type { NativeToolPolicy, RuntimeId } from '../runtimes/runtime';

export interface RoleDef {
  id: string;
  name: string;
  department: 'executive' | 'rnd' | 'operations' | 'content';
  nativeTools: NativeToolPolicy;
  instructions: string;
}

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
  status?: 'active' | 'inactive';
}

/** Karyawan awal. Market Researcher menunggu provider OpenRouter (DESIGN.md §4.5). */
export const INITIAL_AGENTS: AgentSeed[] = [
  { name: 'CEO', roleId: 'ceo', runtime: 'claude-cli' },
  { name: 'CFO', roleId: 'cfo', runtime: 'claude-cli', supervisor: 'CEO' },
  { name: 'CTO', roleId: 'cto', runtime: 'claude-cli', supervisor: 'CEO' },
  { name: 'HRD', roleId: 'hrd', runtime: 'claude-cli', supervisor: 'CEO' },
  { name: 'Manager', roleId: 'manager', runtime: 'claude-cli', supervisor: 'CEO' },
  { name: 'Research Agent', roleId: 'researcher', runtime: 'claude-cli', supervisor: 'Manager' },
  { name: 'Market Researcher', roleId: 'market_researcher', runtime: 'openrouter', supervisor: 'Manager', status: 'inactive' },
  { name: 'Content Writer', roleId: 'content_writer', runtime: 'claude-cli', supervisor: 'Manager' },
];
