<script setup lang="ts">
import type { PoolSummary } from '@anas/shared'

definePageMeta({ layout: 'default' })

const { data, status, error } = await useFetch<{ data: PoolSummary[] }>('/api/pools')

const pools = computed(() => data.value?.data ?? [])
</script>

<template>
  <div>
    <h1 style="margin-bottom: 1rem;">
      Storage Pools
    </h1>

    <Message v-if="error" severity="error" :closable="false">
      Failed to load pools: {{ error.message }}
    </Message>

    <ProgressSpinner v-else-if="status === 'pending'" style="margin: 2rem auto; display: block;" />

    <StoragePoolList v-else :pools="pools" />
  </div>
</template>
