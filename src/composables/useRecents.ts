import { ref } from 'vue'
import { fileExists, ipcInvoke } from '@/utils/electron'

const recents = ref<string[]>([])

export function useRecents() {
  return { recents }
}

export async function refreshRecents(): Promise<void> {
  let list: string[] = []
  try {
    list = await ipcInvoke<string[]>('recents:get')
  } catch {
    list = []
  }
  const existing: string[] = []
  for (const p of list) {
    if (await fileExists(p)) existing.push(p)
  }
  recents.value = existing
}

export async function addRecent(filePath: string): Promise<void> {
  try {
    const next = await ipcInvoke<string[]>('recents:add', filePath)
    recents.value = next
  } catch {
    /* ignore */
  }
}

export async function removeRecent(filePath: string): Promise<void> {
  try {
    const next = await ipcInvoke<string[]>('recents:remove', filePath)
    recents.value = next
  } catch {
    /* ignore */
  }
}
