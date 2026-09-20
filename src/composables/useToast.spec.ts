import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dismissToast, toast, useToast } from '@/composables/useToast'

const { toasts } = useToast()

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  for (const t of [...toasts.value]) dismissToast(t.id)
  vi.useRealTimers()
})

describe('toast', () => {
  it('keeps sticky toasts on screen until dismissed', () => {
    toast('Couldn’t merge a.pdf: broken', 'error', { sticky: true })
    vi.advanceTimersByTime(60_000)
    expect(toasts.value.map((t) => t.message)).toEqual(['Couldn’t merge a.pdf: broken'])
    dismissToast(toasts.value[0].id)
    expect(toasts.value).toEqual([])
  })

  it('gives plain errors long enough to read, then clears them', () => {
    toast('Enter a title', 'error')
    vi.advanceTimersByTime(5000)
    expect(toasts.value).toHaveLength(1)
    vi.advanceTimersByTime(1500)
    expect(toasts.value).toEqual([])
  })

  it('auto-dismisses routine notices', () => {
    toast('Saved', 'success')
    vi.advanceTimersByTime(3000)
    expect(toasts.value).toEqual([])
  })

  it('does not let a later notice replace an unread error', () => {
    toast('Couldn’t merge a.pdf: broken', 'error', { sticky: true })
    toast('Downloading OloPDF 1.0.15…')
    expect(toasts.value.map((t) => t.kind)).toEqual(['error', ''])
    vi.advanceTimersByTime(3000)
    expect(toasts.value.map((t) => t.kind)).toEqual(['error'])
  })

  it('restarts a repeated message instead of stacking copies', () => {
    toast('Enter a title', 'warn')
    vi.advanceTimersByTime(5000)
    toast('Enter a title', 'warn')
    expect(toasts.value).toHaveLength(1)
    vi.advanceTimersByTime(5000)
    expect(toasts.value).toHaveLength(1)
  })

  it('drops the oldest routine notice first when the stack is full', () => {
    toast('error one', 'error', { sticky: true })
    for (const n of [1, 2, 3, 4]) toast(`notice ${n}`)
    expect(toasts.value.map((t) => t.message)).toEqual(['error one', 'notice 2', 'notice 3', 'notice 4'])
  })

  it('never evicts sticky toasts or the toast just raised', () => {
    for (const n of [1, 2, 3, 4, 5]) toast(`error ${n}`, 'error', { sticky: true })
    toast('Merged 3 files', 'success')
    expect(toasts.value.map((t) => t.message)).toEqual([
      'error 1',
      'error 2',
      'error 3',
      'error 4',
      'error 5',
      'Merged 3 files',
    ])
  })
})
