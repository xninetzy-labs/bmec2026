# Exam Session Olympiad Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Menambahkan konsep **sesi pengerjaan** untuk exam bertipe `OLYMPIAD` (bukan `TRYOUT`): admin mengatur jadwal sesi & assign tim per sesi dari dashboard; tombol pengerjaan di dashboard tim terkunci (gembok) jika sesi timnya belum mulai.

**Architecture:** Dua tabel Prisma baru yang murni additive (`exam_session`, `exam_session_team`) dengan constraint DB "1 tim = 1 sesi per exam". Gating ditegakkan dua lapis: server (`startExam` memvalidasi sesi SEBELUM attempt dibuat) dan UI (`OlimpiadeSection`). Modul baru mengikuti pola repo: `server/*.ts` (createServerFn) → `lib/api/*/service.ts` → `repo.ts`.

**Tech Stack:** TanStack Start (createServerFn), TanStack Router (file routes), TanStack Query, Prisma 7 + PostgreSQL, react-hook-form + zod, sonner, shadcn/radix ui.

## Global Constraints

- **Migrasi harus additive**: hanya `CREATE TABLE`, `CREATE INDEX/CONSTRAINT`. DILARANG mengedit/menghapus folder migrasi lama atau melakukan `DROP`/data-migration (produksi sudah berisi data).
- **Tanpa seeder** untuk sesi — semua dibuat admin lewat UI.
- **Alur `TRYOUT` tidak boleh berubah** sama sekali.
- Fallback: exam `OLYMPIAD` **tanpa sesi** → perilaku lama (window `exam.startDate–endDate`). Punya sesi tapi tim belum di-assign → terkunci.
- Setelah ujian **dimulai dalam window sesi**, boleh lanjut melewati akhir sesi (durasi penuh); deadline efektif tetap `min(startTime + duration, exam.endDate)` — logika existing.
- Repo **tidak punya test framework** → verifikasi per task = `pnpm build` (= `vite build && tsc --noEmit`) + QA manual pada task UI/logika. Jangan menambah framework test baru (YAGNI).
- **Commit hanya setelah persetujuan eksplisit user** (aturan operasi repo). Pesan commit disiapkan di tiap task.
- Copy user-facing dalam Bahasa Indonesia.
- Ikuti pola existing: `withErrorHandling` wrapper, `successResponse(data, message)`, `AppError(msg, status)`.

**Spec:** `docs/superpowers/specs/2026-08-25-exam-session-olympiad-design.md`

---

### Task 1: Prisma Schema + Migrasi Additive

**Files:**
- Modify: `prisma/schema.prisma` (model `Exam` ~baris 168, `Team` ~baris 9, tambah model baru di akhir dekat `ExamAttempt`)
- Create: `prisma/migrations/<timestamp>_add_exam_sessions/migration.sql` (dihasilkan prisma)

**Interfaces:**
- Produces: model `ExamSession` (tabel `exam_session`, unique `examId_name`), model `ExamSessionTeam` (tabel `exam_session_team`, unique `teamId_examId`), relasi `Exam.sessions`, `ExamSession.assignments`, `Team.sessionAssignments`. Semua task berikutnya bergantung pada nama-nama ini.

- [ ] **Step 1: Tambah relasi balik di `Team`**

Di `prisma/schema.prisma`, pada model `Team` tambahkan field relasi (letakkan di dekat `attempts ExamAttempt[]`):

```prisma
  attempts        ExamAttempt[]
  sessionAssignments ExamSessionTeam[]
```

- [ ] **Step 2: Tambah relasi balik di `Exam`**

Pada model `Exam` tambahkan:

```prisma
  attempts  ExamAttempt[]
  questions ExamQuestion[]
  sessions  ExamSession[]
```

(field `sessions` yang baru; dua lainnya sudah ada)

- [ ] **Step 3: Tambah dua model baru**

Tambahkan di akhir blok model exam-related (setelah `ExamAnswer` misalnya):

```prisma
model ExamSession {
  id        String   @id @default(uuid())
  name      String
  startTime DateTime
  endTime   DateTime
  examId    String
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  exam      Exam              @relation(fields: [examId], references: [id], onDelete: Cascade)
  assignments ExamSessionTeam[]

  @@unique([examId, name])
  @@map("exam_session")
}

model ExamSessionTeam {
  id        String   @id @default(uuid())
  sessionId String
  teamId    String
  examId    String
  createdAt DateTime @default(now())
  session   ExamSession @relation(fields: [sessionId], references: [id], onDelete: Cascade)
  team      Team        @relation(fields: [teamId], references: [id], onDelete: Cascade)

  @@unique([teamId, examId])
  @@map("exam_session_team")
}
```

Catatan: `examId` di `ExamSessionTeam` adalah denormalisasi dari `session.examId` agar "1 tim = 1 sesi per exam" dijamin constraint DB (`teamId_examId`).

- [ ] **Step 4: Generate migrasi**

Run: `pnpm prisma migrate dev --name add_exam_sessions`
Expected: migrasi sukses, client ter-regenerate. Buka folder `prisma/migrations/<timestamp>_add_exam_sessions/migration.sql`.

- [ ] **Step 5: Verifikasi SQL additive-only**

Baca `migration.sql` dan pastikan HANYA berisi pola berikut (tanpa `DROP`, tanpa `ALTER TABLE ... DROP/ALTER COLUMN`, tanpa data update):

```sql
CREATE TABLE "exam_session" (...);
CREATE TABLE "exam_session_team" (...);
CREATE UNIQUE INDEX "exam_session_examId_name_key" ON "exam_session"(...);
CREATE UNIQUE INDEX "exam_session_team_teamId_examId_key" ON "exam_session_team"(...);
-- + beberapa CREATE INDEX dan ADD CONSTRAINT FOREIGN KEY (mengarah KE tabel lama)
```

Jika ada `DROP`/perubahan kolom lama → STOP, perbaiki schema, hapus migrasi yang BARU dibuat itu (`rm -r prisma/migrations/<timestamp_baru>`) lalu ulangi Step 4. Folder migrasi LAMA tidak boleh disentuh.

- [ ] **Step 6: Build**

Run: `pnpm build`
Expected: BUILD PASS (tidak ada error TypeScript).

- [ ] **Step 7: Commit (setelah approval user)**

```bash
git add prisma/schema.prisma prisma/migrations/
git commit -m "feat(db): add exam_session & exam_session_team tables (additive)"
```

---

### Task 2: Guard Admin Server-Side + Skema Zod

**Files:**
- Modify: `src/lib/utils/server-auth.ts`
- Create: `src/schemas/exam-session.schema.ts`

