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
  const exam = (examRes as any)?.data

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
