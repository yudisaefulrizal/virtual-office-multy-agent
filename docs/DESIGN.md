# Virtual Office Multi-Agent — Design v0.1

Status: roadmap §12 dan Phase 5–8 selesai diimplementasikan (2026-10-03): Slice 1–3, OpenRouter, Knowledge, Tool Gateway (MCP) + persetujuan + budget, Scheduler, Observability. Lihat README untuk bagian yang belum diuji dengan layanan sungguhan.
Tanggal: 2026-10-03

Dokumen ini menjawab 10 langkah di §34 spesifikasi: analisis, ambiguity, domain model, boundary modul, lifecycle, runtime abstraction, permission boundary, schema minimum, MVP terkecil, dan implementation plan.

---

## 0. Apakah realistis?

**Ya, dengan tiga syarat.**

| Bagian | Feasibility | Catatan |
|---|---|---|
| Orchestrator (organisasi, task, lifecycle, audit) | Tinggi | Ini software biasa: state machine + database relasional (MySQL). Tidak ada yang eksperimental. |
| Terminal agent sebagai runtime | Tinggi | `claude -p` mendukung output JSON, `--json-schema` untuk structured output, `--session-id`/`--resume`, pembatasan tools, dan `--mcp-config`. Bisa dipanggil sebagai child process. |
| Tool Gateway + permission | Sedang | Bisa dibangun sebagai MCP server milik Virtual Office. **Tapi** terminal agent punya tools bawaan (Bash, Write, WebFetch) yang bisa mem-bypass gateway. Lihat §7. |
| Strategic loop CEO/CFO/CTO/HRD/R&D | Sedang | Secara teknis mudah. Risikonya di kualitas dan biaya: satu objective ≈ 7–10 agent run. |
| Autonomous recurring work | Sedang | Mudah dijadwalkan; yang sulit adalah menjaga kualitas tanpa manusia. Butuh review step dan batas retry. |

Syarat:

1. **Agent hanya mengusulkan; orchestrator yang mengeksekusi perubahan state.** CEO tidak "memanggil" CFO. CEO mengeluarkan JSON "saya butuh konsultasi CFO tentang X", lalu orchestrator yang membuat task-nya. Ini yang membuat sistem bisa diaudit dan dibatasi.
2. **Biaya dan rate limit diperlakukan sebagai constraint dari hari pertama.** Concurrency limit per runtime, budget per objective, dan pencatatan usage per session.
3. **Sandbox native tools terminal agent.** Tanpa ini, prinsip "agent tidak menerima raw credential" dan "semua tool lewat gateway" tidak benar-benar berlaku.

Catatan operasional: Claude CLI adalah runtime utama dan memakai **login CLI (langganan), bukan API key**. Rate limit menjadi constraint utama: concurrency default 1, dan orchestrator menangani rate limit sebagai "tunda lalu coba lagi", bukan "task gagal" (§6.2). Ini untuk pemakaian pribadi Owner; jika suatu saat Virtual Office dijadikan layanan untuk orang lain, auth harus pindah ke API key sesuai ketentuan Anthropic. Runtime tambahan via API (OpenRouter, dll.) dipakai untuk role yang cukup reasoning saja, agar kuota Claude dihemat untuk pekerjaan yang butuh workspace.

---

## 1. Ambiguity & potensi cacat desain di spesifikasi

Setiap poin diikuti keputusan desain yang dipakai di dokumen ini.

**A1. Komunikasi CEO → CFO bersifat sinkron atau tidak?**
Terminal agent adalah proses one-shot. CEO tidak bisa "menunggu" CFO di tengah session-nya tanpa membuat proses menggantung lama dan mahal.
→ **Keputusan:** strategic loop dipecah menjadi beberapa task terpisah yang dirangkai orchestrator: `CEO framing → konsultasi paralel → CEO decision`. Hasil konsultasi disuntikkan ke prompt task decision. Tidak ada session yang menunggu session lain.

**A2. Tool Gateway bisa di-bypass.**
Claude Code/Codex punya Bash, WebFetch, Write bawaan. Agent dengan Bash bisa `curl` ke API mana pun, membaca env var, dll.
→ **Keputusan:** native tools dibatasi per role (lihat §7). Tool eksternal hanya tersedia sebagai MCP tools dari Gateway. Env proses agent disanitasi (tanpa secret). Isolasi container ditunda sampai ada tool berisiko nyata (Instagram publish).

**A3. "Manager" itu LLM atau kode?**
Spesifikasi mencampur dua hal: perencanaan (butuh reasoning) dan scheduling/retry/dependency (harus deterministic).
→ **Keputusan:** dipisah.
- **Manager agent (LLM):** menerjemahkan decision → rencana task (JSON), dan mereview hasil.
- **Orchestrator (kode):** validasi rencana, membuat task, resolve dependency, antrian, retry, timeout, reassign.

**A4. Workflow vs Project vs Schedule tumpang tindih.**
→ **Keputusan:** MVP hanya punya `Project` berisi `Task`. "Workflow" = rencana task yang disimpan sebagai JSON di project (`plan_template`). Recurring work (Phase 7) = `Schedule` yang meng-instansiasi ulang `plan_template` menjadi task baru. Tidak perlu tabel `workflows`.

**A5. Apakah keputusan CEO butuh approval Owner?**
Tidak dijelaskan.
→ **Keputusan:** ya, secara default. Decision berstatus `proposed` sampai Owner approve. Ini gate murah yang mencegah organisasi berjalan ke arah salah dan menghabiskan biaya. Bisa dibuat auto-approve per objective nanti.

**A6. Pembuatan agent oleh HRD = eskalasi wewenang.**
Jika HRD bebas membuat agent dengan tools apa pun, HRD efektif bisa memberi dirinya akses lewat agent baru.
→ **Keputusan:** agent baru hanya bisa dibuat dari `Role` yang sudah ada (tools dibatasi oleh role). Membuat role baru atau menambah tool ke role = high-risk → butuh approval Owner.

