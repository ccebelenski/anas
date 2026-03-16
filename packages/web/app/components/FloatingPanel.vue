<script setup lang="ts">
const props = defineProps<{
  /** Panel title shown in the header bar */
  title: string
  /** Width of the panel (CSS value) */
  width?: string
}>()

const visible = defineModel<boolean>('visible', { required: true })

function onClickOutside(e: MouseEvent) {
  const panel = (e.target as HTMLElement).closest('.floating-panel')
  if (!panel) {
    visible.value = false
  }
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    visible.value = false
  }
}

watch(visible, (val) => {
  if (val) {
    document.addEventListener('mousedown', onClickOutside)
    document.addEventListener('keydown', onKeydown)
  }
  else {
    document.removeEventListener('mousedown', onClickOutside)
    document.removeEventListener('keydown', onKeydown)
  }
})

onUnmounted(() => {
  document.removeEventListener('mousedown', onClickOutside)
  document.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <Teleport to="body">
    <Transition name="panel">
      <div v-if="visible" class="floating-panel-backdrop">
        <div
          class="floating-panel"
          :style="{ width: width ?? '800px', maxWidth: '90vw' }"
        >
          <div class="floating-panel-header">
            <span class="floating-panel-title">{{ title }}</span>
            <button class="floating-panel-close" @click="visible = false">
              <i class="pi pi-times" />
            </button>
          </div>
          <div class="floating-panel-body">
            <slot />
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.floating-panel-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  /* No dimming backdrop — just positioning */
}

.floating-panel {
  background: var(--p-surface-800);
  border: 1px solid var(--p-surface-600);
  border-radius: 8px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
  max-height: 80vh;
  display: flex;
  flex-direction: column;
}

.floating-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--p-surface-600);
  flex-shrink: 0;
}

.floating-panel-title {
  font-weight: 600;
  font-size: 0.95rem;
  color: var(--p-text-color);
}

.floating-panel-close {
  background: none;
  border: none;
  color: var(--p-text-muted-color);
  cursor: pointer;
  padding: 0.25rem;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.floating-panel-close:hover {
  color: var(--p-text-color);
  background: var(--p-surface-700);
}

.floating-panel-body {
  padding: 0.75rem 1rem;
  overflow-y: auto;
  flex: 1;
}

/* Transition */
.panel-enter-active,
.panel-leave-active {
  transition: opacity 0.15s ease, transform 0.15s ease;
}

.panel-enter-from,
.panel-leave-to {
  opacity: 0;
  transform: scale(0.95);
}
</style>
