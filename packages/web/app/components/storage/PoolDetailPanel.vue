<script setup lang="ts">
import type { PoolDetail } from '@anas/shared'

const props = defineProps<{
  poolName: string
}>()

const visible = defineModel<boolean>('visible', { required: true })

const pool = ref<PoolDetail | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)

async function load(initial = false) {
  if (initial) {
    loading.value = true
    error.value = null
    pool.value = null
  }
  try {
    const res = await $fetch<{ data: PoolDetail }>(`/api/pools/${props.poolName}`)
    pool.value = res.data
    error.value = null
  }
  catch (e: any) {
    error.value = e.message ?? 'Failed to load pool details'
  }
  finally {
    loading.value = false
  }
}

watch(visible, (val) => {
  if (val)
    load(true)
}, { immediate: true })
</script>

<template>
  <FloatingPanel v-model:visible="visible" :panel-id="`pool-detail-${poolName}`" :title="poolName">
    <Message v-if="error" severity="error" :closable="false">
      {{ error }}
    </Message>

    <div v-else-if="loading" style="text-align: center; padding: 2rem;">
      <ProgressSpinner />
    </div>

    <StoragePoolDetail v-else-if="pool" :pool="pool" @refresh="load()" />
  </FloatingPanel>
</template>
