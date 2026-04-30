import { ref } from 'vue'

export type ToastKind = '' | 'error' | 'success' | 'warn'

interface ToastState {
  message: string
  kind: ToastKind
  visible: boolean
}

const TOAST_DURATION_MS = 2400

const state = ref<ToastState>({ message: '', kind: '', visible: false })
let timer: ReturnType<typeof setTimeout> | null = null

export function useToast() {
  return { state }
}

export function toast(message: string, kind: ToastKind = ''): void {
  state.value = { message, kind, visible: true }
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    state.value = { ...state.value, visible: false }
  }, TOAST_DURATION_MS)
}
