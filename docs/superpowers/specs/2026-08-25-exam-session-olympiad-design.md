# Design: Sesi Pengerjaan Exam Olimpiade

- **Tanggal**: 2026-08-25
- **Status**: Approved (menunggu review spec)
- **Scope**: Fitur sesi (session) untuk exam bertipe `OLYMPIAD` — konfigurasi jadwal & penugasan tim dari admin dashboard, gating tombol pengerjaan di user dashboard.
- **Non-goals**: Mengubah perilaku exam `TRYOUT`; membuat UI CRUD Exam; seeder data sesi; multi-attempt per tim; auto-finish saat sesi berakhir.

---

## 1. Latar Belakang & Masalah

Saat ini gating pengerjaan exam olimpiade hanya memakai window global `Exam.startDate–endDate`:

- `OlimpiadeSection.tsx` (`ExamList`): status tombol dari `exam.startDate/endDate`.
- `ExamAttemptService.startExam`: validasi `now ∈ [exam.startDate, exam.endDate]` sebelum upsert attempt.

Semua tim bisa mulai bersamaan dalam satu window besar. Kebutuhan lomba: peserta dibagi ke **beberapa sesi** (mis. Sesi 1 = 07.00–10.00 untuk tim 1–100) agar server/beban ujian terdistribusi dan jadwal rapi.

## 2. Kebutuhan (dari pemilik produk)

1. Admin dapat mengatur **jam start & end tiap sesi** (tanpa seeder — semua via admin dashboard).
2. Admin dapat menentukan **tim mana yang masuk tiap sesi**, mis. tim 1–100 → Sesi 1, 101–200 → Sesi 2, 201–300 → Sesi 3 (berdasar nomor suffix kode tim, format `OLM-001`).
3. **Hanya untuk exam type `OLYMPIAD`**, bukan `TRYOUT`.
4. User dashboard menampilkan **gembok/locked** jika sesi timnya belum mulai.
5. Migrasi DB harus **additive** — tidak boleh mengubah/menghapus migrasi lama karena sudah ada data produksi.

## 3. Keputusan Desain (hasil diskusi)

| # | Keputusan | Alasan |
|---|---|---|
| D1 | Sesi didefinisikan **per exam**; **1 tim = 1 sesi per exam** | Sederhana, cocok dengan constraint attempt unik `[teamId, examId]` |
| D2 | Tim mulai mendekati akhir sesi tetap dapat **durasi penuh**, boleh melewati akhir sesi | Sesi hanya mengatur kapan boleh MULAI |
| D3 | Setelah mulai, boleh lanjut melewati akhir sesi selama ujian dimulai dalam window sesi | Konfirmasi eksplisit user |
| D4 | Exam OLYMPIADE **tanpa sesi** → fallback perilaku lama (window exam); punya sesi tapi tim belum di-assign → locked | Backward-compatible, produksi aman sebelum admin setup |
| D5 | Deadline efektif tetap `min(attempt.startTime + duration, exam.endDate)` | Logika existing tidak berubah |
| D6 | Pendekatan DB: **2 tabel baru additive** (bukan 1-exam-per-sesi / JSON column) | Integritas relasional, nol dampak ke leaderboard/attempt/report |

## 4. Data Model

### 4.1 Model baru

```prisma
model ExamSession {
  id        String   @id @default(uuid())
  name      String                    // "Sesi 1"
  startTime DateTime
  endTime   DateTime
  examId    String
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  exam      Exam              @relation(fields: [examId], references: [id], onDelete: Cascade)
  teams     ExamSessionTeam[]

  @@unique([examId, name])
  @@map("exam_session")
}

model ExamSessionTeam {
  id        String   @id @default(uuid())
  sessionId String
  teamId    String
  examId    String    // denormalisasi dari session.examId → constraint 1-tim-1-sesi-per-exam di level DB
  createdAt DateTime @default(now())
  session   ExamSession @relation(fields: [sessionId], references: [id], onDelete: Cascade)
  team      Team        @relation(fields: [teamId], references: [id], onDelete: Cascade)

  @@unique([teamId, examId])
  @@map("exam_session_team")
}
```

### 4.2 Relasi balik (wajib Prisma)

- `Exam.sessions ExamSession[]`
- `Team.sessionAssignments ExamSessionTeam[]`

### 4.3 Rencana Migrasi (aman produksi)

1. Edit `prisma/schema.prisma` (tambah 2 model + 2 back-relation).
2. Jalankan `pnpm prisma migrate dev --name add_exam_sessions` → SQL hasilnya murni:
   - `CREATE TABLE "exam_session" (...)`
   - `CREATE TABLE "exam_session_team" (...)`
   - `CREATE UNIQUE INDEX ...` + FK constraint (mengarah KE tabel lama, bukan mengubah isi tabel lama).