**A7. Identitas agent vs session — siapa yang menyimpan memori?**
Jika memori agent bergantung pada session terminal, ia hilang ketika session rusak dan sulit diaudit.
→ **Keputusan:** memori jangka panjang ada di DB (task history, decision, knowledge). Setiap task memulai **session baru** dengan konteks yang disusun orchestrator. `resume` hanya dipakai di dalam satu task (perbaikan output invalid, revisi setelah review).

**A8. `confidence` di Knowledge diisi oleh LLM?**
Self-reported confidence LLM tidak bisa dipercaya.
→ **Keputusan (Phase 5):** `recheck_after` dihitung deterministic dari kategori (mis. API/pricing 30 hari, market trend 14 hari, konsep evergreen 180 hari). `confidence` diturunkan dari jumlah/kualitas sumber, bukan dari klaim model.

**A9. Crash di tengah task.**
Proses Node mati saat agent berjalan → task `running` selamanya.
→ **Keputusan:** task punya `lease_until`. Worker memperbarui lease selama berjalan. Saat startup, task `running` dengan lease kadaluwarsa dikembalikan ke antrian (dihitung sebagai attempt gagal).

**A10. Biaya dalam Rupiah.**
Provider melaporkan USD, kadang hanya token.
→ **Keputusan:** simpan `cost_usd_micros` (integer) + token mentah. Konversi ke Rupiah hanya di layer tampilan.

**A11. Organization multi-tenant?**
→ **Keputusan:** MVP single-organization, tanpa tabel `organizations`. Satu instance = satu kantor. Alasan: §22 melarang tabel yang belum dibutuhkan. Jika nanti perlu multi-tenant, tambahkan `org_id` lewat migration.

**A12. Review loop tanpa batas.**
Manager menolak → revisi → ditolak lagi → biaya tak terbatas.
→ **Keputusan:** maksimal 2 revisi per task, lalu eskalasi ke Owner.

**A13. Runtime API (OpenRouter) tidak setara dengan terminal agent.**
Claude CLI bisa membaca/menulis file, riset web, dan menjalankan tools. Model via API hanya menerima teks dan mengembalikan teks. Jika task yang butuh file di-assign ke agent API, task itu pasti gagal.
→ **Keputusan:** setiap runtime mendeklarasikan **capabilities** (`workspace_files`, `web_research`). Setiap task kind punya capability yang dibutuhkan. Orchestrator menolak assignment yang tidak cocok secara deterministic, bukan menunggu gagal saat run. Lihat §6.4.

**A14. CEO meminta resource kepada Owner.**
CEO menyusun kebutuhan berdasarkan analisis timnya (HRD: agent apa; CFO: biayanya; CTO: provider/tool apa yang aman), lalu meminta Owner. Permintaan bisa berupa provider baru, API key, budget, atau akses tool.
→ **Keputusan:** decision CEO punya field `owner_requests` yang terstruktur (§4.5). Owner melihatnya saat approve decision. Credential **tidak pernah** lewat LLM: CEO hanya meminta "butuh OpenRouter key"; Owner memasukkannya lewat CLI (form provider di UI), langsung ke Virtual Office.

---

## 2. Prinsip yang diturunkan ke aturan konkret

| Prinsip spesifikasi | Aturan implementasi |
|---|---|
| Agent thinks, system controls | Output agent selalu berupa **proposal JSON** yang divalidasi (zod) sebelum diterapkan. Agent tidak pernah menulis ke DB. |
| Komunikasi lewat mediator | Tidak ada channel antar-session. Semua lewat tabel `tasks` + `events`. |
| Traceable | Setiap perubahan state menulis `events` dalam transaksi yang sama. |
| Provider replaceable | Core hanya mengenal `AgentRuntime`. Tidak ada `if (runtime === 'claude')` di luar folder adapter. |
| Jangan LLM untuk hal deterministic | Dependency, retry, timeout, permission, budget, scheduling = kode. |

---

## 3. Domain model minimum

Entitas dikelompokkan berdasarkan phase pertama kali dibutuhkan. Yang tidak ada di daftar MVP **tidak dibuat dulu**.

```text
MVP (Phase 1–3)                 Phase 4–5             Phase 6–8
────────────────                ─────────             ─────────
Role                            Decision*             Tool / ToolPermission
Agent                           Knowledge             ToolExecution
AgentSession                    (Department table     Approval (generik)
Objective                        jika HRD butuh)      Schedule
Project                                               CostRecord (non-LLM)
Task
TaskDependency
Artifact
Event   (merangkap AuditLog)
```

\* `Decision` dimasukkan di Phase 1 karena lifecycle Objective → Decision → Project harus benar sejak awal, meski di MVP decision dibuat sederhana.

Penggabungan yang disengaja:

- **Event = AuditLog.** Satu tabel append-only. Audit adalah event dengan `actor`. Dua tabel berarti dua sumber kebenaran untuk hal yang sama.
- **Cost di AgentSession.** Biaya LLM melekat pada session. Tabel `cost_records` terpisah baru dibutuhkan saat ada biaya non-LLM (API berbayar, image generation) di Phase 6.
- **Department = kolom teks di Role.** Tabel department baru dibuat ketika HRD benar-benar membuat department dinamis (Phase 4).
- **Research = Task dengan `kind='research'`.** Hasilnya ditulis ke `knowledge`. Tidak perlu tabel `research`.

### Relasi

```text
Role 1──* Agent 1──* AgentSession *──1 Task
                                       │
Objective 1──* Decision                │
    │             │                    │
    └──────* Project *─────────────────┤ (project_id nullable:
                                       │  task strategis belum punya project)
              Task *──* Task  (TaskDependency)
              Task 1──* Artifact
```

Task strategis (framing, konsultasi, decision, planning) terikat ke `objective_id` tanpa project. Task eksekusi terikat ke `project_id`. Ini membuat halaman Objective bisa menampilkan seluruh pohon dari satu objective.

---

## 4. Lifecycle

### 4.1 Objective