**Interfaces:**
- Produces: `requireAdminSession(): Promise<string>` (melempar `AppError('Sesi admin tidak valid', 401)` jika role bukan ADMIN; mengembalikan adminId). Schema: `createExamSessionSchema`→`CreateExamSessionData`, `updateExamSessionSchema`→`UpdateExamSessionData`, `assignTeamsToSessionSchema`→`AssignTeamsToSessionData`, `examSessionIdSchema` (`{ id: uuid }`), `examSessionsQuerySchema` (`{ examId: uuid }`), `removeTeamFromSessionSchema` (`{ sessionId: uuid, teamId: uuid }`).

- [ ] **Step 1: Tambah `requireAdminSession` di `src/lib/utils/server-auth.ts`**

Append di akhir file (mirror `requireTeamSession` yang sudah ada):

```ts
export async function requireAdminSession() {
  const session = await useAppSession()
  const adminId = session.data.userId

  if (!adminId || session.data.role !== 'ADMIN') {
    throw new AppError('Sesi admin tidak valid', 401)
  }

  return adminId
}
```

- [ ] **Step 2: Buat `src/schemas/exam-session.schema.ts`**

```ts
import { z } from 'zod'

// datetime-local dari browser ("2026-08-26T07:00") dikonversi via z.coerce.date
export const createExamSessionSchema = z
  .object({
    examId: z.string().uuid(),
    name: z.string().min(1, 'Nama sesi wajib diisi').max(100),
    startTime: z.coerce.date(),
    endTime: z.coerce.date(),
  })
  .refine((d) => d.endTime > d.startTime, {
    message: 'Jam selesai harus setelah jam mulai',
    path: ['endTime'],
  })

export type CreateExamSessionData = z.output<typeof createExamSessionSchema>

export const updateExamSessionSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().min(1).max(100).optional(),
    startTime: z.coerce.date().optional(),
    endTime: z.coerce.date().optional(),
  })
  .refine(
    (d) => !d.startTime || !d.endTime || d.endTime > d.startTime,
    {
      message: 'Jam selesai harus setelah jam mulai',
      path: ['endTime'],
    },
  )

export type UpdateExamSessionData = z.output<typeof updateExamSessionSchema>

export const examSessionIdSchema = z.object({ id: z.string().uuid() })

export const examSessionsQuerySchema = z.object({ examId: z.string().uuid() })

export const assignTeamsToSessionSchema = z
  .object({
    sessionId: z.string().uuid(),
    codeFrom: z.coerce.number().int().min(1).max(9999),
    codeTo: z.coerce.number().int().min(1).max(9999),
  })
  .refine((d) => d.codeTo >= d.codeFrom, {
    message: 'Range nomor tim tidak valid',
    path: ['codeTo'],
  })

export type AssignTeamsToSessionData = z.output<typeof assignTeamsToSessionSchema>

export const removeTeamFromSessionSchema = z.object({
  sessionId: z.string().uuid(),
  teamId: z.string().uuid(),
})
```

- [ ] **Step 3: Build**

Run: `pnpm build`
Expected: BUILD PASS.

- [ ] **Step 4: Commit (setelah approval user)**

```bash
git add src/lib/utils/server-auth.ts src/schemas/exam-session.schema.ts
git commit -m "feat(auth): add requireAdminSession guard + exam session zod schemas"
```

---

### Task 3: Repo + Service `exam-sessions`

**Files:**
- Create: `src/lib/api/exam-sessions/exam-session.repo.ts`
- Create: `src/lib/api/exam-sessions/exam-session.service.ts`

**Interfaces:**
- Consumes: skema dari Task 2 (`CreateExamSessionData`, `UpdateExamSessionData`, `AssignTeamsToSessionData`), `AppError`.
- Produces (dipakai Task 4):
  - `ExamSessionService`: `list(examId): Promise<{data, message}>`, `create(data: CreateExamSessionData)`, `update(data: UpdateExamSessionData)`, `remove(id: string)`, `assign(input: AssignTeamsToSessionData)`, `removeTeam(input: {sessionId, teamId})` — semuanya `Promise<{data, message}>`.
  - `ExamSessionRepo`: `findManyByExamId`, `findExamMeta`, `createSession`, `updateSession`, `deleteSession`, `findSessionById`, `findTeamsByCompetition`, `assignTeams`, `removeTeamAssignment`.

- [ ] **Step 1: Buat `src/lib/api/exam-sessions/exam-session.repo.ts`**

```ts
import { prisma } from '~/lib/utils/prisma'

export default class ExamSessionRepo {
  findManyByExamId(examId: string) {
    return prisma.examSession.findMany({
      where: { examId },
      orderBy: { startTime: 'asc' },
      include: {
        assignments: {
          include: {
            team: {
              select: { id: true, code: true, name: true, schoolName: true },
            },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    })
  }

  findExamMeta(examId: string) {
    return prisma.exam.findUnique({
      where: { id: examId },
      select: {
        id: true,
        type: true,
        stage: { select: { competition: { select: { name: true } } } },
      },
    })
  }

  findSessionById(id: string) {
    return prisma.examSession.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        startTime: true,
        endTime: true,
        exam: {
          select: {
            id: true,
            stage: { select: { competition: { select: { name: true } } } },
          },
        },
      },
    })
  }

  createSession(data: {
    examId: string
    name: string
    startTime: Date
    endTime: Date
  }) {
    return prisma.examSession.create({ data, select: { id: true } })
  }

  updateSession(
    id: string,
    data: { name?: string; startTime?: Date; endTime?: Date },
  ) {
    return prisma.examSession.update({ where: { id }, data, select: { id: true } })
  }

  deleteSession(id: string) {
    return prisma.examSession.delete({ where: { id }, select: { id: true } })
  }

  findTeamsByCompetition(competitionName: string) {
    return prisma.team.findMany({
      where: {
        competitionType: competitionName as any,
        registration: { status: 'APPROVED' }, // hanya tim terverifikasi
      },
      select: { id: true, code: true, name: true },
    })
  }

  assignTeams(sessionId: string, teamIds: string[]) {
    return prisma.$transaction(async (tx) => {
      const session = await tx.examSession.findUniqueOrThrow({
        where: { id: sessionId },
        select: { id: true, name: true, examId: true },
      })

      let added = 0
      let moved = 0

      for (const teamId of teamIds) {
        const existing = await tx.examSessionTeam.findUnique({
          where: {
            teamId_examId: { teamId, examId: session.examId },
          },
          select: { id: true, sessionId: true },
        })

        if (existing?.sessionId === sessionId) continue

        if (existing) moved += 1
        else added += 1

        await tx.examSessionTeam.upsert({
          where: {
            teamId_examId: { teamId, examId: session.examId },
          },
          update: { sessionId },
          create: { sessionId, teamId, examId: session.examId },
        })
      }

      return { sessionName: session.name, added, moved }
    })
  }

  removeTeamAssignment(sessionId: string, teamId: string) {
    return prisma.examSessionTeam.deleteMany({
      where: { sessionId, teamId },
    })
  }
}
```

