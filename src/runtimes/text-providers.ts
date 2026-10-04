/**
 * Runtime teks berbasis API (OpenRouter) dimatikan secara bawaan: semua agent memakai Claude CLI, dan OpenRouter
 * hanya dipakai untuk model gambar (src/orchestrator/imagegen.ts, key terpisah). Nyalakan kembali dengan
 * VO_TEXT_PROVIDERS=1 saat nanti pindah ke OpenRouter penuh. Dibaca saat dipanggil agar .env sudah termuat.
 */
export const textProvidersEnabled = () => process.env.VO_TEXT_PROVIDERS === '1';
export const TEXT_PROVIDERS_OFF = 'Runtime OpenRouter untuk teks dinonaktifkan; semua agent memakai claude-cli (OpenRouter hanya untuk gambar).';