```text
           Owner submit
                │
                ▼
             ┌─────┐
             │ new │
             └──┬──┘
                │ orchestrator membuat task CEO framing
                ▼
        ┌──────────────┐
        │ strategizing │  framing → konsultasi → decision
        └──────┬───────┘
               │ decision.status = proposed
               ▼
     ┌───────────────────┐   reject (+feedback)
     │ awaiting_approval │ ─────────────────────► strategizing
     └─────────┬─────────┘
               │ Owner approve
               ▼
          ┌────────┐        Manager planning → project + tasks
          │ active │        (recurring objective tetap active)
          └───┬────┘
      ┌───────┼────────────┐
      ▼       ▼            ▼
 completed  failed     cancelled
```

Di slice MVP pertama (sebelum Phase 4), `strategizing` dilewati: objective langsung `active` dengan decision trivial yang dibuat Owner.

### 4.2 Decision

`proposed → approved | rejected`, plus `superseded` ketika decision baru menggantikannya (perubahan arah). Decision tidak pernah di-update setelah approved; perubahan = decision baru. Ini menjaga histori keputusan.

### 4.3 Task

Spesifikasi memakai `created → assigned → queued → running → completed`. Saya menyederhanakan: **assignment adalah field, bukan state**, karena "sudah di-assign" dan "siap jalan" adalah dua hal yang independen (task bisa di-assign tapi masih menunggu dependency).

```text
                ┌─────────┐
  create ──────►│ pending │  menunggu dependency selesai / belum di-assign
                └────┬────┘
                     │ semua dependency completed  AND  assigned_agent_id != null
                     ▼
                ┌─────────┐ ◄──────────────────────────────┐
                │ queued  │                                │ retry (attempt < max)
                └────┬────┘                                │
                     │ worker claim (SKIP LOCKED)          │
                     ▼                                     │
                ┌─────────┐   error / timeout / invalid ───┤
                │ running │                                │
                └────┬────┘                                │
                     │ output valid                        │
                     ▼                              attempt >= max
               ┌───────────┐                               │
               │ completed │                               ▼
               └───────────┘                         ┌──────────┐
                                                     │  failed  │ → event task.failed
                                                     └──────────┘   → Manager: reassign / eskalasi
  dari state mana pun non-terminal ──► cancelled
```

Aturan transisi (dienforce di domain layer, bukan di agent):

- `pending → queued` hanya oleh orchestrator setelah cek dependency.
- `running → completed` hanya jika output lolos validasi schema.
- Rate limit runtime: `running → queued` dengan `not_before`, tanpa menambah `attempt`. Ini bukan kegagalan task.
- Output tidak valid → 1x `resume` session yang sama dengan pesan error validasi (murah, konteks masih ada). Jika tetap gagal → dihitung attempt gagal.
- `failed` adalah terminal untuk task tersebut. Reassign = task baru dengan `retry_of_task_id`, supaya histori attempt per agent tetap utuh.

### 4.4 Alur end-to-end (target Phase 4)

```text
Owner ──► Objective(new)
            │
            ▼
   [T1] CEO framing            output: { vision, questions: [{to: "cfo"|"cto"|"hrd"|"rnd", question}] }
            │                  orchestrator: buat task konsultasi HANYA untuk role yang diminta (selective, §12)
            ▼
   [T2..Tn] konsultasi paralel output: { analysis, risks, recommendation, alternatives }
            │                  (R&D duluan jika CFO/CTO butuh evidence → dependency)
            ▼
   [Td] CEO decision           input: framing + semua hasil konsultasi
            │                  output: { strategy, constraints, success_metrics, budget_cap_usd }
            ▼
   Decision(proposed) ──► Owner approve
            │
            ▼
   [Tp] Manager planning       output: { tasks: [{key, title, role, instructions, depends_on: [key]}] }
            │                  orchestrator: validasi DAG, map role→agent, buat Project + Tasks
            ▼
   Tasks eksekusi (research → content → review)
            │
            ▼
   [Tr] Manager review         output: { verdict: "accept"|"revise", feedback }
            │                  revise → task revisi (maks 2) | accept → project completed
            ▼
   Artifact + Result ──► Owner (halaman Objective di web UI)
```

Bagian yang dikerjakan LLM: T1, T2..Tn, Td, Tp, task eksekusi, Tr.
Bagian yang dikerjakan kode: semua panah, validasi, pembuatan entitas, dependency, approval gate.

### 4.5 CEO ↔ Owner: permintaan resource

CEO adalah satu-satunya agent yang "berbicara" kepada Owner, dan itu terjadi lewat decision. Output task CEO decision:

```ts
{
  strategy: string,
  success_metrics: string[],
  budget_cap_usd: number,
  team: [                                   // usulan HRD, dirangkum CEO
    { role: "content_writer", runtime: "claude-cli", reason: "butuh menulis file artifact" },
    { role: "market_researcher", runtime: "openrouter", model: "…", reason: "cukup reasoning, lebih murah" }
  ],
  owner_requests: [
    { type: "provider",  key: "openrouter", reason: "2 role reasoning-only; estimasi CFO ±$X/bulan" },
    { type: "budget",    amount_usd: 20, period: "month", reason: "…" },
    { type: "tool",      key: "instagram",  reason: "Phase 6, belum dipakai di MVP" }
  ]
}
```

Saat Owner approve decision, orchestrator memprosesnya secara deterministic:

```text
untuk setiap anggota team:
   runtime sudah dikonfigurasi?  ── ya ──► buat/aktifkan agent
                │
               tidak
                ▼
   agent dibuat dengan status 'inactive' + event agent.waiting_provider
                │
   Owner: isi key di form provider (disimpan Virtual Office, bukan agent)
                ▼
   agent otomatis 'active', task yang menunggu jadi queued
```

Tidak perlu tabel `requests` di MVP: `owner_requests` disimpan di `decisions.content`, dan status pemenuhannya dapat diturunkan dari kondisi nyata (provider sudah ada atau belum, agent aktif atau belum). Tabel `approvals` generik baru dibuat di Phase 6 ketika ada permintaan di luar decision (approval tool berisiko).