Catatan: nama compound unique hasil Prisma untuk `@@unique([teamId, examId])` adalah `teamId_examId` — dipakai `upsert/findUnique where` di atas.

- [ ] **Step 2: Buat `src/lib/api/exam-sessions/exam-session.service.ts`**

```ts
import { Prisma } from '@prisma/client'
import { AppError } from '~/lib/utils/app-error'
import ExamSessionRepo from './exam-session.repo'
import type {
  AssignTeamsToSessionData,
  CreateExamSessionData,
  UpdateExamSessionData,
} from '~/schemas/exam-session'

function parseCodeNumber(code: string | null): number {
  if (!code) return Number.NaN
  const n = Number.parseInt(code.split('-')[1] ?? '', 10)
  return Number.isNaN(n) ? Number.NaN : n
}

export default class ExamSessionService {
  private repo = new ExamSessionRepo()

  async list(examId: string) {
    const sessions = await this.repo.findManyByExamId(examId)
    return { data: sessions, message: 'Berhasil memuat sesi' }
  }

  async create(data: CreateExamSessionData) {
    const exam = await this.repo.findExamMeta(data.examId)
    if (!exam) throw new AppError('Ujian tidak ditemukan', 404)
    if (exam.type !== 'OLYMPIAD') {
      throw new AppError('Sesi hanya tersedia untuk ujian Olimpiade', 400)
    }

    try {
      const session = await this.repo.createSession({
        examId: data.examId,
        name: data.name,
        startTime: data.startTime,
        endTime: data.endTime,
      })
      return { data: session, message: 'Sesi berhasil dibuat' }
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new AppError('Nama sesi sudah dipakai pada ujian ini', 400)
      }
      throw error
    }
  }

  async update(data: UpdateExamSessionData) {
    const session = await this.repo.findSessionById(data.id)
    if (!session) throw new AppError('Sesi tidak ditemukan', 404)

    const startTime = data.startTime ?? session.startTime
    const endTime = data.endTime ?? session.endTime
    if (endTime <= startTime) {
      throw new AppError('Jam selesai harus setelah jam mulai', 400)
    }

    try {
      const updated = await this.repo.updateSession(data.id, {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.startTime !== undefined ? { startTime: data.startTime } : {}),
        ...(data.endTime !== undefined ? { endTime: data.endTime } : {}),
      })
      return { data: updated, message: 'Sesi berhasil diperbarui' }
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new AppError('Nama sesi sudah dipakai pada ujian ini', 400)
      }
      throw error
    }
  }

  async remove(id: string) {
    const session = await this.repo.findSessionById(id)
    if (!session) throw new AppError('Sesi tidak ditemukan', 404)

    await this.repo.deleteSession(id)
    return { data: null, message: 'Sesi berhasil dihapus' }
  }

  async assign(input: AssignTeamsToSessionData) {
    const session = await this.repo.findSessionById(input.sessionId)
    if (!session) throw new AppError('Sesi tidak ditemukan', 404)

    const candidates = await this.repo.findTeamsByCompetition(
      session.exam.stage.competition.name,
    )

    const matched = candidates.filter((team) => {
      const num = parseCodeNumber(team.code)
      return (
        !Number.isNaN(num) && num >= input.codeFrom && num <= input.codeTo
      )
    })

    if (matched.length === 0) {
      throw new AppError(
        `Tidak ada tim dengan nomor kode ${input.codeFrom}-${input.codeTo}`,
        400,
      )
    }

    const result = await this.repo.assignTeams(
      input.sessionId,
      matched.map((t) => t.id),
    )

    return {
      data: {
        requested: input.codeTo - input.codeFrom + 1,
        matched: matched.length,
        added: result.added,
        moved: result.moved,
      },
      message: `${result.added} tim ditambahkan, ${result.moved} tim dipindah ke ${result.sessionName}`,
    }
  }

  async removeTeam(input: { sessionId: string; teamId: string }) {
    const deleted = await this.repo.removeTeamAssignment(
      input.sessionId,
      input.teamId,
    )
    if (deleted.count === 0) throw new AppError('Penugasan tim tidak ditemukan', 404)
    return { data: null, message: 'Tim dikeluarkan dari sesi' }
  }
}
```

- [ ] **Step 3: Build**

Run: `pnpm build`
Expected: BUILD PASS.

- [ ] **Step 4: Commit (setelah approval user)**

```bash
git add src/lib/api/exam-sessions/
git commit -m "feat(exam-session): add session repo & service (CRUD + range team assignment)"
```

---

### Task 4: Server Functions + Query Options

**Files:**
- Create: `src/server/exam-session.ts`
- Create: `src/lib/api/exam-sessions/exam-session.query-options.ts`

**Interfaces:**
- Consumes: `ExamSessionService` (Task 3), `requireAdminSession` + skema (Task 2).
- Produces (dipakai Task 8): server fns `getExamSessions`, `createExamSession`, `updateExamSession`, `deleteExamSession`, `assignTeamsToSession`, `removeTeamFromSession`; hook `examSessionsQueryOptions(examId: string)` dengan queryKey `['exam-sessions', examId]`.

- [ ] **Step 1: Buat `src/server/exam-session.ts`**

