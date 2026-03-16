<script setup lang="ts">
const props = defineProps<{
  /** Panel title shown in the header bar */
  title: string
  /** Unique panel identifier for testing and click-outside logic */
  panelId: string
}>()

const visible = defineModel<boolean>('visible', { required: true })

// Global panel stack on window — survives HMR, shared across all instances
function getPanelStack(): string[] {
  if (import.meta.client) {
    const w = window as any
    if (!w.__fpStack) w.__fpStack = []
    return w.__fpStack
  }
  return []
}
let nextZ = 1000

const zIndex = ref(1000)

function close() {
  visible.value = false
}

function onClickOutside(e: MouseEvent) {
  const target = e.target as HTMLElement
  if (target.closest('[data-floating-panel]')) return
  close()
}

function onKeydown(e: KeyboardEvent) {
  const stack = getPanelStack()
  if (e.key === 'Escape' && stack[stack.length - 1] === props.panelId) {
    close()
  }
}

function activate() {
  nextZ += 10
  zIndex.value = nextZ
  const stack = getPanelStack()
  if (!stack.includes(props.panelId)) stack.push(props.panelId)
  nextTick(() => {
    document.addEventListener('mousedown', onClickOutside)
    document.addEventListener('keydown', onKeydown)
  })
}

function deactivate() {
  const s = getPanelStack(); const idx = s.indexOf(props.panelId)
  if (idx !== -1) s.splice(idx, 1)
  document.removeEventListener('mousedown', onClickOutside)
  document.removeEventListener('keydown', onKeydown)
}

watch(visible, (val) => {
  if (val) activate()
  else deactivate()
})

onMounted(() => {
  if (visible.value) activate()
})

onUnmounted(() => {
  const idx = panelStack.indexOf(props.panelId)
  if (idx !== -1) panelStack.splice(idx, 1)
  document.removeEventListener('mousedown', onClickOutside)
  document.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <Teleport to="body">
    <Transition name="fp-anim">
      <div
        v-if="visible"
        :data-panel-id="panelId"
        data-floating-panel
        class="fp-backdrop"
        :style="{ zIndex }"
      >
        <div class="fp-card">
          <div class="fp-header">
            <span class="fp-title">{{ title }}</span>
            <button class="fp-close" :data-close-panel="panelId" @click="close" aria-label="Close">
              <i class="pi pi-times" />
            </button>
          </div>
          <div class="fp-body">
            <slot />
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style>
/* Global styles — not scoped, because Teleport renders outside component tree */
.fp-backdrop {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}

.fp-card {
  pointer-events: auto;
  background: var(--p-surface-900);
  border: 1px solid var(--p-surface-600);
  border-radius: 8px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6);
  max-height: 80vh;
  width: min(92vw, 1000px);
  display: flex;
  flex-direction: column;
}

.fp-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.6rem 1rem;
  border-bottom: 1px solid var(--p-surface-700);
  flex-shrink: 0;
  background: var(--p-surface-800);
  border-radius: 8px 8px 0 0;
}

.fp-title {
  font-weight: 600;
  font-size: 0.95rem;
  color: var(--p-text-color);
}

.fp-close {
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

.fp-close:hover {
  color: var(--p-text-color);
  background: var(--p-surface-600);
}

.fp-body {
  padding: 1rem;
  overflow: auto;
  flex: 1;
}

.fp-anim-enter-active,
.fp-anim-leave-active {
  transition: opacity 0.15s ease, transform 0.15s ease;
}

.fp-anim-enter-from,
.fp-anim-leave-to {
  opacity: 0;
  transform: scale(0.95);
}
</style>