Logic "jika task kind X selesai, buat task Y" disebut **playbook** — modul TypeScript biasa yang bereaksi terhadap event `task.completed`. Ada dua playbook: `strategic` dan `execution`. Reaksi harus idempotent (cek apakah task lanjutan sudah dibuat sebelum membuat).

---

## 5. Boundary modul

Struktur di §28 spesifikasi memiliki ~20 folder top-level. Untuk MVP itu terlalu terfragmentasi: sebagian besar folder akan berisi satu file. Saya mengusulkan 7 modul dengan aturan dependency satu arah.

```text
src/
├── domain/        Tipe entitas, state machine, aturan transisi. Pure TS, tanpa IO.
├── db/            Schema (Drizzle), migrations, repositories.
├── runtimes/      AgentRuntime interface + adapter (claude-cli/, fake/, nanti openrouter/).
├── agents/        Role definitions, prompt builder, output schemas (zod) per task kind.
├── orchestrator/  Worker loop, playbooks, event bus, lease/retry/timeout.
├── gateway/       (Phase 6) MCP server: tool registry, permission, policy, approval.
└── interface/     CLI (MVP) dan HTTP API (nanti, untuk dashboard).
```

Aturan dependency:

```text
interface ──► orchestrator ──► agents ──► domain
                   │              │
                   ├──► runtimes ─┘ (runtimes hanya kenal tipe RunRequest/RunResult)
                   └──► db ──► domain
gateway ──► db, domain
```

- `domain` tidak mengimpor apa pun. Ini tempat semua aturan bisnis dapat di-unit-test tanpa DB atau LLM.
- `runtimes` tidak tahu soal Task, Agent, atau Role. Ia hanya menerima "jalankan prompt ini di folder ini dengan batasan ini".
- Hanya `orchestrator` yang menulis perubahan state task.

**Runtime `fake`** adalah keputusan penting: runtime yang mengembalikan output terprogram. Semua lifecycle, playbook, retry, dan dependency bisa dites deterministic tanpa biaya LLM.

---

## 6. Terminal Agent Runtime abstraction

### 6.1 Revisi interface

Interface di §14 spesifikasi (`start / execute / resume / stop`) mengasumsikan session adalah proses yang hidup lama. Pada kenyataannya mode headless Claude Code dan Codex adalah **satu proses per invocation**; "session" adalah percakapan tersimpan yang bisa dilanjutkan lewat ID. Interface yang lebih jujur:

```ts
// src/runtimes/runtime.ts
export interface AgentRuntime {
  readonly id: RuntimeId;                 // 'claude-cli' | 'openrouter' | 'fake'
  run(req: RunRequest, signal: AbortSignal): Promise<RunResult>;
}

export interface RunRequest {
  workDir: string;                        // cwd proses agent
  systemPrompt: string;                   // identitas role + aturan
  prompt: string;                         // instruksi task + konteks
  resumeSessionId?: string;               // lanjutkan percakapan (repair/revisi)
  outputSchema: JSONSchema;               // structured output wajib
  nativeTools: NativeToolPolicy;          // read-only | workspace-write | none
  mcpServers?: McpServerConfig[];         // Tool Gateway (Phase 6)
  model?: string;
  timeoutMs: number;
}

export interface RunResult {
  status: 'ok' | 'error' | 'timeout' | 'aborted';
  externalSessionId: string;
  output: unknown;                        // divalidasi oleh pemanggil, bukan runtime
  error?: string;
  usage: { inputTokens?: number; outputTokens?: number; costUsdMicros?: number };
  durationMs: number;
  logPath: string;                        // raw stdout/stderr untuk debugging
}
```

- `start`+`execute` digabung karena tidak ada proses persisten yang perlu di-start.
- `resume` = `run` dengan `resumeSessionId`.
- `stop` = `AbortSignal` → kill child process. Timeout juga lewat sini.

### 6.2 Claude CLI adapter (runtime utama)

**Claude CLI adalah runtime utama**: dipakai default untuk semua role, dan wajib untuk task yang butuh workspace. Runtime lain (§6.4) adalah tambahan untuk menghemat kuota/biaya, bukan pengganti.

Pemetaan (flag sudah dicek terhadap `claude --help` versi 2.1.283):

| RunRequest | Flag `claude` |
|---|---|
| headless | `-p --output-format json` |
| `outputSchema` | `--json-schema '<schema>'` |
| `systemPrompt` | `--append-system-prompt` (atau `--system-prompt` untuk kontrol penuh) |
| session ID | `--session-id <uuid>` dibuat oleh orchestrator **sebelum** run, jadi ID tercatat walau proses crash |
| `resumeSessionId` | `--resume <id>` |
| `nativeTools` | `--allowedTools` / `--disallowedTools` + `--permission-mode` |
| `mcpServers` | `--mcp-config <file> --strict-mcp-config` (hanya MCP milik gateway) |
| `workDir` | `cwd` child process |
| env | env disanitasi: hanya PATH, `CLAUDE_CONFIG_DIR` (lihat di bawah), tanpa secret lain |
| isolasi setting | `--setting-sources project` + `--strict-mcp-config`; hooks/plugin/MCP pribadi Owner tidak ikut |

**Auth: login CLI (langganan), bukan API key.** Konsekuensinya:

- `--bare` tidak bisa dipakai (mode itu hanya menerima `ANTHROPIC_API_KEY`, OAuth tidak dibaca).
- Agar session agent tidak mewarisi konfigurasi pribadi Owner (hooks, plugin, CLAUDE.md global, auto-memory, MCP server), Virtual Office memakai **config dir terpisah**: `CLAUDE_CONFIG_DIR=~/.virtual-office/claude`, login sekali dengan perintah setup sekali jalan (membungkus `claude /login` dengan env tersebut). Login Claude pribadi Owner tetap tidak tersentuh.
- Spike langkah 6 wajib memverifikasi: (a) `CLAUDE_CONFIG_DIR` + OAuth berjalan di mode `-p`, (b) CLAUDE.md global tidak ikut termuat, (c) bentuk error saat rate limit tercapai.

