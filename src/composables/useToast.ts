import { ref } from 'vue'

export type ToastKind = '' | 'error' | 'success' | 'warn'

export interface ToastItem {
  id: number
  message: string
  kind: ToastKind
  sticky: boolean
}

export interface ToastOptions {
  // Stays until dismissed. For failures of an operation the user started
  // (open, save, merge…): the reason is often a full sentence they need to
  // read — or copy into a bug report — before it disappears.
  sticky?: boolean
}

const TOAST_DURATION_MS = 2400
// Errors and warnings that aren't sticky still need long enough to read a sentence.
const ALERT_DURATION_MS = 6000
// Toasts stack instead of replacing each other, so a routine notice can't wipe
// an error off the screen before it's been read.
const MAX_TOASTS = 4

const toasts = ref<ToastItem[]>([])
const timers = new Map<number, ReturnType<typeof setTimeout>>()
let nextId = 1

export function useToast() {
  return { toasts }
}

export function toast(message: string, kind: ToastKind = '', { sticky = false }: ToastOptions = {}): void {
  // Re-raising an identical message restarts it rather than stacking a copy.
  const duplicate = toasts.value.find((t) => t.message === message && t.kind === kind)
  if (duplicate) dismissToast(duplicate.id)

  const item: ToastItem = { id: nextId++, message, kind, sticky }
  toasts.value = [...toasts.value, item]
  if (!sticky) {
    const duration = kind === 'error' || kind === 'warn' ? ALERT_DURATION_MS : TOAST_DURATION_MS
    timers.set(item.id, setTimeout(() => dismissToast(item.id), duration))
  }

  // Only older routine notices make room — never the toast just raised and
  // never an unread sticky one — so the stack may run past the cap while
  // several sticky toasts wait to be dismissed.
  while (toasts.value.length > MAX_TOASTS) {
    const oldest = toasts.value.find((t) => !t.sticky && t.id !== item.id)
    if (!oldest) break
    dismissToast(oldest.id)
  }
}

export function dismissToast(id: number): void {
  const timer = timers.get(id)
  if (timer) clearTimeout(timer)
  timers.delete(id)
  toasts.value = toasts.value.filter((t) => t.id !== id)
}
