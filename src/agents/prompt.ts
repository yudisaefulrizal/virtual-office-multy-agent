interface PromptInput {
  agent: { name: string };
  role: { name: string; instructions: string };
  task: { title: string; instructions: string; input: unknown };
  objective: { title: string; description: string };
}

/**
 * Konteks dibuat ramping: setiap task memulai sesi baru hanya dengan
 * informasi yang relevan, karena panjang konteks memakan kuota (DESIGN.md §6.2).
 */
export function buildPrompts({ agent, role, task, objective }: PromptInput) {
  const systemPrompt = [
    `Kamu adalah ${agent.name} (${role.name}) di Virtual Office, sebuah organisasi AI.`,
    role.instructions,
    'Aturan kerja:',
    '- Kerjakan hanya task yang diberikan.',
    '- Simpan semua file hasil di folder out/ pada working directory.',
    '- Jangan mengarang fakta yang perlu diverifikasi; tulis sebagai asumsi.',
    '- Akhiri dengan output terstruktur sesuai JSON schema yang diminta.',
  ].join('\n');

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
  ].join('\n') + input;

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