**Rate limit langganan** diperlakukan sebagai kondisi normal, bukan kegagalan:

- Concurrency default `claude-cli` = 1 (dapat dinaikkan lewat config).
- **Quota guard (paket Pro):** Owner memakai paket **Pro**, kuota terkecil, dan kuota itu **dipakai bersama** dengan sesi Claude Code pribadi Owner (termasuk saat membangun proyek ini). Config `claude_cli.max_runs_per_window` (mis. 10 run per jendela 5 jam) dan `claude_cli.reserve_for_owner` membatasi Virtual Office secara deterministic agar tidak menghabiskan kuota Owner. Jika batas tercapai, task ditunda seperti rate limit. Angka awal dikalibrasi dari data spike, bukan ditebak.
- Model per role dikonfigurasi (`agents.model`), tidak di-hardcode. Default: model standar paket Pro; jangan mengasumsikan akses model teratas.
- Konteks prompt dibuat ramping: setiap task memulai session baru hanya dengan konteks yang relevan (bukan seluruh histori), karena panjang konteks langsung memakan kuota.
- Error rate limit → task kembali ke `queued` dengan `not_before` = waktu reset (jika diketahui dari pesan error) atau backoff eksponensial. **`attempt` tidak bertambah.**
- Selama runtime dalam cooldown, worker tidak meng-claim task untuk runtime itu (task untuk runtime lain tetap jalan).
- Event `runtime.rate_limited` / `runtime.resumed` tercatat, agar CFO dan Owner bisa melihat seberapa sering kuota habis. Data ini dasar keputusan memindahkan role reasoning-only ke OpenRouter.

**Biaya:** di langganan, biaya marginal per run adalah kuota, bukan uang. `cost_usd_micros` yang dilaporkan CLI disimpan sebagai **estimasi** (`cost_kind = 'estimate'`). Metrik utama untuk `claude-cli` adalah token dan durasi.

Output JSON `claude -p` menyertakan session id, hasil, dan usage/biaya; adapter memetakannya ke `RunResult`. Detail field diverifikasi di awal Phase 2 dengan spike kecil.

### 6.3 Output contract

Setiap task kind punya zod schema di `agents/schemas/`. Alurnya:

```text
zod schema ──► JSON Schema ──► --json-schema
                                    │
                               agent run
                                    │
RunResult.output ──► zod.parse ──► valid? ──► simpan result, completed
                                    │
                                 invalid ──► resume 1x dengan error ──► masih invalid ──► attempt gagal
```

Artifact (file konten, gambar) ditulis agent ke `workDir/out/`. Setelah run, orchestrator men-scan folder itu, menghitung sha256, dan mencatat ke tabel `artifacts`. Agent tidak perlu "melaporkan" artifact secara manual.

### 6.4 Runtime API (OpenRouter, dll.) dan capabilities

Runtime API memakai interface `AgentRuntime` yang sama. Bedanya ada di apa yang bisa dilakukan:

| Capability | `claude-cli` | `openrouter` |
|---|---|---|
| `structured_output` | ya (`--json-schema`) | ya (response_format / tool call, tergantung model) |
| `workspace_files` | ya | tidak |
| `web_research` | ya (WebSearch/WebFetch) | tidak (nanti via Gateway tool) |
| `resume` | ya (session tersimpan di CLI) | disimulasikan: adapter menyimpan transcript sendiri dan mengirim ulang |

```ts
export interface AgentRuntime {
  readonly id: RuntimeId;
  readonly capabilities: ReadonlySet<Capability>;
  run(req: RunRequest, signal: AbortSignal): Promise<RunResult>;
}
```

Kebutuhan per task kind (di `agents/`):

| Task kind | Butuh | Cocok untuk |
|---|---|---|
| framing, consultation, decision, planning, review | `structured_output` | CLI atau API |
| research | `structured_output`, `web_research` | CLI |
| work (menghasilkan file) | `structured_output`, `workspace_files` | CLI |

Assignment: `required ⊆ agent.runtime.capabilities`, dicek oleh kode. Jika tidak ada agent yang cocok, task tetap `pending` dan event `task.unassignable` muncul. Event ini menjadi input bagi HRD/CEO untuk mengusulkan agent baru.

Artifact dari runtime API: jika output berisi konten teks (mis. caption), orchestrator yang menulis file ke `out/`. Agent API tidak pernah menyentuh filesystem.

Credential provider (OpenRouter key) disimpan di config Virtual Office (MVP: file `.env` di luar workspace agent; nanti: tabel terenkripsi) dan hanya dibaca oleh adapter.

---

## 7. Permission boundary

Tiga lapis, dari yang paling dekat ke agent:

