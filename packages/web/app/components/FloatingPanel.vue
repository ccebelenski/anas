<script setup lang="ts">
defineProps<{
  /** Panel title shown in the header bar */
  title: string
}>()

const visible = defineModel<boolean>('visible', { required: true })

function close() {
  visible.value = false
}

function onClickOutside(e: MouseEvent) {
  const target = e.target as HTMLElement
  if (target.closest('.floating-panel')) return
  close()
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.stopPropagation()
    close()
  }
}

watch(visible, (val) => {
  if (val) {
    nextTick(() => {
      document.addEventListener('mousedown', onClickOutside)
      document.addEventListener('keydown', onKeydown, true)
    })
  }
  else {
    document.removeEventListener('mousedown', onClickOutside)
    document.removeEventListener('keydown', onKeydown, true)
  }
})

onUnmounted(() => {
  document.removeEventListener('mousedown', onClickOutside)
  document.removeEventListener('keydown', onKeydown, true)
})
</script>

<template>
  <Teleport to="body">
    <Transition name="panel">
      <div v-if="visible" class="floating-panel-backdrop">
        <div class="floating-panel">
          <div class="floating-panel-header">
            <span class="floating-panel-title">{{ title }}</span>
            <button class="floating-panel-close" @click="close" aria-label="Close">
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
  pointer-events: none;
}

.floating-panel {
  pointer-events: auto;
  background: var(--p-surface-900);
  border: 1px solid var(--p-surface-600);
  border-radius: 8px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6);
  max-height: 80vh;
  width: min(90vw, 1000px);
  display: flex;
  flex-direction: column;
}

.floating-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.6rem 1rem;
  border-bottom: 1px solid var(--p-surface-700);
  flex-shrink: 0;
  background: var(--p-surface-800);
  border-radius: 8px 8px 0 0;
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
  padding: 0.35rem;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 1rem;
}

.floating-panel-close:hover {
  color: var(--p-text-color);
  background: var(--p-surface-600);
}

.floating-panel-body {
  padding: 1rem;
  overflow: auto;
  flex: 1;
}

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
