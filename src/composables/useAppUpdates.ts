import { onBeforeUnmount, onMounted } from 'vue'
import { toast } from '@/composables/useToast'
import { ipcSend } from '@/utils/electron'
import type { IpcRendererEvent } from 'electron'

interface AvailablePayload {
  version: string
  portable: boolean
}
interface DownloadedPayload {
  version: string
}
interface ErrorPayload {
  message: string
}

// Wires up the renderer to the auto-updater events fired by main.js.
// NSIS-installed copies download silently and prompt to restart once the
// download finishes. Portable copies can't self-update — we point those
// users at the GitHub Releases page instead.
export function useAppUpdates() {
  const electron = (window as unknown as { require: (m: string) => typeof import('electron') }).require('electron')
  const { ipcRenderer } = electron

  const onAvailable = (_e: IpcRendererEvent, payload: AvailablePayload) => {
    if (payload.portable) {
      toast(`OloPDF ${payload.version} is available — opening Releases page`, 'success')
      ipcSend('update:open-releases')
      return
    }
    toast(`Downloading OloPDF ${payload.version}…`, '')
  }
  const onDownloaded = (_e: IpcRendererEvent, payload: DownloadedPayload) => {
    toast(`OloPDF ${payload.version} ready — relaunch to install`, 'success')
  }
  const onError = (_e: IpcRendererEvent, payload: ErrorPayload) => {
    // Silent in production-noise terms — log only. A failed update check
    // shouldn't surface a scary toast to the user.
    console.warn('[updater]', payload.message)
  }

  onMounted(() => {
    ipcRenderer.on('update:available', onAvailable)
    ipcRenderer.on('update:downloaded', onDownloaded)
    ipcRenderer.on('update:error', onError)
  })
  onBeforeUnmount(() => {
    ipcRenderer.off('update:available', onAvailable)
    ipcRenderer.off('update:downloaded', onDownloaded)
    ipcRenderer.off('update:error', onError)
  })
}