```ts
import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { withErrorHandling } from '~/lib/utils/server-wrapper'
import { successResponse, ApiSuccess } from '~/lib/utils/api-response'
import { requireAdminSession } from '~/lib/utils/server-auth'
import ExamSessionService from '~/lib/api/exam-sessions/exam-session.service'
import {
  assignTeamsToSessionSchema,
  createExamSessionSchema,
  examSessionIdSchema,
  examSessionsQuerySchema,
  removeTeamFromSessionSchema,
  updateExamSessionSchema,
} from '~/schemas/exam-session'

const service = new ExamSessionService()

export const getExamSessions = createServerFn({ method: 'GET' })
  .inputValidator(examSessionsQuerySchema)
  .handler(
    withErrorHandling(async ({ data }): Promise<ApiSuccess<any>> => {
      await requireAdminSession()
      const result = await service.list(data.examId)
      return successResponse(result.data, result.message)
    }),
  )

export const createExamSession = createServerFn({ method: 'POST' })
  .inputValidator(createExamSessionSchema)
  .handler(
    withErrorHandling(async ({ data }): Promise<ApiSuccess<any>> => {
      await requireAdminSession()
      const result = await service.create(data)
      return successResponse(result.data, result.message)
    }),
  )

export const updateExamSession = createServerFn({ method: 'POST' })
  .inputValidator(updateExamSessionSchema)
  .handler(
    withErrorHandling(async ({ data }): Promise<ApiSuccess<any>> => {
      await requireAdminSession()
      const result = await service.update(data)
      return successResponse(result.data, result.message)
    }),
  )

export const deleteExamSession = createServerFn({ method: 'POST' })
  .inputValidator(examSessionIdSchema)
  .handler(
    withErrorHandling(async ({ data }): Promise<ApiSuccess<null>> => {
      await requireAdminSession()
      const result = await service.remove(data.id)
      return successResponse<null>(result.data, result.message)
    }),
  )

export const assignTeamsToSession = createServerFn({ method: 'POST' })
  .inputValidator(assignTeamsToSessionSchema)
  .handler(
    withErrorHandling(async ({ data }): Promise<ApiSuccess<any>> => {
      await requireAdminSession()
      const result = await service.assign(data)
      return successResponse(result.data, result.message)
    }),
  )

export const removeTeamFromSession = createServerFn({ method: 'POST' })
  .inputValidator(removeTeamFromSessionSchema)
  .handler(
    withErrorHandling(async ({ data }): Promise<ApiSuccess<null>> => {
      await requireAdminSession()
      const result = await service.removeTeam(data)
      return successResponse<null>(result.data, result.message)
    }),
  )
```

- [ ] **Step 2: Buat `src/lib/api/exam-sessions/exam-session.query-options.ts`**

```ts
import { queryOptions } from '@tanstack/react-query'
import { getExamSessions } from '~/server/exam-session'

export const examSessionsQueryOptions = (examId: string) =>
  queryOptions({
    queryKey: ['exam-sessions', examId],
    queryFn: () => getExamSessions({ data: { examId } }),
  })
```

- [ ] **Step 3: QA manual cepat (opsional tapi disarankan)**

Jalankan `pnpm dev`, panggil salah satu fn via halaman apa pun yang ada (belum ada UI) — minimal pastikan build & runtime import benar. Jika sulit, lanjut; Task 8 akan menguji menyeluruh.

- [ ] **Step 4: Commit (setelah approval user)**

```bash
git add src/server/exam-session.ts src/lib/api/exam-sessions/exam-session.query-options.ts
git commit -m "feat(exam-session): add admin server functions & query options"
```

---

### Task 5: Payload Exam List untuk Tim (sessions + mySession)

**Files:**
- Modify: `src/lib/api/exams/exam.repo.ts` (fungsi `getExamsByStageCompetitionType`, baris ~43–62)

**Interfaces:**
- Produces: tiap item exam kini membawa `sessions: { id, name, startTime, endTime, assignments: { sessionId }[] }[]` (assignments terfilter `teamId` pemanggil). Dipakai Task 7 untuk menghitung status gembok.

- [ ] **Step 1: Perluas include di `getExamsByStageCompetitionType`**

Ganti isi fungsi menjadi:

```ts
  getExamsByStageCompetitionType(competitionType: string, teamId: string) {
    return prisma.exam.findMany({
      where: {
        stage: {
          competition: { name: competitionType as any },
        },
      },
      include: {
        stage: true,
        attempts: {
          where: { teamId },
          select: {
            finished: true,
            startTime: true,
          },
        },
        sessions: {
          select: {
            id: true,
            name: true,
            startTime: true,
            endTime: true,
            assignments: {
              where: { teamId },
              select: { sessionId: true },
            },
          },
          orderBy: { startTime: 'asc' },
        },
      },
      orderBy: { startDate: 'asc' },
    })
  }
```

Perubahan: tambahan blok `sessions` (field lain identik dengan sebelumnya).

- [ ] **Step 2: Build**

Run: `pnpm build`
Expected: BUILD PASS.

- [ ] **Step 3: Commit (setelah approval user)**

```bash
git add src/lib/api/exams/exam.repo.ts
git commit -m "feat(exams): include sessions & team assignment in team exam list payload"
```

---

### Task 6: Gating Sesi di Server (`startExam`)

**Files:**
- Modify: `src/lib/api/exam-attempts/exam-attempt.repo.ts` (tambah 3 method; ubah select `findExamWindow`)
- Modify: `src/lib/api/exam-attempts/exam-attempt.service.ts` (fungsi `startExam`, baris ~20–63)

**Interfaces:**
- Consumes: model `ExamSessionTeam` unique `teamId_examId` (Task 1).
- Produces: perilaku `startExam` sesuai tabel gating spec §5. Tidak ada signature berubah — pemanggil (`startExam`, `startExamSession` di `src/server/exam-attempt.ts`) tak tersentuh.

Aturan final (spec D3/D4/D5):
1. `TRYOUT` → validasi window exam seperti semula.
2. `OLYMPIAD` tanpa sesi → validasi window exam (fallback).
3. `OLYMPIAD` bersesi + attempt **belum ada** → wajib ada assignment DAN `now ∈ [session.startTime, session.endTime]`.
4. `OLYMPIAD` bersesi + attempt **sudah ada** → lolos (resume melewati akhir sesi diperbolehkan; deadline tetap ditangani `getExamSession`/`saveAnswer` yang tidak berubah).

- [ ] **Step 1: Ubah `findExamWindow` + tambah 3 method di repo**

Di `exam-attempt.repo.ts`:

```ts
  findExamWindow(examId: string) {
    return prisma.exam.findUnique({
      where: { id: examId },
      select: { id: true, startDate: true, endDate: true, duration: true, type: true },
    })
  }

  findAttemptLite(teamId: string, examId: string) {
    return prisma.examAttempt.findUnique({
      where: { teamId_examId: { teamId, examId } },
      select: { id: true, finished: true, startTime: true },
    })
  }

  countSessionsByExamId(examId: string) {
    return prisma.examSession.count({ where: { examId } })
  }

  findAssignment(teamId: string, examId: string) {
    return prisma.examSessionTeam.findUnique({
      where: { teamId_examId: { teamId, examId } },
      select: {
        id: true,
        session: {
          select: { id: true, name: true, startTime: true, endTime: true },
        },
      },
    })
  }
```

(`findExamWindow` hanya bertambah `type: true` pada select.)

- [ ] **Step 2: Tulis logika gating baru di `service.startExam`**

Ganti badan fungsi `startExam` (bagian sebelum `upsertAttempt`) menjadi:

