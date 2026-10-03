# Virtual Office

Organisasi AI multi-agent dengan kantor 3D yang bisa dipantau. Virtual Office adalah orchestrator; Claude Code (`claude -p`) adalah runtime yang mengerjakan task. Desain lengkap: [docs/DESIGN.md](docs/DESIGN.md).

Status: seluruh roadmap di [docs/DESIGN.md](docs/DESIGN.md) sudah diimplementasikan.

| Bagian | Isi |
|---|---|
| Kantor 3D | Gedung modular: tiap divisi punya ruangan sendiri, plus Ruang Rapat, Pantry, dan Ruang Runtime. Divisi baru = ruangan baru; lebih dari 6 divisi → lantai baru |
| Avatar | Duduk di meja, berjalan lewat pintu dan koridor, rapat strategi di Ruang Rapat, menyerahkan hasil ke Manager. Saat menganggur: duduk santai, meregang, menyeduh kopi, ngobrol di pantry, sofa, melihat keluar jendela |
| Organisasi | Divisi, role, dan staf dinamis. HRD mengusulkan divisi/role/staf baru (disetujui Owner); aturan staffing deterministik menambah staf saat antrean menumpuk |
| Paralel | Satu karyawan satu task; staf role yang sama bekerja bersamaan. Batas paralel runtime turun sendiri saat rate limit dan naik lagi saat aman |
| Strategi (Slice 3) | CEO → konsultasi selektif (R&D, CFO, CTO, HRD) → usulan keputusan → persetujuan Owner → Manager |
| Eksekusi (Slice 2) | Manager merencanakan task + dependency, tim mengerjakan, Manager mereview (maks. 2 revisi) |
| Runtime | Claude CLI (utama, login langganan) dan OpenRouter (role yang cukup bernalar, hemat kuota) |
| Knowledge | Hasil riset disimpan, dipakai ulang, dan ditandai untuk verifikasi ulang per kategori |
| Tool Gateway | MCP milik Virtual Office: izin per role, tool berisiko menunggu persetujuan Owner, credential terenkripsi |
| Budget | Batas biaya API nyata per objective; lewat batas → task ditunda |
| Scheduler | Objective berulang (harian/interval) tanpa mengulang strategi dan perencanaan |
| Tenaga kerja adaptif | Agent bisa dirumahkan, diaktifkan kembali, atau dipensiunkan (arsip); tenure permanent/on-demand/sementara; HRD memakai ulang staf dirumahkan sebelum merekrut baru dan merumahkan staf berlebih yang menganggur; halaman Pengaturan menampilkan performa dan saran HRD |
| Pembersihan | Objective yang sudah selesai/gagal/dibatalkan bisa dihapus dari halamannya (task, sesi, hasil, dan folder kerja ikut terhapus; knowledge tetap) |
| Hasil kerja | Halaman **Hasil**: hasil akhir tiap objective (bahan riset/antara dilipat sebagai pendukung), dilihat langsung (Markdown, HTML aman, gambar, JSON, CSV) atau diunduh per file / ZIP hasil akhir |
| Observability | Ringkasan biaya (Rupiah/USD), sesi, token per hari, agent, objective, runtime |

Tiga cara kerja saat memberi objective:

| Mode | Alur | Kuota Claude (perkiraan) |
|---|---|---|
| Strategis | CEO + konsultasi → keputusan (Anda setujui) → rencana → kerja → review | ±7–10 run; lebih hemat bila eksekutif di OpenRouter |
| Terencana | Rencana Manager → riset/tulis → review | ±4 run |
| Cepat | Langsung ke Content Writer | 1 run |

## Menjalankan

Prasyarat: Node 22+, MySQL 8+ (atau Docker), Claude Code sudah login (`claude` berjalan di terminal).

```bash
npm install && npm --prefix web install
cp .env.example .env          # sesuaikan bila perlu
npm run db:up                 # MySQL 8 di Docker, port 3307
npm run web:build             # build UI kantor
npm start                     # http://localhost:8070
```

Migrasi dan seed karyawan awal berjalan otomatis saat start.

### Memakai MySQL lokal (port 3306)

Buat database dan user, lalu arahkan `DATABASE_URL` di `.env`:

```sql
CREATE DATABASE vo CHARACTER SET utf8mb4;
CREATE USER 'vo'@'localhost' IDENTIFIED BY 'ganti-password';
GRANT ALL PRIVILEGES ON vo.* TO 'vo'@'localhost';
```

```bash
DATABASE_URL=mysql://vo:ganti-password@localhost:3306/vo
```

Waktu selalu disimpan sebagai UTC; zona waktu server MySQL tidak berpengaruh.

