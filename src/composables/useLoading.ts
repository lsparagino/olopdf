import { ref } from 'vue'

interface LoadingState {
  visible: boolean
  text: string
}

const state = ref<LoadingState>({ visible: false, text: 'Working...' })

export function useLoading() {
  return { state }
}

export function showLoading(text = 'Working...'): void {
  state.value = { visible: true, text }
}

export function hideLoading(): void {
  state.value = { ...state.value, visible: false }
}