3. Tidak ada `ALTER TABLE ... DROP`, tidak ada data migration, tidak ada seeder.
4. Urutan rilis: jalankan migrasi di produksi **sebelum** deploy kode baru (kode lama mengabaikan tabel baru — aman).
5. Rollback: kode lama kompatibel dengan skema baru; drop kedua tabel jika perlu membatalkan.

## 5. Aturan Gating (sumber kebenaran)

Berlaku untuk `exam.type === 'OLYMPIAD'`; `TRYOUT` sepenuhnya tidak tersentuh.

| Kondisi | Server (`startExam`) | UI tombol (user dashboard) |
|---|---|---|
| Exam belum punya sesi | Fallback: validasi window `exam.startDate–endDate` (existing) | Logika existing (Aktif/Segera/Ditutup) |
| Punya sesi, tim belum di-assign | Tolak: `"Tim belum di-assign ke sesi ujian"` (400) | 🔒 disabled "Belum Ada Sesi" |
| Ter-assign, `now < session.startTime` | Tolak: `"Sesi ujian belum dimulai"` (400) | 🔒 disabled "Sesi Belum Dimulai" (+ info jam sesi) |
| Ter-assign, `now ∈ [start, end]` | Izinkan mulai/upsert attempt | Aktif → "Mulai Kerjakan" / "Lanjutkan Ujian" |
| Ter-assign, `now > session.end`, attempt belum ada | Tolak: `"Sesi ujian telah berakhir"` (400) | Disabled "Waktu Habis" |
| Ter-assign, `now > session.end`, attempt sudah ada & belum finished | **Izinkan resume** (D3) — deadline tetap D5 | "Lanjutkan Ujian" selama `remaining > 0` |

**Batas mutlak pengerjaan**: untuk SEMUA tim (termasuk yang sesinya masih terbuka atau durasi belum habis), `exam.endDate` adalah hard-stop — begitu tercapai, attempt auto-finish (timer klien `submitAuto` + server `saveAnswer`/`getExamSession`). Sesi tidak pernah memperpanjang melewati `exam.endDate`.

Detail implementasi `startExam`: pengecekan sesi dilakukan **SEBELUM** `upsertAttempt` (agar attempt baru tidak tercipta di luar window). Jika attempt sudah ada → alur resume normal tanpa cek window sesi (hanya cek deadline existing).

## 6. Perubahan Backend

Pola existing dipertahankan: `src/server/*.ts` (createServerFn + withErrorHandling) → `lib/api/<mod>/service.ts` → `repo.ts`.

**Catatan auth**: guard admin saat ini hanya di router (`beforeLoad` `_authed.tsx`); belum ada helper server-side. Tambahkan `requireAdminSession()` di `src/lib/utils/server-auth.ts` (mirror `requireTeamSession`, cek `role === 'ADMIN'`) dan wajibkan pada semua server function sesi — agar gating/CRUD tidak bisa dipanggil oleh tim via API langsung.

### 6.1 Modul baru `exam-session`
File:
- `src/server/exam-session.ts` — server functions:
  - `getExamSessions({ examId })` (GET, admin)
  - `createExamSession({ examId, name, startTime, endTime })` (POST, admin)
  - `updateExamSession({ id, name?, startTime?, endTime? })` (POST, admin)
  - `deleteExamSession({ id })` (POST, admin)
  - `assignTeamsToSession({ sessionId, codeFrom, codeTo })` (POST, admin)
  - `removeTeamFromSession({ sessionId, teamId })` (POST, admin)
- `src/lib/api/exam-sessions/exam-session.service.ts` + `exam-session.repo.ts`
- `src/schemas/exam-session.schema.ts` (zod: uuid, nama non-kosong, datetime ISO, `endTime > startTime`, range `codeFrom ≤ codeTo`, nomor 1..9999)

### 6.2 Aturan assign by range
- Filter kandidat: `team.competitionType` = tipe kompetisi exam (via `stage.competition.name`), kode tim cocok prefix kompetisi, DAN `team.registration.status = 'APPROVED'` (hanya tim yang registrasinya sudah diverifikasi admin). Karena kode tim memang difinalisasi saat approval, semua kandidat yang lolos filter ini punya kode parseable.
- Resolve nomor = `parseInt(code.split("-")[1])`; ambil tim dengan nomor ∈ `[codeFrom, codeTo]`.
- Operasi = **upsert/move**: tim yang sudah tergabung di sesi lain pada exam yang sama dipindah ke sesi target (memanfaatkan unique `[teamId, examId]` → `upsert`). Respons menyertakan jumlah tim yang di-assign/dipindah/dilewati (kode tak valid).
- Transaksi `$transaction` untuk konsistensi.

### 6.3 Perubahan modul existing
- `exam.repo.getExamsByStageCompetitionType`: include `sessions { id name startTime endTime }` + `mySession` (sesi tim tersebut, bila ada) → payload UI.
- `exam-attempt.repo/service.startExam`: tambahkan cabang gating OLYMPIAD sesuai tabel §5 (query assignment + sesi sebelum upsert).
- `getExamSession`/`resumeExam`/`saveAnswer`: **tidak berubah** (deadline D5 sudah benar).