Development UI dengan hot reload: jalankan `npm run dev` (server) dan `npm run web:dev` (UI di http://localhost:5173).

### Tanpa memakai kuota Claude

```bash
VO_FORCE_RUNTIME=fake npm start
```

Semua agent memakai runtime palsu yang menulis `out/result.md`. Cocok untuk mencoba UI dan alur.

### Paralel dan staf

`CLAUDE_CLI_CONCURRENCY` (default 3) adalah batas sesi Claude bersamaan. Karena kuota Pro dihitung bersama, paralel membuat pekerjaan **selesai lebih cepat**, bukan menambah jumlah pekerjaan per jendela kuota. Pengaman `CLAUDE_CLI_MAX_RUNS_PER_WINDOW` (default 30) tetap berlaku; angkanya bisa diubah dan hitungannya direset dari Pengaturan > Kuota Claude CLI. HRD menambah staf hanya bila task siap kerja menunggu lama, semua staf role itu sibuk, dan runtime-nya masih punya slot (aturannya di Pengaturan > Organisasi).

Setelah memperbarui kode, restart server (`npm start`): migrasi database berjalan otomatis saat start.

## Pengaturan yang Anda isi sendiri

Di halaman **Pengaturan**:

- **OpenRouter**: API key + model default. Agent yang menunggu provider (mis. Market Researcher) aktif otomatis. Lalu pindahkan CFO/CTO/HRD ke `openrouter` agar konsultasi tidak memakai kuota Claude.
- **Instagram**: access token Graph API, Instagram Business Account ID, dan versi API. Publish hanya terjadi setelah Anda menyetujui permintaan agent di kotak "Perlu Anda".

Credential disimpan terenkripsi (AES-256-GCM) dengan kunci di `.vo-secret` (dibuat otomatis) atau `VO_SECRET_KEY`. **Jangan hapus `.vo-secret`**: tanpa kunci itu credential tersimpan tidak bisa dibuka dan harus dimasukkan ulang.

## Kuota Claude Pro

Agent memakai login Claude Code Anda (langganan, bukan API key), jadi kuotanya dipakai bersama sesi Claude Anda sendiri. Pengaman di `.env`:

| Variabel | Default | Fungsi |
|---|---|---|
| `VO_DEFAULT_MODEL` | `sonnet` | Model untuk agent baru. Default Claude Code adalah Opus, yang jauh lebih boros kuota. |
| `CLAUDE_CLI_CONCURRENCY` | `1` | Jumlah sesi agent bersamaan. |
| `CLAUDE_CLI_MAX_RUNS_PER_WINDOW` | `30` | Batas run Virtual Office per jendela waktu; lewat dari itu task ditunda, bukan gagal. |
| `CLAUDE_CLI_WINDOW_HOURS` | `5` | Panjang jendela kuota. |

Jika Claude mengembalikan rate limit, task kembali ke antrean tanpa menghabiskan jatah retry.

## Keamanan sesi agent

Setiap sesi berjalan dengan `--restricted` (tanpa Bash/eksekusi kode, file hanya di folder task, setting pribadi diabaikan), `--strict-mcp-config` (tanpa MCP pribadi), daftar tools sesuai role, dan environment tanpa secret. Hasil agent divalidasi terhadap schema sebelum diterima; output tidak valid diperbaiki sekali lewat `--resume`.

## Belum diuji dengan layanan sungguhan

- OpenRouter (butuh API key): adapter diuji dengan respons tiruan.
- Instagram publish (butuh token Graph API dan URL gambar publik): diuji dengan Graph API tiruan.
- Pesan rate limit Claude: polanya masih perkiraan sampai kuota benar-benar habis.

Yang sudah diuji dengan Claude CLI sungguhan: task tunggal (Slice 1) dan pemanggilan Tool Gateway lewat MCP.

## Struktur

```
src/
  domain/        state machine Task, Objective, Decision, Project
  db/            schema Drizzle + migrasi (drizzle/)
  runtimes/      AgentRuntime, ClaudeCliRuntime, FakeRuntime
  agents/        role, schema output, prompt
  orchestrator/  playbook (office, strategy), worker antrean, knowledge, budget,
                 scheduler, provider, statistik, read model
  gateway/       Tool Gateway: registry tool & izin, MCP endpoint, persetujuan
  interface/     HTTP API + SSE
web/             React + Three.js (kantor 3D, jejak objective)
workspaces/      file kerja agent (diabaikan git)
```

## Test

```bash
npm test          # butuh MySQL (npm run db:up); memakai database vo_test
npm run typecheck
```
