<script setup lang="ts">
import TitleBar from '@/components/layout/TitleBar.vue'
import AppBackground from '@/components/layout/AppBackground.vue'
import AppToast from '@/components/ui/AppToast.vue'
import AppLoading from '@/components/ui/AppLoading.vue'
import { useAppUpdates } from '@/composables/useAppUpdates'

useAppUpdates()
</script>

<template>
  <AppBackground />
  <TitleBar />
  <main class="relative h-[calc(100vh-36px)] overflow-hidden">
    <RouterView v-slot="{ Component }">
      <Transition name="screen" mode="out-in">
        <component :is="Component" />
      </Transition>
    </RouterView>
  </main>
  <AppToast />
  <AppLoading />
</template>

<style>
.screen-enter-active,
.screen-leave-active {
  transition: opacity 0.35s var(--ease-out-soft), transform 0.35s var(--ease-out-soft);
}
.screen-enter-from,
.screen-leave-to {
  opacity: 0;
  transform: translateY(8px);
}
</style>
