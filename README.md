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
| Runtime | Claude CLI (login langganan) untuk semua agent. OpenRouter hanya untuk model gambar; runtime teks OpenRouter ada di kode tetapi mati (`VO_TEXT_PROVIDERS=1` untuk menyalakan) |
| Knowledge | Hasil riset disimpan, dipakai ulang, dan ditandai untuk verifikasi ulang per kategori |
| Tool Gateway | MCP milik Virtual Office: izin per role, tool berisiko menunggu persetujuan Owner, credential terenkripsi |
| Budget | Batas biaya API nyata per objective; lewat batas → task ditunda |
| Scheduler | Objective berulang (harian/interval) tanpa mengulang strategi dan perencanaan |
| Akses untuk AI | Halaman **Akses**: satu tempat untuk model gambar OpenRouter dan **API key NC-WA** untuk Instagram (akun resmi sudah terhubung di ncwa.nuscode.id). Disimpan terenkripsi, tidak pernah ditampilkan atau dikirim ke agent; menampilkan siapa yang memakainya |
| Gambar post | Agent mengisi `image_text`; sistem membuat gambarnya. Bila model gambar OpenRouter diaktifkan di halaman **Akses** (key + vendor/model, khusus gambar) dan kuota masih ada, model yang dipakai. Selain itu, atau bila model gagal, gambar berupa teks di latar putih bersih (1080×1350) buatan sendiri, sehingga post tidak pernah tertunda. Kuota (jumlah gambar dan biaya, keduanya per 24 jam) diatur Owner di halaman yang sama; 0 = tanpa batas. Instagram mengambil gambar lewat `/media/<acak>.png`, satu-satunya jalur yang terbuka dari luar, jadi **Alamat publik server** wajib diisi agar publish jalan |
| Pertumbuhan | Halaman **Tumbuh**: pengumpul mengambil data akun Instagram lewat NC-WA tiap N jam (bisa diatur, bawaan 6) dan menyimpannya sebagai snapshot, karena NC-WA tidak menyimpan riwayat. Menampilkan follower beserta selisih 24 jam/7/30 hari (kosong bila riwayat belum cukup, bukan angka yang menyesatkan), jangkauan, interaksi, grafik dari waktu ke waktu, dan kinerja tiap postingan dengan penanda yang diterbitkan sistem. Ringkasannya ikut masuk ke prompt agenda CEO. Butuh key NC-WA dengan izin `insights:read` (follower, jangkauan) dan `comments:read` (postingan); tanpa salah satunya, bagian lain tetap jalan dan halaman menunjukkan izin yang kurang |
| Perusahaan otonom | Halaman **Perusahaan**: Owner cukup mengisi jenis usaha, produk, dan batas, lalu menjalankan. CEO menyusun agenda sendiri, objective dikerjakan tanpa persetujuan selama dalam batas (budget, jumlah pekerjaan, larangan); hanya hal di luar batas yang dieskalasi ke Owner |
| Tenaga kerja adaptif | Agent bisa dirumahkan, diaktifkan kembali, atau dipensiunkan (arsip); tenure permanent/on-demand/sementara; HRD memakai ulang staf dirumahkan sebelum merekrut baru dan merumahkan staf berlebih yang menganggur; halaman Pengaturan menampilkan performa dan saran HRD |
| Pembersihan | Objective yang sudah selesai/gagal/dibatalkan bisa dihapus dari halamannya (task, sesi, hasil, dan folder kerja ikut terhapus; knowledge tetap) |
| Hasil kerja | Halaman **Hasil**: hasil akhir tiap objective (bahan riset/antara dilipat sebagai pendukung), dilihat langsung (Markdown, HTML aman, gambar, JSON, CSV) atau diunduh per file / ZIP hasil akhir |
| Observability | Ringkasan biaya (Rupiah/USD), sesi, token per hari, agent, objective, runtime |

Objective tidak diberikan manual: CEO memilihnya sendiri dari profil usaha, dan setiap objective dikerjakan dengan alur yang sama (Manager merencanakan, tim mengerjakan, Manager mereview). Tidak ada pilihan cara kerja yang perlu Anda atur.

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

## Akses lewat alamat publik

Dari komputer ini dashboard terbuka langsung. Lewat alamat publik atau tunnel (mis. vo.nuscode.id), isi `VO_ACCESS_CODE` di `.env` (minimal 10 karakter) lalu restart: pengunjung harus memasukkan kode itu di halaman masuk. Kosong = dari luar semuanya 404.

- Sesi berupa cookie bertanda tangan (HttpOnly, SameSite=Strict, Secure di HTTPS) berlaku 7 hari. Mengganti kode memutus semua sesi; tombol **Keluar** ada di rel kiri.
- Salah kode 5 kali dari satu alamat mengunci alamat itu 15 menit; ada juga kunci total bila banyak alamat mencoba.
- `/mcp` (Gateway untuk agent) tidak pernah terbuka dari luar. Satu-satunya jalur tanpa login adalah `/media/<acak>.png` untuk Instagram.
- Tunnel harus meneruskan header proxy (`X-Forwarded-For`/`CF-Connecting-IP`, yang ditambahkan Cloudflare Tunnel dan nginx). Permintaan tanpa header itu dan ber-Host `localhost` dianggap dari komputer ini dan tidak diminta kode.

## Pengaturan yang Anda isi sendiri

Di halaman **Pengaturan**:

- **Model gambar (OpenRouter)**: API key, vendor/model, kuota per 24 jam, dan alamat publik server. Key ini hanya dipakai untuk gambar. Runtime teks OpenRouter dimatikan secara bawaan (`VO_TEXT_PROVIDERS=1` menyalakannya kembali, lalu kartu OpenRouter teks muncul di Akses).
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

- OpenRouter (butuh API key): adapter teks dan pembuat gambar diuji dengan respons tiruan.
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