```ts
  async startExam(input: {
    teamId: string
    examId: string
    deviceId: string
    ipAddress: string
    userAgent: string
  }) {
    const exam = await this.repo.findExamWindow(input.examId)
    if (!exam) throw new AppError('Ujian tidak ditemukan', 404)

    const now = new Date()

    if (exam.type === 'OLYMPIAD') {
      const sessionCount = await this.repo.countSessionsByExamId(input.examId)

      if (sessionCount === 0) {
        // Fallback: exam olimpiade belum punya sesi → window exam (D4)
        if (now < exam.startDate || now > exam.endDate) {
          throw new AppError('Ujian tidak dalam periode aktif', 400)
        }
      } else {
        // Ada sesi: attempt baru hanya boleh dibuat dalam window sesi tim (D3).
        // Attempt yang sudah ada boleh resume melewati akhir sesi.
        const existingAttempt = await this.repo.findAttemptLite(
          input.teamId,
          input.examId,
        )

        if (!existingAttempt) {
          const assignment = await this.repo.findAssignment(
            input.teamId,
            input.examId,
          )

          if (!assignment) {
            throw new AppError('Tim belum di-assign ke sesi ujian', 400)
          }
          if (now < assignment.session.startTime) {
            throw new AppError('Sesi ujian belum dimulai', 400)
          }
          if (now > assignment.session.endTime) {
            throw new AppError('Sesi ujian telah berakhir', 400)
          }
        }
      }
    } else if (now < exam.startDate || now > exam.endDate) {
      throw new AppError('Ujian tidak dalam periode aktif', 400)
    }

    const attempt = await this.repo.upsertAttempt({
      ...input,
      deviceId: '',
      startTime: now,
    })

    if (attempt.finished) throw new AppError('Ujian sudah selesai dikerjakan', 400)

    // ... sisa fungsi (cek deviceId MULTIPLE_LOGIN & return) TIDAK BERUBAH
```

Penting: potongan setelah `upsertAttempt` (mulai `if (attempt.finished)` sampai `return {...}`) biarkan persis seperti kode existing — jangan diubah.

- [ ] **Step 3: Build**

Run: `pnpm build`
Expected: BUILD PASS.

- [ ] **Step 4: QA manual gating (bypass URL)**

1. `pnpm dev`, buat sesi lewat DB lokal sementara (atau tunggu Task 8): `INSERT INTO exam_session (id, name, "startTime", "endTime", "examId") VALUES (gen_random_uuid(), 'Sesi QA', now() + interval '-1 hour', now() + interval '1 hour', '<id-exam-penyisihan-olympiad>')` — sesuaikan.
2. Login sebagai tim OLIMPIADE **tanpa assignment**, buka langsung `/dashboard/team/exam/<examId>` → HARUS gagal dengan pesan "Tim belum di-assign ke sesi ujian".
3. Assign manual di DB: `INSERT INTO exam_session_team (id, "sessionId", "teamId", "examId") VALUES (gen_random_uuid(), '<sessionId>', '<teamId>', '<examId>')`.
4. Buka lagi → HARUS masuk halaman ujian normal (sesi aktif).
5. Ubah `endTime` sesi ke masa lampau, hapus attempt tim di DB, buka URL → HARUS gagal "Sesi ujian telah berakhir". (Resume kasus sudah-mulai diuji di Task 7.)

- [ ] **Step 5: Commit (setelah approval user)**

```bash
git add src/lib/api/exam-attempts/
git commit -m "feat(exam-attempt): gate olympiad exam start by team's session window"
```

---

### Task 7: Tombol Gembok di Dashboard Tim (`OlimpiadeSection`)

**Files:**
- Modify: `src/components/dashboard/team/OlimpiadeSection.tsx` (fungsi `ExamList`, baris ~62–165)

**Interfaces:**
- Consumes: payload `sessions` + `assignments` dari Task 5; `exam.attempts` existing.
- Produces: UI status per exam. Logika tampilan (spec §7.1):
  - `TRYOUT` atau `OLYMPIAD` tanpa sesi → perilaku lama persis.
  - `OLYMPIAD` bersesi: `mySession = sessions.find(s => s.assignments.length > 0)`.

- [ ] **Step 1: Rework render kartu di `ExamList`**

Ganti isi `exams.map((exam) => {...})` dengan versi berikut (impor tambahan: tidak ada — ikon `Lock` sudah diimpor):

