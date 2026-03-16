<script setup lang="ts">
import type { PoolSummary } from '@anas/shared'

const visible = defineModel<boolean>('visible', { required: true })

const pools = ref<PoolSummary[]>([])
const loading = ref(false)
const error = ref<string | null>(null)

watch(visible, async (val) => {
  if (val) {
    loading.value = true
    error.value = null
    try {
      const res = await $fetch<{ data: PoolSummary[] }>('/api/pools')
      pools.value = res.data
    }
    catch (e: any) {
      error.value = e.message ?? 'Failed to load pools'
    }
    finally {
      loading.value = false
    }
  }
})
</script>

<template>
  <FloatingPanel v-model:visible="visible" title="Storage Pools" width="900px">
    <Message v-if="error" severity="error" :closable="false">
      {{ error }}
    </Message>

    <div v-else-if="loading" style="text-align: center; padding: 2rem;">
      <ProgressSpinner />
    </div>

    <StoragePoolList v-else :pools="pools" />
  </FloatingPanel>
</template>
