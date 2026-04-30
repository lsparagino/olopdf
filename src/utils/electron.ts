// Typed accessors for Electron APIs available in the renderer (nodeIntegration: true).
// These are window.require() calls — Vite is configured to externalize 'electron' so they
// resolve to the Node runtime's electron module at runtime rather than being bundled.

import type { IpcRenderer } from 'electron'

interface ElectronShellLike {
  openExternal(url: string): Promise<void>
}

interface ElectronModule {
  ipcRenderer: IpcRenderer
  shell: ElectronShellLike
}

function electron(): ElectronModule {
  return (window as unknown as { require: (m: string) => ElectronModule }).require('electron')
}

export function ipcSend(channel: string, ...args: unknown[]): void {
  electron().ipcRenderer.send(channel, ...args)
}

export function ipcInvoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
  return electron().ipcRenderer.invoke(channel, ...args) as Promise<T>
}

export function openExternal(url: string): void {
  try {
    void electron().shell.openExternal(url)
  } catch {
    /* ignore */
  }
}

interface NodeFsPromises {
  readFile(path: string, encoding?: string): Promise<Buffer | string>
  access(path: string, mode?: number): Promise<void>
}

interface NodeFs {
  promises: NodeFsPromises
  constants: { F_OK: number }
}

interface NodePath {
  basename(p: string): string
  dirname(p: string): string
  join(...parts: string[]): string
}

export function nodeFs(): NodeFs {
  return (window as unknown as { require: (m: string) => NodeFs }).require('fs')
}

export function nodePath(): NodePath {
  return (window as unknown as { require: (m: string) => NodePath }).require('path')
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    const fs = nodeFs()
    await fs.promises.access(filePath, fs.constants.F_OK)
    return true
  } catch {
    return false
  }
}

export async function readFileAsArrayBuffer(filePath: string): Promise<ArrayBuffer> {
  // Read via IPC so the main process owns disk access — keeps the renderer free of
  // platform-specific path handling and matches the existing fs:readFile handler.
  return ipcInvoke<ArrayBuffer>('fs:readFile', filePath)
}

export async function writeFileBytes(filePath: string, bytes: Uint8Array): Promise<boolean> {
  return ipcInvoke<boolean>('fs:writeFile', filePath, bytes)
}