## 7. Perubahan Frontend

### 7.1 User dashboard (`OlimpiadeSection.tsx`)
Untuk exam OLYMPIADE, hitung status dari `mySession` (bukan window exam):
- `mySession == null && sessions.length > 0` → kartu gembok "Tim kamu belum di-assign ke sesi".
- `now < mySession.startTime` → gembok "Sesi Belum Dimulai" + badge nama sesi & baris tanggal·jam.
- `now ∈ [startTime, endTime]` → tombol aktif (Mulai/Lanjutkan).
- `now > endTime`:
  - attempt ada & unfinished → "Lanjutkan Ujian".
  - else → "Waktu Habis".
- `sessions.length === 0` → logika existing (fallback D4).

Badge format: `{namaSesi} · Mulai {jam}` di samping badge status. Baris detail di bawah: `🕐 Mulai sesimu: {tanggal} · {jam mulai} – {jam selesai}` (tanggal singkat selalu ditampilkan, termasuk saat lintas hari).

Timer refresh 30s existing dipertahankan.

### 7.2 Admin dashboard
- Route baru `/dashboard/admin/exams/$examId/sessions` (file-based route) + link "Kelola Sesi" pada `ExamCard` (hanya `exam.type === 'OLYMPIAD'`).
- Halaman berisi:
  - Daftar sesi (Card): nama, rentang waktu, jumlah tim; aksi edit/hapus (Dialog + konfirmasi).
  - Form create sesi: nama + `datetime-local` start/end.
  - Panel assign: input `codeFrom`–`codeTo` (prefix otomatis dari kompetisi, mis. `OLM`) → preview ringkas → submit; daftar tim ter-assign (nomor kode, nama sekolah) dengan tombol hapus per tim.
- Komponen mengikuti konvensi repo: shadcn ui (`Card`, `Dialog`, `Table`, `Badge`, `Button`), react-query query-options di `lib/api/exam-sessions/exam-session.query-options.ts`.

## 8. Edge Cases

1. Tim mulai 09.50 di sesi 07.00–10.00 (durasi 120') → boleh, selesai maksimal `09:50+120'` atau `exam.endDate` (mana lebih awal).
2. Tim refresh halaman setelah sesi berakhir tapi masih dalam durasi → resume berhasil (attempt sudah ada).
3. Tim belum pernah mulai & sesi lewat → ditolak server + tombol mati di UI.
4. Range assignment memuat tim yang sudah di sesi lain → dipindah (last-write-wins), dilaporkan di respons.
5. Kode tim tidak parseable/tidak ada → dilewati, dilaporkan sebagai skipped.
6. Admin hapus sesi yang masih punya tim → assignment ikut terhapus (`onDelete: Cascade`); tim kembali fallback D4 (jika exam jadi tanpa sesi) atau harus di-assign ulang.
7. `endTime <= startTime` → ditolak validasi zod di server.
8. Tim mulai sesi terakhir (mis. 13–16) tetapi durasi penuh melewati 16.00 → auto-finish saat `exam.endDate` tercapai oleh timer klien (`submitAuto`) atau oleh server (`saveAnswer`/`getExamSession`). Sesi TIDAK memperpanjang melewati `exam.endDate`.

## 9. Verifikasi

Repo tidak memiliki test framework; verifikasi standar repo:

1. `pnpm build` → `vite build` + `tsc --noEmit` lolos.
2. `pnpm prisma migrate dev` di lokal → hanya CREATE TABLE (inspeksi folder migrasi baru).
3. QA manual (lokal):
   - Buat 2 sesi (mis. 07–10, 13–16) di exam Penyisihan OLIMPIADE; assign range tim.
   - Skenario §8.1–§8.3 dari sisi UI **dan** bypass URL langsung ke `/dashboard/team/exam/$examId` di luar window → harus ditolak server.
   - Regresi TRYOUT: alur tryout berjalan seperti semula.
   - Fallback: exam OLYMPIADE tanpa sesi tetap bisa dikerjakan dalam window exam.
4. Produksi: backup DB → `prisma migrate deploy` → verifikasi tabel baru kosong & data lama utuh → deploy aplikasi.

## 10. File yang Berubah (ringkas)

| Aksi | File |
|---|---|
| Edit | `prisma/schema.prisma` |
| Baru (migrasi) | `prisma/migrations/<ts>_add_exam_sessions/migration.sql` |
| Edit | `src/lib/api/exams/exam.repo.ts` |
| Edit | `src/lib/api/exam-attempts/exam-attempt.service.ts`, `exam-attempt.repo.ts` |
| Edit | `src/components/dashboard/team/OlimpiadeSection.tsx` |
| Edit | `src/components/dashboard/admin/exams/ExamCard.tsx` |
| Baru | `src/server/exam-session.ts`, `src/lib/api/exam-sessions/*` (service/repo/query-options/schema), komponen admin sesi, route `admin/exams/$examId/sessions/index.tsx` |
