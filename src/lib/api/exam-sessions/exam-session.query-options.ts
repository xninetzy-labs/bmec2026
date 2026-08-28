import { queryOptions } from '@tanstack/react-query'
import { getExamSessions } from '~/server/exam-session'

export const examSessionsQueryOptions = (examId: string) =>
  queryOptions({
    queryKey: ['exam-sessions', examId],
    queryFn: () => getExamSessions({ data: { examId } }),
  })
