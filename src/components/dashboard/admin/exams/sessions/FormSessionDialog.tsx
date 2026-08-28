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
  updateExamSessionSchema,
} from '~/schemas/exam-session.schema'

type Props = {
  examId: string
  existing?: {
    id: string
    name: string
    startTime: string
    endTime: string
  }
}

function toLocalInputValue(iso: string) {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function FormSessionDialog({ examId, existing }: Props) {
  const [open, setOpen] = useState(false)
  const queryClient = useQueryClient()

  const schema = existing ? updateExamSessionSchema : createExamSessionSchema

  const form = useForm<any>({
    resolver: zodResolver(schema as any),
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
      if (!existing) {
        form.reset({ name: '', startTime: '', endTime: '' })
      }
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
