/** Hasil task yang menjadi dependency; file-nya sudah disalin ke context/<key>/. */
export interface DependencyContext {
  key: string;
  title: string;
  agentName: string;
  summary: string;
  files: string[];
}

interface PromptInput {
  agent: { name: string };
  role: { name: string; instructions: string };
  task: { title: string; instructions: string; input: unknown };
  objective: { title: string; description: string };
  dependencies?: DependencyContext[];
  /** Bagian prompt berisi knowledge organisasi yang relevan (sudah diformat). */
  knowledge?: string;
  /** Profil perusahaan dari Owner (jenis usaha, produk, batasan). */
  company?: string;
}

/**
 * Konteks dibuat ramping: setiap task memulai sesi baru hanya dengan
 * informasi yang relevan, karena panjang konteks memakan kuota (DESIGN.md §6.2).
 */
export function buildPrompts({ agent, role, task, objective, dependencies = [], knowledge = '', company }: PromptInput) {
  const systemPrompt = [
    `Kamu adalah ${agent.name} (${role.name}) di Virtual Office, sebuah organisasi AI.`,
    role.instructions,
    ...(company ? ['', 'Profil perusahaan (dari Owner; semua pekerjaan harus searah dan menghormati batasannya):', company, ''] : []),
    'Aturan kerja:',
    '- Kerjakan hanya task yang diberikan.',
    '- Simpan semua file hasil di folder out/ pada working directory.',
    '- Jangan mengarang fakta yang perlu diverifikasi; tulis sebagai asumsi.',
    '- Akhiri dengan output terstruktur sesuai JSON schema yang diminta.',
  ].join('\n');

  const deps = dependencies.length
    ? [
        '',
        '## Hasil kerja rekan (sudah selesai)',
        '',
        ...dependencies.flatMap((d) => [
          `### ${d.title} (key: ${d.key}, oleh ${d.agentName})`,
          d.summary,
          d.files.length ? `File: ${d.files.join(', ')}` : 'Tidak ada file.',
          '',
        ]),
        'Baca file di atas bila dibutuhkan. Jangan mengubah isi folder context/.',
      ].join('\n')
    : '';

  const input = task.input && Object.keys(task.input as object).length > 0
    ? `\n\n## Input\n\n\`\`\`json\n${JSON.stringify(task.input, null, 2)}\n\`\`\``
    : '';

  const prompt = [
    `# Task: ${task.title}`,
    '',
    task.instructions,
    '',
    '## Objective organisasi',
    '',
    `${objective.title}`,
    objective.description && objective.description !== objective.title ? `\n${objective.description}` : '',
  ].join('\n') + deps + knowledge + input;

  return { systemPrompt, prompt };
}

export function repairPrompt(error: string) {
  return [
    'Output terstruktur kamu sebelumnya tidak valid terhadap schema:',
    '',
    error,
    '',
    'Perbaiki dan kirim ulang output terstruktur yang valid. Jangan mengulang pekerjaan yang sudah selesai.',
  ].join('\n');
}