```tsx
        {exams.map((exam) => {
          const attempt = exam.attempts?.[0]
          const isFinished = Boolean(attempt?.finished)
          const isStarted = Boolean(attempt && !attempt.finished)
          const hasSessions =
            exam.type === 'OLYMPIAD' && (exam.sessions?.length ?? 0) > 0
          const mySession = hasSessions
            ? (exam.sessions as any[]).find(
                (s: any) => (s.assignments?.length ?? 0) > 0,
              )
            : undefined

          // Status default: hitung dari window exam (TRYOUT + fallback OLYMPIAD tanpa sesi)
          let isActive = now >= new Date(exam.startDate) && now <= new Date(exam.endDate)
          let isUpcoming = now < new Date(exam.startDate)
          let isEnded = now > new Date(exam.endDate)
          let badgeText = isFinished ? null : isActive ? 'Aktif' : isUpcoming ? 'Segera' : 'Ditutup'
          let lockMessage: string | null = null
          let sessionInfo: { name: string; range: string } | null = null

          if (hasSessions) {
            if (!mySession) {
              isActive = false
              isUpcoming = false
              isEnded = false
              badgeText = 'Tidak Terjadwal'
              lockMessage = 'Tim kamu belum di-assign ke sesi ujian.'
            } else {
              const sStart = new Date(mySession.startTime)
              const sEnd = new Date(mySession.endTime)
              const fmtDayTime = (d: Date) =>
                d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short' }) +
                ' · ' +
                d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })
              sessionInfo = {
                name: mySession.name,
                range: `${fmtDayTime(sStart)} – ${fmtDayTime(sEnd)}`,
              }

              if (isFinished) {
                isActive = false; isUpcoming = false; isEnded = false
              } else if (now > new Date(exam.endDate)) {
                // Hard-stop: exam endDate tercapai — tim mana pun, durasi berapa pun
                isActive = false; isUpcoming = false; isEnded = true
                badgeText = 'Waktu Habis'
                lockMessage = 'Waktu pengerjaan ujian telah berakhir.'
              } else if (isStarted) {
                // Sudah mulai → boleh lanjut walau sesi lewat (D3); deadline dijaga server
                isActive = true; isUpcoming = false; isEnded = false
                badgeText = 'Aktif'
              } else if (now < sStart) {
                isActive = false; isUpcoming = true; isEnded = false
                badgeText = 'Belum Dimulai'
                lockMessage = 'Sesi kamu belum dimulai.'
              } else if (now <= sEnd) {
                isActive = true; isUpcoming = false; isEnded = false
                badgeText = 'Aktif'
              } else {
                isActive = false; isUpcoming = false; isEnded = true
                badgeText = 'Waktu Habis'
                lockMessage = 'Sesi kamu telah berakhir.'
              }
            }
          }

          return (
            <div key={exam.id} className="rounded-2xl bg-background shadow border p-5 space-y-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="font-semibold text-sm">{exam.title}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{exam.stage?.name}</p>
                </div>
                {isFinished ? (
                  <Badge variant="secondary" className="shrink-0 bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500/20">Selesai</Badge>
                ) : (
                  <Badge variant={isActive ? 'default' : isEnded ? 'secondary' : 'outline'} className="shrink-0">{badgeText}</Badge>
                )}
              </div>

              <div className="space-y-1">
              {sessionInfo ? (
                  <>
                    <Badge variant="outline" className="shrink-0">
                      {sessionInfo.name} · Mulai {sessionInfo.range.split('–')[0].split('·')[1]?.trim()}
                    </Badge>
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Clock size={12} />
                      <span>Mulai sesimu: {sessionInfo.range}</span>
                    </div>
                  </>
              ) : (
                  <>
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Clock size={12} />
                      <span>Mulai: {new Date(exam.startDate).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                    </div>
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Clock size={12} />
                      <span>Selesai: {new Date(exam.endDate).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                    </div>
                  </>
                )}
              </div>

              {lockMessage ? (
                <Button size="sm" variant="outline" className="w-full rounded-xl" disabled>
                  <Lock size={13} className="mr-1.5" />
                  {lockMessage}
                </Button>
              ) : isFinished ? (
                exam.type === 'TRYOUT' ? (
                  <Button size="sm" variant="outline" className="w-full rounded-xl" asChild>
                    <a href={`/dashboard/team/exam/${exam.id}/review`}>
                      <BookOpen size={13} className="mr-1.5" />
                      Lihat Pembahasan
                    </a>
                  </Button>
                ) : (
                  <Button size="sm" variant="ghost" className="w-full rounded-xl" disabled>
                    <CheckCircle2 size={13} className="mr-1.5" />
                    Selesai Dikerjakan
                  </Button>
                )
              ) : isActive ? (
                <Button size="sm" className="w-full rounded-xl" asChild>
                  <a href={`/dashboard/team/exam/${exam.id}`}>
                    <BookOpen size={13} className="mr-1.5" />
                    {isStarted ? 'Lanjutkan Ujian' : 'Mulai Kerjakan'}
                  </a>
                </Button>
              ) : isUpcoming ? (
                <Button size="sm" variant="outline" className="w-full rounded-xl" disabled>
                  <Clock size={13} className="mr-1.5" />
                  Belum Dimulai
                </Button>
              ) : (
                <Button size="sm" variant="ghost" className="w-full rounded-xl" disabled>
                  <Clock size={13} className="mr-1.5" />
                  Waktu Habis
                </Button>
              )}
            </div>
          )
        })}
```

Catatan: variabel `start`/`end` lama tidak lagi dipakai di map — pastikan tidak tersisa referensi duplikat. Timer `now` (interval 30s) tetap dipakai.

- [ ] **Step 2: Build**

Run: `pnpm build`
Expected: BUILD PASS.

- [ ] **Step 3: QA manual 5 status**

Dengan data Task 6 Step 4:
1. Tim ter-assign, sesi belum mulai → tombol gembok "Sesi kamu belum dimulai." + badge "Belum Dimulai".
2. Sesi aktif, belum mulai ujian → "Mulai Kerjakan" aktif.
3. Mulai ujian, ubah `endTime` sesi ke lampau di DB, refresh dashboard → tombol tetap "Lanjutkan Ujian" (resume D3) dan halaman exam masih bisa dibuka selama durasi sisa.
4. Tim tanpa assignment saat exam bersesi → gembok "Tim kamu belum di-assign ke sesi ujian."
5. Regresi TRYOUT: kartu tryout tampil & berfungsi seperti sebelumnya (aktif/segera/ditutup + review).

- [ ] **Step 4: Commit (setelah approval user)**

```bash
git add src/components/dashboard/team/OlimpiadeSection.tsx
git commit -m "feat(dashboard-team): lock olympiad exam button by team session"
```

---

### Task 8: Halaman Admin "Kelola Sesi"

**Files:**
- Modify: `src/components/dashboard/admin/exams/ExamCard.tsx` (tambah link, hanya `exam.type === 'OLYMPIAD'`)
- Create: `src/routes/dashboard/_authed/admin/exams/$examId/sessions/index.tsx`
- Create: `src/components/dashboard/admin/exams/sessions/SessionsManager.tsx`
- Create: `src/components/dashboard/admin/exams/sessions/FormSessionDialog.tsx`

**Interfaces:**
- Consumes: semua server fn + `examSessionsQueryOptions` (Task 4); `examQueryOptions(examId)` existing.
- Produces: alur admin lengkap (buat/edit/hapus sesi, assign range, keluarkan tim).

- [ ] **Step 1: Tambah link "Kelola Sesi" di `ExamCard.tsx`**

Di `CardFooter`, sebelum link "Lihat Hasil", tambahkan (kondisional OLYMPIAD):

```tsx
        {exam.type === 'OLYMPIAD' && (
          <Link
            to="/dashboard/admin/exams/$examId/sessions"
            params={{ examId: exam.id }}
            onClick={(e) => e.stopPropagation()}
            className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            Kelola Sesi
            <ArrowRight size={14} />
          </Link>
        )}
```

(Ikon `ArrowRight` dan `Link` sudah diimpor di file tersebut.)

- [ ] **Step 2: Buat `FormSessionDialog.tsx`** (dialog create/edit sesi)

