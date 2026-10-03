# Virtual Office

Organisasi AI multi-agent dengan kantor 3D yang bisa dipantau. Virtual Office adalah orchestrator; Claude Code (`claude -p`) adalah runtime yang mengerjakan task. Desain lengkap: [docs/DESIGN.md](docs/DESIGN.md).

Status: **Slice 2** — Owner memberi objective → Manager menyusun rencana (task + dependency) → Research Agent dan Content Writer mengerjakan lewat Claude CLI, hasil diteruskan antar task → Manager mereview (maks. 2 revisi, lalu diserahkan ke Owner). Semua sesi, token, artifact, dan event tercatat dan tampil di kantor 3D.

Dua cara kerja saat memberi objective:

| Mode | Alur | Kuota Claude |
|---|---|---|
| Terencana (default) | Rencana → riset/tulis → review | ±4 run |
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

## Kuota Claude Pro

Agent memakai login Claude Code Anda (langganan, bukan API key), jadi kuotanya dipakai bersama sesi Claude Anda sendiri. Pengaman di `.env`:

| Variabel | Default | Fungsi |
|---|---|---|
| `VO_DEFAULT_MODEL` | `sonnet` | Model untuk agent baru. Default Claude Code adalah Opus, yang jauh lebih boros kuota. |
| `CLAUDE_CLI_CONCURRENCY` | `1` | Jumlah sesi agent bersamaan. |
| `CLAUDE_CLI_MAX_RUNS_PER_WINDOW` | `10` | Batas run Virtual Office per jendela waktu; lewat dari itu task ditunda, bukan gagal. |
| `CLAUDE_CLI_WINDOW_HOURS` | `5` | Panjang jendela kuota. |

Jika Claude mengembalikan rate limit, task kembali ke antrean tanpa menghabiskan jatah retry.

## Keamanan sesi agent

Setiap sesi berjalan dengan `--restricted` (tanpa Bash/eksekusi kode, file hanya di folder task, setting pribadi diabaikan), `--strict-mcp-config` (tanpa MCP pribadi), daftar tools sesuai role, dan environment tanpa secret. Hasil agent divalidasi terhadap schema sebelum diterima; output tidak valid diperbaiki sekali lewat `--resume`.

## Struktur

```
src/
  domain/        state machine Task, Objective, Decision, Project
  db/            schema Drizzle + migrasi (drizzle/)
  runtimes/      AgentRuntime, ClaudeCliRuntime, FakeRuntime
  agents/        role, schema output, prompt
  orchestrator/  layanan kantor, worker antrean, read model
  interface/     HTTP API + SSE
web/             React + Three.js (kantor 3D, jejak objective)
workspaces/      file kerja agent (diabaikan git)
```

## Test

```bash
npm test          # butuh MySQL (npm run db:up); memakai database vo_test
npm run typecheck
```