```text
┌──────────────────────────────────────────────────────────────┐
│ Lapis 3: Orchestrator authority                              │
│   Output agent = proposal. Kode memutuskan apakah diterapkan.│
│  ┌────────────────────────────────────────────────────────┐  │
│  │ Lapis 2: Tool Gateway (MCP server, Phase 6)            │  │
│  │   permission → policy/risk → approval → execute → audit│  │
│  │  ┌──────────────────────────────────────────────────┐  │  │
│  │  │ Lapis 1: Runtime sandbox                         │  │  │
│  │  │   cwd = workspace, native tools dibatasi,        │  │  │
│  │  │   env tanpa secret                               │  │  │
│  │  │        ┌──────────────┐                          │  │  │
│  │  │        │ Terminal agent│                         │  │  │
│  │  │        └──────────────┘                          │  │  │
│  │  └──────────────────────────────────────────────────┘  │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

### Lapis 1 — Runtime sandbox (MVP)

| Role | Native tools | Alasan |
|---|---|---|
| CEO, CFO, CTO, HRD, Manager | Read saja (shared knowledge) | Pekerjaan mereka adalah reasoning; output via structured JSON. |
| R&D | Read + WebSearch/WebFetch | Butuh riset web; tidak butuh shell. |
| Specialist (content, dll.) | Read/Write/Edit di workspace sendiri, tanpa Bash | Cukup untuk menghasilkan artifact teks. |
| Developer (nanti) | + Bash | Hanya setelah ada isolasi container. |

Keterbatasan yang diakui: pembatasan tools di level CLI bukan sandbox OS. Untuk tool berisiko nyata (publish, pembayaran), Phase 6 wajib menjalankan agent di container tanpa akses jaringan selain ke Gateway.

### Lapis 2 — Tool Gateway (Phase 6)

- Dijalankan Virtual Office sebagai MCP server; agent memanggilnya sebagai tool biasa.
- Setiap session menerima token yang di-scope ke `(agent_id, task_id, session_id, expires_at)`. Gateway tahu siapa yang memanggil tanpa mempercayai klaim agent.
- Alur: `role.allowed_tools ∩ task.scope` → risk level tool/argumen → `low` jalan, `high` → `approval` pending → Owner → execute dengan credential yang hanya ada di Gateway → event `tool.executed`.
- Credential tidak pernah masuk ke prompt, env, atau workspace agent.

### Lapis 3 — Authority matrix (MVP, dalam kode)

| Proposal | Diusulkan oleh | Diterapkan jika |
|---|---|---|
| Minta konsultasi executive | CEO | Role target ada dan aktif |
| Decision | CEO | Selalu jadi `proposed`; aktif setelah Owner approve |
| Rencana task | Manager | DAG valid, role ada, jumlah task ≤ batas, dalam scope decision |
| Assign/retry/reassign | Orchestrator (kode) | Aturan deterministic |
| Buat agent dari role existing | HRD | Batas jumlah agent per role tidak terlampaui |
| Buat role baru / tambah tool | HRD | **Owner approval** |
| Ubah objective, budget, policy | — | Hanya Owner |

---

## 8. Database schema minimum (MVP)

MySQL 8 (awalnya dirancang untuk PostgreSQL; diganti atas permintaan Owner, 2026-10-03). Tanpa Redis: antrian memakai `SELECT … FOR UPDATE SKIP LOCKED` (didukung MySQL 8) pada tabel `tasks`, yang cukup untuk satu proses dengan puluhan task per jam.

Sketsa SQL di bawah masih ditulis dengan dialek PostgreSQL; schema yang berlaku adalah `src/db/schema.ts` (MySQL). Perbedaan penting: `jsonb` → `JSON`, `uuid` → `VARCHAR(36)`, `timestamptz` → `DATETIME(3)` yang selalu UTC, dan tidak ada `RETURNING` (claim task memakai transaksi SELECT … FOR UPDATE SKIP LOCKED lalu UPDATE).

```sql
create table roles (
  id            text primary key,              -- 'ceo', 'manager', 'content_writer'
  name          text not null,
  department    text not null,                 -- 'executive', 'rnd', 'content'
  instructions  text not null,                 -- system prompt dasar role
  native_tools  text not null,                 -- 'read_only' | 'workspace_write' | 'research'
  created_at    timestamptz not null default now()
);

create table agents (
  id                   uuid primary key,
  role_id              text not null references roles(id),
  name                 text not null,
  runtime              text not null,           -- 'claude-cli' | 'openrouter' | 'fake'
  model                text,
  status               text not null default 'active',   -- active | inactive
  supervisor_agent_id  uuid references agents(id),
  workspace_path       text not null,
  created_by           text not null,           -- 'owner' | 'agent:<id>'
  created_at           timestamptz not null default now()
);

