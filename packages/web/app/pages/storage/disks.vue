<script setup lang="ts">
import type { Disk } from '@anas/shared'

definePageMeta({ layout: 'default' })

const { data, status, error } = await useFetch<{ data: Disk[] }>('/api/disks')

const disks = computed(() => data.value?.data ?? [])

// Details/actions remain floating panels (story 13.1): SMART on the chart
// button, pool detail on a pool-name click.
const smartDiskId = ref<string | null>(null)
const smartVisible = ref(false)

const poolName = ref('')
const poolVisible = ref(false)

function showSmart(diskId: string) {
  smartDiskId.value = diskId
  smartVisible.value = true
}

function showPool(name: string) {
  poolName.value = name
  poolVisible.value = true
}
</script>

<template>
  <div>
    <h1 style="margin-bottom: 1rem;">
      Disks
    </h1>

    <Message v-if="error" severity="error" :closable="false">
      Failed to load disks: {{ error.message }}
    </Message>

    <ProgressSpinner v-else-if="status === 'pending'" style="margin: 2rem auto; display: block;" />

    <StorageDiskList v-else :disks="disks" @show-smart="showSmart" @show-pool="showPool" />

    <StorageSmartDataPanel
      v-if="smartDiskId"
      v-model:visible="smartVisible"
      :disk-id="smartDiskId"
    />

    <StoragePoolDetailPanel
      v-if="poolName"
      v-model:visible="poolVisible"
      :pool-name="poolName"
    />
  </div>
</template>
