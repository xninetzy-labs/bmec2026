/**
 * Format durasi pengerjaan olimpiade — read-only, tanpa ubah DB.
 * Plan A: compact "1j 12m 5d" (jam, menit, detik)
 * Sumber: startTime & endTime di ExamAttempt (endTime null = belum selesai)
 */

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return '0d'

  const totalSeconds = Math.floor(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  if (hours > 0) {
    return `${hours}j ${minutes}m ${seconds}d`
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}d`
  }
  return `${seconds}d`
}

export function formatDurationHHMMSS(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—'
  const totalSeconds = Math.floor(ms / 1000)
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  const s = totalSeconds % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

/**
 * Hitung durasi dari startTime & endTime string/Date.
 * Jika endTime null & finished=false => return null (berlangsung).
 * Jika finished=true tapi endTime null => return null (anomali).
 */
export function getAttemptDurationMs(
  startTime: string | Date | null | undefined,
  endTime: string | Date | null | undefined,
): number | null {
  if (!startTime) return null
  if (!endTime) return null

  const start = new Date(startTime).getTime()
  const end = new Date(endTime).getTime()

  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  if (end < start) return null

  return end - start
}

export function getAttemptDurationLabel(
  startTime: string | Date | null | undefined,
  endTime: string | Date | null | undefined,
  finished?: boolean,
): { label: string; ms: number | null; isOngoing: boolean } {
  const ms = getAttemptDurationMs(startTime, endTime)
  if (ms != null) {
    return { label: formatDuration(ms), ms, isOngoing: false }
  }
  // belum selesai
  if (finished === false || (endTime == null && startTime != null)) {
    return { label: 'Berlangsung', ms: null, isOngoing: true }
  }
  return { label: '—', ms: null, isOngoing: false }
}

/**
 * Untuk tooltip hover: tampilkan rentang + HH:MM:SS
 */
export function getDurationTooltip(
  startTime: string | Date | null | undefined,
  endTime: string | Date | null | undefined,
): string {
  const ms = getAttemptDurationMs(startTime, endTime)
  if (ms == null) return 'Belum selesai'
  const hhmmss = formatDurationHHMMSS(ms)
  const startStr = startTime ? new Date(startTime).toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'medium' }) : '—'
  const endStr = endTime ? new Date(endTime).toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'medium' }) : '—'
  return `Mulai: ${startStr}\nSelesai: ${endStr}\nDurasi: ${hhmmss} (${formatDuration(ms)})`
}
