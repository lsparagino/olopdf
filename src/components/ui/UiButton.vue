<script setup lang="ts">
import { computed } from 'vue'

interface Props {
  variant?: 'default' | 'primary' | 'ghost'
  size?: 'md' | 'sm' | 'icon'
  toggled?: boolean
  disabled?: boolean
  type?: 'button' | 'submit' | 'reset'
  title?: string
}

const {
  variant = 'default',
  size = 'md',
  toggled = false,
  disabled = false,
  type = 'button',
  title,
} = defineProps<Props>()

const emit = defineEmits<{ click: [e: MouseEvent] }>()

const classes = computed(() => {
  // Icon-size buttons get an inline-flex with explicit horizontal+vertical centering.
  // Mixing display utilities (e.g. inline-flex on the base + grid for icon) doesn't
  // reliably override; explicit justify-center keeps single-glyph content centered.
  const base = [
    'inline-flex items-center justify-center whitespace-nowrap rounded-[10px] font-medium',
    'transition-[transform,background,border-color,box-shadow] duration-150',
    'border text-fg leading-none',
    'disabled:opacity-45 disabled:cursor-not-allowed',
  ]

  if (size === 'sm') base.push('gap-2 px-3 py-1.5 text-xs rounded-lg')
  else if (size === 'icon') base.push('w-[30px] h-[30px] p-0 text-base rounded-lg')
  else base.push('gap-2 px-[18px] py-2.5 text-[13px]')

  if (variant === 'primary') {
    base.push(
      'border-transparent text-white',
      'shadow-[0_6px_20px_rgba(167,139,250,0.35)]',
      'hover:enabled:shadow-[0_10px_28px_rgba(167,139,250,0.5)]',
      'hover:enabled:-translate-y-px',
      'active:enabled:translate-y-0 active:enabled:scale-[0.98]',
    )
  } else if (variant === 'ghost') {
    base.push(
      'bg-transparent border-glass-border',
      'hover:enabled:bg-glass-strong hover:enabled:-translate-y-px',
      'active:enabled:translate-y-0 active:enabled:scale-[0.98]',
    )
  } else {
    base.push(
      'bg-glass-strong border-glass-border',
      'hover:enabled:bg-white/[0.14] hover:enabled:border-glass-border-strong hover:enabled:-translate-y-px hover:enabled:shadow-[0_6px_18px_rgba(0,0,0,0.25)]',
      'active:enabled:translate-y-0 active:enabled:scale-[0.98]',
    )
  }

  if (toggled) {
    base.push('!border-accent/50 !text-white')
  }

  return base.join(' ')
})

const primaryStyle = computed(() =>
  variant === 'primary'
    ? { background: 'linear-gradient(135deg, var(--color-accent), var(--color-accent-2))' }
    : toggled
      ? {
          background:
            'linear-gradient(135deg, rgba(167,139,250,0.35), rgba(236,72,153,0.35))',
        }
      : undefined,
)
</script>

<template>
  <button
    :class="classes"
    :style="primaryStyle"
    :disabled
    :type
    :title
    @click="(e) => emit('click', e)"
  >
    <slot />
  </button>
</template>