```tsx
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Button } from '~/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '~/components/ui/dialog'
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '~/components/ui/field'
import { Input } from '~/components/ui/input'
import { Plus, Pencil } from 'lucide-react'
import {
  createExamSession,
  updateExamSession,
} from '~/server/exam-session'
import {
  createExamSessionSchema,
  type CreateExamSessionData,
} from '~/schemas/exam-session'
import { z } from 'zod'

type Props = {
  examId: string
  existing?: {
    id: string
    name: string
    startTime: string
    endTime: string
  }
}

// Untuk edit: id ikut divalidasi
const editSchema = createExamSessionSchema.innerType().extend({
  id: z.string().uuid(),
})

function toLocalInputValue(iso: string) {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function FormSessionDialog({ examId, existing }: Props) {
  const [open, setOpen] = useState(false)
  const queryClient = useQueryClient()

  const form = useForm<any>({
    resolver: zodResolver(existing ? editSchema : createExamSessionSchema),
    defaultValues: existing
      ? {
          id: existing.id,
          name: existing.name,
          startTime: toLocalInputValue(existing.startTime),
          endTime: toLocalInputValue(existing.endTime),
        }
      : { name: '', startTime: '', endTime: '' },
  })

  const mutation = useMutation({
    mutationFn: async (values: any) => {
      const payload = {
        ...values,
        startTime: new Date(values.startTime),
        endTime: new Date(values.endTime),
      }
      return existing
        ? updateExamSession({ data: payload })
        : createExamSession({ data: { ...payload, examId } })
    },
    onError: (error: any) => toast.error(error?.message ?? 'Terjadi kesalahan'),
    onSuccess: async () => {
      toast.success(existing ? 'Sesi diperbarui' : 'Sesi dibuat')
      setOpen(false)
      form.reset(existing ? undefined : { name: '', startTime: '', endTime: '' })
      await queryClient.invalidateQueries({ queryKey: ['exam-sessions', examId] })
    },
  })

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {existing ? (
          <Button size="icon-sm" variant="ghost">
            <Pencil className="size-3.5" />
          </Button>
        ) : (
          <Button size="sm">
            <Plus size={14} className="mr-1" />
            Tambah Sesi
          </Button>
        )}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{existing ? 'Edit Sesi' : 'Tambah Sesi'}</DialogTitle>
        </DialogHeader>
        <form onSubmit={form.handleSubmit((v) => mutation.mutate(v))}>
          <FieldGroup>
            <Field>
              <FieldLabel>Nama Sesi</FieldLabel>
              <Input placeholder="Sesi 1" {...form.register('name')} />
              <FieldError>{form.formState.errors.name?.message as any}</FieldError>
            </Field>
            <Field>
              <FieldLabel>Jam Mulai</FieldLabel>
              <Input type="datetime-local" {...form.register('startTime')} />
              <FieldError>{form.formState.errors.startTime?.message as any}</FieldError>
            </Field>
            <Field>
              <FieldLabel>Jam Selesai</FieldLabel>
              <Input type="datetime-local" {...form.register('endTime')} />
              <FieldError>{form.formState.errors.endTime?.message as any}</FieldError>
            </Field>
          </FieldGroup>
          <DialogFooter className="mt-4">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Batal
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              Simpan
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
```

Catatan implementer: jika komponen `dialog`/`field`/`input` repo memiliki nama export berbeda, cek `src/components/ui/*` dan sesuaikan import — jangan membuat komponen ui baru.

- [ ] **Step 3: Buat `SessionsManager.tsx`** (list sesi + panel assign + daftar tim)

```tsx
import { useSuspenseQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'
import { CalendarClock, Trash2, UserPlus } from 'lucide-react'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import { Input } from '~/components/ui/input'
import { Label } from '~/components/ui/label'
import {
  assignTeamsToSession,
  deleteExamSession,
  removeTeamFromSession,
} from '~/server/exam-session'
import { examSessionsQueryOptions } from '~/lib/api/exam-sessions/exam-session.query-options'
import { FormSessionDialog } from './FormSessionDialog'

export function SessionsManager({ examId }: { examId: string }) {
  const { data: res } = useSuspenseQuery(examSessionsQueryOptions(examId))
  const sessions: any[] = res.data ?? []
  const queryClient = useQueryClient()
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['exam-sessions', examId] })

  // state assign per sesi: { [sessionId]: {codeFrom: string, codeTo: string} }
  const [ranges, setRanges] = useState<Record<string, { codeFrom: string; codeTo: string }>>({})

  const assignMutation = useMutation({
    mutationFn: (input: { sessionId: string; codeFrom: number; codeTo: number }) =>
      assignTeamsToSession({ data: input }),
    onSuccess: async (result: any) => {
      toast.success(result.message ?? 'Tim berhasil di-assign')
      await invalidate()
    },
    onError: (error: any) => toast.error(error?.message ?? 'Terjadi kesalahan'),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteExamSession({ data: { id } }),
    onSuccess: async () => {
      toast.success('Sesi dihapus')
      await invalidate()
    },
    onError: (error: any) => toast.error(error?.message ?? 'Terjadi kesalahan'),
  })

  const removeTeamMutation = useMutation({
    mutationFn: (input: { sessionId: string; teamId: string }) =>
      removeTeamFromSession({ data: input }),
    onSuccess: async () => {
      toast.success('Tim dikeluarkan dari sesi')
      await invalidate()
    },
    onError: (error: any) => toast.error(error?.message ?? 'Terjadi kesalahan'),
  })

  if (sessions.length === 0) {
    return (
      <div className="rounded-2xl border p-8 text-center space-y-3">
        <CalendarClock className="mx-auto size-8 text-muted-foreground/50" />
        <p className="text-sm text-muted-foreground">
          Belum ada sesi. Exam akan mengikuti window tanggal ujian sampai sesi dibuat.
        </p>
        <div className="flex justify-center">
          <FormSessionDialog examId={examId} />
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Daftar Sesi</h2>
        <FormSessionDialog examId={examId} />
      </div>

      {sessions.map((session) => {
        const rangeState = ranges[session.id] ?? { codeFrom: '', codeTo: '' }
        const fmt = (iso: string) =>
          new Date(iso).toLocaleString('id-ID', {
            day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
          })

        return (
          <Card key={session.id}>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="text-base flex items-center gap-2">
                  {session.name}
                  <Badge variant="outline">
                    {(session.assignments ?? []).length} tim
                  </Badge>
                </CardTitle>
                <div className="flex items-center gap-1">
                  <FormSessionDialog
                    examId={examId}
                    existing={{
                      id: session.id,
                      name: session.name,
                      startTime: session.startTime,
                      endTime: session.endTime,
                    }}
                  />
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    onClick={() => {
                      if (window.confirm(`Hapus ${session.name}? Tim terkait akan kehilangan sesi.`)) {
                        deleteMutation.mutate(session.id)
                      }
                    }}
                  >
                    <Trash2 className="size-3.5 text-destructive" />
                  </Button>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                {fmt(session.startTime)} — {fmt(session.endTime)}
              </p>
            </CardHeader>

            <CardContent className="space-y-4">
              {/* Assign by range */}
              <div className="border rounded-xl p-3 space-y-2 bg-muted/30">
                <Label className="flex items-center gap-1.5 text-xs">
                  <UserPlus size={13} />
                  Assign Tim (nomor kode, mis. 1–100 untuk OLM-001 … OLM-100)
                </Label>
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    type="number" min={1} className="w-24"
                    placeholder="dari"
                    value={rangeState.codeFrom}
                    onChange={(e) =>
                      setRanges({ ...ranges, [session.id]: { ...rangeState, codeFrom: e.target.value } })
                    }
                  />
                  <span className="text-xs text-muted-foreground">s.d.</span>
                  <Input
                    type="number" min={1} className="w-24"
                    placeholder="sampai"
                    value={rangeState.codeTo}
                    onChange={(e) =>
                      setRanges({ ...ranges, [session.id]: { ...rangeState, codeTo: e.target.value } })
                    }
                  />
                  <Button
                    size="sm"
                    disabled={
                      assignMutation.isPending ||
                      !rangeState.codeFrom || !rangeState.codeTo
                    }
                    onClick={() =>
                      assignMutation.mutate({
                        sessionId: session.id,
                        codeFrom: Number(rangeState.codeFrom),
                        codeTo: Number(rangeState.codeTo),
                      })
                    }
                  >
                    Assign
                  </Button>
                </div>
              </div>

              {/* Daftar tim */}
              {(session.assignments ?? []).length === 0 ? (
                <p className="text-xs text-muted-foreground">Belum ada tim.</p>
              ) : (
                <div className="border rounded-xl overflow-hidden">
                  <table className="w-full text-sm">
                    <tbody>
                      {(session.assignments as any[]).map((a) => (
                        <tr key={a.id} className="border-b last:border-b-0">
                          <td className="px-3 py-2 font-mono text-xs w-28">{a.team.code}</td>
                          <td className="px-3 py-2">{a.team.name}</td>
                          <td className="px-3 py-2 text-xs text-muted-foreground">{a.team.schoolName}</td>
                          <td className="px-3 py-2 text-right">
                            <Button
                              size="icon-sm" variant="ghost"
                              disabled={removeTeamMutation.isPending}
                              onClick={() =>
                                removeTeamMutation.mutate({
                                  sessionId: session.id,
                                  teamId: a.team.id,
                                })
                              }
                            >
                              <Trash2 className="size-3.5 text-destructive" />
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}
```

