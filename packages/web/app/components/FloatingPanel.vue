<script setup lang="ts">
const props = defineProps<{
  title: string
  panelId: string
}>()

const visible = defineModel<boolean>('visible', { required: true })

// --- Global state on window (survives HMR, shared across instances) ---
function getStack(): string[] {
  if (!import.meta.client) return []
  const w = window as any
  if (!w.__fpStack) w.__fpStack = []
  return w.__fpStack
}

function getNextZ(): number {
  if (!import.meta.client) return 1000
  const w = window as any
  w.__fpZ = (w.__fpZ ?? 1000) + 10
  return w.__fpZ
}

// --- Panel position & z-index ---
const zIndex = ref(1000)
const posX = ref(0)
const posY = ref(0)
const positioned = ref(false) // false = auto-center, true = user dragged

// --- Drag state ---
const dragging = ref(false)
let dragStartX = 0
let dragStartY = 0
let dragOriginX = 0
let dragOriginY = 0

function onDragStart(e: MouseEvent) {
  // Only drag on left-click, not on close button
  if (e.button !== 0) return
  if ((e.target as HTMLElement).closest('[data-close-panel]')) return
  dragging.value = true
  dragStartX = e.clientX
  dragStartY = e.clientY
  dragOriginX = posX.value
  dragOriginY = posY.value
  document.addEventListener('mousemove', onDragMove)
  document.addEventListener('mouseup', onDragEnd)
  e.preventDefault()
}

function onDragMove(e: MouseEvent) {
  posX.value = dragOriginX + (e.clientX - dragStartX)
  posY.value = dragOriginY + (e.clientY - dragStartY)
  positioned.value = true
}

function onDragEnd() {
  dragging.value = false
  document.removeEventListener('mousemove', onDragMove)
  document.removeEventListener('mouseup', onDragEnd)
}

// --- Bring to front on click ---
function bringToFront() {
  zIndex.value = getNextZ()
  // Move to top of stack
  const stack = getStack()
  const idx = stack.indexOf(props.panelId)
  if (idx !== -1) stack.splice(idx, 1)
  stack.push(props.panelId)
}

// --- Close ---
function close() {
  visible.value = false
}

function onClickOutside(e: MouseEvent) {
  const target = e.target as HTMLElement
  if (target.closest('[data-floating-panel]')) return
  close()
}

function onKeydown(e: KeyboardEvent) {
  const stack = getStack()
  if (e.key === 'Escape' && stack[stack.length - 1] === props.panelId) {
    close()
  }
}

// --- Lifecycle ---
function activate() {
  zIndex.value = getNextZ()
  // Center on screen
  posX.value = 0
  posY.value = 0
  positioned.value = false
  const stack = getStack()
  if (!stack.includes(props.panelId)) stack.push(props.panelId)
  nextTick(() => {
    document.addEventListener('mousedown', onClickOutside)
    document.addEventListener('keydown', onKeydown)
  })
}

function deactivate() {
  const s = getStack()
  const idx = s.indexOf(props.panelId)
  if (idx !== -1) s.splice(idx, 1)
  document.removeEventListener('mousedown', onClickOutside)
  document.removeEventListener('keydown', onKeydown)
  document.removeEventListener('mousemove', onDragMove)
  document.removeEventListener('mouseup', onDragEnd)
}

watch(visible, (val) => {
  if (val) activate()
  else deactivate()
})

onMounted(() => {
  if (visible.value) activate()
})

onUnmounted(() => {
  deactivate()
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="visible"
      :data-panel-id="panelId"
      data-floating-panel
      class="fp-card"
      :class="{ 'fp-dragging': dragging, 'fp-centered': !positioned }"
      :style="{
        zIndex,
        ...(positioned ? { left: posX + 'px', top: posY + 'px' } : {}),
      }"
      @mousedown="bringToFront"
    >
      <div
        class="fp-header"
        @mousedown="onDragStart"
      >
        <span class="fp-title">{{ title }}</span>
        <button class="fp-close" :data-close-panel="panelId" @click="close" aria-label="Close">
          <i class="pi pi-times" />
        </button>
      </div>
      <div class="fp-body">
        <slot />
      </div>
    </div>
  </Teleport>
</template>

<style>
.fp-card {
  position: fixed;
  background: var(--p-surface-900);
  border: 1px solid var(--p-surface-500);
  border-radius: 8px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6);
  max-height: 80vh;
  width: min(92vw, 960px);
  display: flex;
  flex-direction: column;
}

/* Auto-center when not yet dragged */
.fp-centered {
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
}

.fp-dragging {
  user-select: none;
}

.fp-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.5rem 0.75rem;
  border-bottom: 1px solid var(--p-surface-600);
  flex-shrink: 0;
  background: var(--p-surface-700);
  border-radius: 8px 8px 0 0;
  cursor: grab;
}

.fp-dragging .fp-header {
  cursor: grabbing;
}

.fp-title {
  font-weight: 600;
  font-size: 0.9rem;
  color: var(--p-text-color);
}

.fp-close {
  background: none;
  border: none;
  color: var(--p-text-muted-color);
  cursor: pointer;
  padding: 0.3rem 0.5rem;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.9rem;
}

.fp-close:hover {
  color: var(--p-text-color);
  background: var(--p-surface-500);
}

.fp-body {
  padding: 0.75rem;
  overflow: auto;
  flex: 1;
}
</style>