create table objectives (
  id              uuid primary key,
  title           text not null,
  description     text not null,
  constraints     jsonb not null default '{}', -- target, budget cap, deadline
  status          text not null,               -- new|strategizing|awaiting_approval|active|completed|failed|cancelled
  budget_usd_micros bigint,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table decisions (
  id            uuid primary key,
  objective_id  uuid not null references objectives(id),
  content       jsonb not null,                -- strategy, constraints, success_metrics
  status        text not null,                 -- proposed|approved|rejected|superseded
  proposed_by   text not null,
  reviewed_at   timestamptz,
  review_note   text,
  created_at    timestamptz not null default now()
);

create table projects (
  id             uuid primary key,
  objective_id   uuid not null references objectives(id),
  decision_id    uuid references decisions(id),
  title          text not null,
  plan_template  jsonb,                        -- rencana Manager, dipakai ulang oleh Schedule (Phase 7)
  status         text not null,                -- active|completed|failed|cancelled
  created_at     timestamptz not null default now()
);

create table tasks (
  id                 uuid primary key,
  objective_id       uuid not null references objectives(id),
  project_id         uuid references projects(id),
  kind               text not null,            -- framing|consultation|decision|planning|research|work|review
  title              text not null,
  instructions       text not null,
  input              jsonb not null default '{}',
  required_role_id   text references roles(id),
  assigned_agent_id  uuid references agents(id),
  status             text not null,            -- pending|queued|running|completed|failed|cancelled
  attempt            int not null default 0,
  max_attempts       int not null default 2,
  timeout_ms         int not null default 600000,
  lease_until        timestamptz,
  not_before         timestamptz,              -- ditunda (rate limit / backoff); tidak di-claim sebelum waktu ini
  result             jsonb,
  error              text,
  retry_of_task_id   uuid references tasks(id),
  requested_by       text not null,            -- 'owner' | 'orchestrator' | 'agent:<id>'
  created_at         timestamptz not null default now(),
  started_at         timestamptz,
  completed_at       timestamptz
);
create index tasks_queue_idx on tasks (status, created_at) where status = 'queued';

create table task_dependencies (
  task_id     uuid not null references tasks(id),
  depends_on  uuid not null references tasks(id),
  primary key (task_id, depends_on)
);

create table agent_sessions (
  id                   uuid primary key,       -- juga dipakai sebagai --session-id
  agent_id             uuid not null references agents(id),
  task_id              uuid not null references tasks(id),
  runtime              text not null,
  model                text,
  attempt              int not null,
  status               text not null,          -- running|ok|error|timeout|aborted
  input_tokens         int,
  output_tokens        int,
  cost_usd_micros      bigint,
  cost_kind            text,                   -- 'actual' (API key/OpenRouter) | 'estimate' (langganan)
  log_path             text,
  started_at           timestamptz not null default now(),
  ended_at             timestamptz
);

create table artifacts (
  id          uuid primary key,
  task_id     uuid not null references tasks(id),
  session_id  uuid references agent_sessions(id),
  path        text not null,                   -- relatif terhadap root workspaces
  mime_type   text,
  sha256      text not null,
  bytes       bigint not null,
  created_at  timestamptz not null default now()
);

create table events (
  id           bigserial primary key,
  type         text not null,                  -- task.completed, decision.approved, ...
  entity_type  text not null,
  entity_id    uuid not null,
  objective_id uuid,                           -- untuk query trace per objective
  actor        text not null,                  -- 'owner' | 'orchestrator' | 'agent:<id>'
  payload      jsonb not null default '{}',
  created_at   timestamptz not null default now()
);
create index events_objective_idx on events (objective_id, id);
```

Catatan desain:

- `status` disimpan sebagai `text` + validasi di domain layer, bukan tipe enum database. Enum sulit diubah lewat migration, dan state machine akan berevolusi.
- `events.objective_id` didenormalisasi agar halaman Objective cukup satu query berurutan.
- Biaya per task/project/objective = agregasi `agent_sessions` lewat join. Tidak perlu tabel cost terpisah di MVP.

---

## 9. Workspace

```text
workspaces/
├── shared/
│   └── knowledge/          (Phase 5) snapshot knowledge yang boleh dibaca semua agent
└── agents/<agent_id>/
    └── tasks/<task_id>/
        ├── context/        file input yang disiapkan orchestrator
        └── out/            artifact output — di-scan setelah run
```

Folder per task (bukan per agent saja) agar artifact setiap task terpisah dan tidak tertimpa oleh run berikutnya. DB tetap source of truth; filesystem hanya menyimpan file kerja.

---

## 10. MVP terkecil yang membuktikan konsep

Target §34: *Owner memberi objective → Virtual Office memproses → terminal agent bekerja → hasil kembali dan tercatat terstruktur.*

Dipecah menjadi tiga vertical slice. Setiap slice harus berjalan end-to-end sebelum slice berikutnya dimulai.

### Slice 1 — "Satu task, satu agent" (Phase 1 + 2)

```text
Owner (web UI): buat objective "Buat satu caption Instagram tentang kopi lokal"
  → objective(active), decision trivial (approved oleh owner)
  → 1 task kind=work, assigned ke agent content_writer
  → worker claim → ClaudeCliRuntime.run()
  → out/caption.md + result JSON tervalidasi
  → task completed, artifact tercatat, events tercatat
Owner (web UI): lihat status agent live di halaman Kantor + jejak di halaman Objective
```

Membuktikan: data model, task lifecycle, runtime adapter, structured output, artifact capture, event trail, pencatatan biaya.
Dites juga dengan runtime `fake` untuk jalur gagal: timeout, output invalid → repair → retry → failed.

### Slice 2 — "Manager merencanakan" (Phase 3)

Objective → task `planning` (Manager) → DAG `research → content → review` → eksekusi sesuai dependency → review accept/revise.

Membuktikan: playbook execution, dependency resolution, validasi rencana dari LLM, review loop terbatas.

### Slice 3 — "Strategic loop" (Phase 4)

Objective → CEO framing → konsultasi selektif → CEO decision → Owner approve → masuk Slice 2.

Membuktikan: selective consultation, decision approval gate, injeksi konteks antar-task.

**Use case untuk semua slice:** konten Instagram (§31), tanpa publish. Hasil akhirnya file `caption.md` + `brief.md` (deskripsi visual).

---

## 11. Stack

| Komponen | Pilihan | Alasan |
|---|---|---|
| Runtime | Node.js 22 + TypeScript | Sesuai spesifikasi; sudah terpasang. |
| DB | MySQL 8 (Docker di port 3307, atau MySQL lokal) | Permintaan Owner; MySQL lokal sudah terpasang. MySQL 8 mendukung `SKIP LOCKED` dan `JSON`. Driver: mysql2. |
| DB access | Drizzle ORM + drizzle-kit | Schema di TS (type-safe), migration SQL yang bisa dibaca. |
| Validasi | zod (+ `zod-to-json-schema`) | Satu sumber untuk validasi dan `--json-schema`. |
| Interface | Web UI sejak Slice 1: React (Vite) + HTTP API Fastify, update live via Server-Sent Events | Owner ingin memantau kantor sejak awal. SSE cukup untuk push status satu arah; tidak perlu WebSocket. |
| Tampilan kantor | Three.js (react-three-fiber), kamera ortografis isometrik, avatar & perabot voxel | Gaya blok/voxel sesuai keinginan Owner. Kamera ortografis memberi tampilan isometrik yang rapi, bisa zoom/rotasi, dan siap untuk animasi (avatar berjalan ke ruang rapat saat konsultasi). Posisi avatar diturunkan dari state agent di DB, bukan disimpan terpisah. |
| Test | vitest | Cepat; runtime `fake` untuk tes lifecycle. |
| Queue | MySQL `SKIP LOCKED` | Tidak perlu Redis untuk satu proses. |

Tidak dipakai di MVP: Redis, Kafka, WebSocket, container sandbox.

---

## 12. Implementation plan

| # | Langkah | Selesai jika |
|---|---|---|
| 1 | Scaffold: package.json, tsconfig, vitest, docker-compose MySQL, struktur folder §5 | `npm test` dan `docker compose up` jalan |
| 2 | `domain/`: state machine Objective, Decision, Task + unit test transisi | Semua transisi ilegal ditolak oleh test |
| 3 | `db/`: schema §8, migration, repository | Migration jalan di DB kosong |
| 4 | `runtimes/`: interface + `FakeRuntime` | — |
| 5 | `orchestrator/`: worker loop (claim, lease, timeout, retry, repair), event writer | Test integrasi dengan FakeRuntime: sukses, invalid→repair, timeout→retry→failed, crash→reclaim |
| 6 | Spike `claude -p --output-format json --json-schema` dengan `CLAUDE_CONFIG_DIR` terpisah + login CLI: catat format output, error rate limit, dan pastikan konfigurasi pribadi tidak ikut termuat | Contoh output sukses & error tersimpan sebagai fixture test |
| 7 | `ClaudeCliRuntime` adapter | Run nyata menghasilkan output valid + session id + usage |
| 8 | `interface/`: HTTP API + SSE, web UI halaman Kantor (denah, status agent, task, aktivitas) dan form objective | **Slice 1 selesai**, dipantau dari browser |
| 9 | Role Manager + playbook execution + dependency + review | **Slice 2 selesai** |
| 10 | OpenRouter adapter + capability matching + form provider di UI | Task review/planning berjalan di OpenRouter tanpa perubahan di luar `runtimes/openrouter/`; task `work` tidak bisa di-assign ke agent API |
| 11 | Role executive + playbook strategic + `decision approve/reject` | **Slice 3 selesai** |
| 12 | `owner_requests` di decision + aktivasi agent saat provider dikonfigurasi | CEO meminta provider, Owner set key, agent aktif otomatis |

Phase 5–8 (Knowledge, Tool Gateway, Scheduler, Observability/dashboard) didesain detail setelah Slice 3 stabil, dengan data biaya dan kualitas nyata dari slice sebelumnya.

---

## 13. Keputusan

Sudah diputuskan Owner (2026-10-03):

- **Claude CLI adalah runtime utama.** Runtime API (OpenRouter, dll.) ditambahkan kemudian untuk role reasoning-only. Codex tidak lagi di roadmap MVP.
- **CEO yang mengoordinasikan kebutuhan tim dengan Owner** lewat `owner_requests` di decision (A14, §4.5).
- **Antarmuka utama adalah web "Virtual Office" sejak awal** (bukan CLI) agar Owner bisa memantau. Desain UI: halaman Kantor (denah ruangan + status agent), Objective (jejak lengkap), Keputusan (tinjau usulan CEO + permintaan resource). Mode persetujuan keputusan bisa diatur Owner: selalu minta / otomatis-kabari; permintaan provider, budget, role baru, dan tool berisiko tetap selalu butuh Owner.
- **Claude CLI memakai login CLI (langganan Pro), bukan API key.** Concurrency 1, rate limit = penundaan, biaya = estimasi, config dir terpisah, quota guard agar kuota Owner tidak habis (§6.2).
- **OpenRouter adapter dimajukan sebelum strategic loop** (langkah 10). Alasan: satu strategic loop ≈ 7–10 run; di paket Pro itu bisa menghabiskan sebagian besar satu jendela kuota. Role executive yang hanya butuh reasoning lebih masuk akal di OpenRouter. Adapter tersedia lebih awal, tetapi pemakaiannya tetap lewat `owner_requests` CEO dan persetujuan Owner.

Masih menunggu konfirmasi:

1. **Decision CEO butuh approval Owner** secara default (A5). Ini juga titik di mana Owner menjawab `owner_requests`.
2. **Single-organization** di MVP (A11).


---

## 14. Organisasi dinamis, paralel, dan kantor modular (2026-10-03)

Keputusan Owner: bagian yang banyak pekerjaan punya staf sendiri; HRD bisa membuat ruangan (divisi) baru; kantor punya ruang rapat dan pantry; avatar punya aktivitas acak saat menganggur.

**Paralel sesuai kebutuhan.** Yang dibandingkan adalah *biaya akhir untuk pekerjaan yang sama*, bukan jumlah agent. Task yang memang independen dijalankan bersamaan (total token sama, hasil lebih cepat). Memecah satu pekerjaan ke lebih banyak agent hanya demi paralel menambah biaya dasar per sesi (±20–30 ribu token input), jadi tidak dilakukan: Manager tetap menyusun 1–4 task.
- **Satu karyawan, satu task.** Agent dipilih saat task diambil (staf role yang sedang menganggur), sehingga jumlah staf = kapasitas paralel sebenarnya.
- **Batas paralel adaptif** per runtime: turun separuh saat rate limit, naik satu per run berhasil, sampai batas konfigurasi.

**Aturan HRD menambah staf** (deterministik, `orchestrator/staffing.ts`): ada task siap kerja menunggu lebih lama dari ambang, semua staf role itu sibuk, runtime-nya punya slot dan tidak sedang cooldown/kuota habis. Slot penuh → tidak merekrut (tidak mempercepat apa pun), hanya dicatat. Di bawah batas staf per role → rekrut otomatis; di atas batas atau mode "ask" → persetujuan Owner. Jeda 10 menit antar rekrutan per role.

**Divisi dan role dinamis.** Tabel `departments`; `roles` punya `plannable/task_kind/description` sehingga Manager melihat daftar role dari database. Role/divisi baru lewat tool `propose_org_change` (khusus HRD, risiko tinggi → persetujuan Owner) atau langsung oleh Owner. Role baru hanya mendapat tool risiko rendah (A6).

**Kantor modular** (`web/src/office/`): `layout.ts` menyusun gedung dari divisi (ukuran ruangan mengikuti jumlah staf, dua baris ruangan + koridor, pintu ke koridor, maksimal 6 divisi per lantai); `pathfinding.ts` A* di grid 0,5 ubin; `behavior.ts` mesin perilaku avatar (murni kosmetik di browser, tanpa kuota). Prioritas perilaku mengikuti kondisi nyata: rapat > serah-terima hasil > bekerja di meja > aktivitas acak (hanya saat benar-benar menganggur). Pantry dan tempatnya (mesin kopi, sofa, jendela) dipakai satu orang per tempat.