- [ ] **Step 4: Buat route `src/routes/dashboard/_authed/admin/exams/$examId/sessions/index.tsx`**

```tsx
import { createFileRoute, Link } from '@tanstack/react-router'
import { useSuspenseQuery } from '@tanstack/react-query'
import { Suspense } from 'react'
import { ArrowLeft } from 'lucide-react'
import { Skeleton } from '~/components/ui/skeleton'
import { examQueryOptions } from '~/lib/api/exams/exam.query-options'
import { examSessionsQueryOptions } from '~/lib/api/exam-sessions/exam-session.query-options'
import { SessionsManager } from '~/components/dashboard/admin/exams/sessions/SessionsManager'

export const Route = createFileRoute(
  '/dashboard/_authed/admin/exams/$examId/sessions/',
)({
  loader: async ({ params, context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(examQueryOptions(params.examId)),
      context.queryClient.ensureQueryData(examSessionsQueryOptions(params.examId)),
    ])
  },
  component: RouteComponent,
})

function SessionsContent({ examId }: { examId: string }) {
  const { data: examRes } = useSuspenseQuery(examQueryOptions(examId))
  const exam = examRes?.data

  return (
    <div className="space-y-6 w-full pt-20 min-h-screen pb-6 max-w-6xl mx-auto px-8">
      <div className="flex items-start gap-4">
        <Link
          to="/dashboard/admin/exams"
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground mt-1"
        >
          <ArrowLeft size={13} />
          Kembali
        </Link>
        <div>
          <h1 className="text-lg font-bold">Kelola Sesi — {exam?.title}</h1>
          <p className="text-xs text-muted-foreground">
            Atur jadwal sesi dan tim peserta per sesi. Tim hanya dapat memulai
            ujian pada sesinya.
          </p>
        </div>
      </div>

      <SessionsManager examId={examId} />
    </div>
  )
}

function RouteComponent() {
  const { examId } = Route.useParams()

  return (
    <Suspense fallback={<Skeleton className="h-64 rounded-2xl mx-8 mt-20" />}>
      <SessionsContent examId={examId} />
    </Suspense>
  )
}
```

Setelah membuat file route, jalankan `pnpm dev` sekali agar `routeTree.gen.ts` ter-generate ulang (atau jalankan generator router sesuai setup vite plugin).

- [ ] **Step 5: Build**

Run: `pnpm build`
Expected: BUILD PASS (termasuk routeTree.gen.ts yang sudah diperbarui).

- [ ] **Step 6: QA manual alur admin end-to-end**

1. Login admin → Exams → kartu exam `Penyisihan OLIMPIADE` → link "Kelola Sesi" tampil; kartu TRYOUT tidak memilikinya.
2. Buka halaman sesi → kosong → klik "Tambah Sesi" → isi "Sesi 1", hari ini 07:00–10:00 (geser ke waktu yang bisa diuji) → tersimpan.
3. Tambah "Sesi 2" 13:00–16:00.
4. Assign range 1–100 ke Sesi 1 → toast jumlah; daftar tim muncul (kode `OLM-001` dst.).
5. Assign ulang range yang sama ke Sesi 2 → tim pindah (moved), tidak duplikat.
6. Keluarkan satu tim via tombol hapus → hilang dari daftar.
7. Edit jam sesi → tersimpan; coba simpan endTime ≤ startTime → error toast.
8. Coba buat sesi dengan nama duplikat → error toast "Nama sesi sudah dipakai".
9. Regresi: halaman reviews/attempts exam tetap normal.
10. Ulangi QA Task 6 Step 4 & Task 7 Step 3 kini lewat UI (tanpa insert DB manual).
11. Assign range yang mencakup tim berstatus PENDING di DB → tim PENDING tersebut **dilewati** (tidak masuk sesi), hanya tim APPROVED yang masuk.

- [ ] **Step 7: Commit (setelah approval user)**

```bash
git add src/routes/dashboard/_authed/admin/exams/\$examId/sessions src/components/dashboard/admin/exams src/routeTree.gen.ts
git commit -m "feat(admin): manage olympiad exam sessions (schedule + team assignment)"
```

---

## Ringkasan Urutan & Ketergantungan

| Task | Deliverable | Bergantung |
|---|---|---|
| 1 | Skema + migrasi additive | — |
| 2 | `requireAdminSession` + zod schemas | — |
| 3 | Repo & service sesi | 1, 2 |
| 4 | Server fns + query options | 3 |
| 5 | Payload exam list (sessions/mySession) | 1 |
| 6 | Gating `startExam` server-side | 1 |
| 7 | UI gembok dashboard tim | 5 |
| 8 | UI admin kelola sesi | 4 |

Setelah Task 8 selesai: jalankan QA menyeluruh (checklist spec §9), lalu siapkan rilis produksi — **backup DB → `prisma migrate deploy` → verifikasi tabel baru kosong & data utuh → deploy aplikasi**.
