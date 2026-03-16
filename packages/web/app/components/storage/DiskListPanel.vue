<script setup lang="ts">
import type { Disk } from '@anas/shared'

const visible = defineModel<boolean>('visible', { required: true })

const disks = ref<Disk[]>([])
const loading = ref(false)
const error = ref<string | null>(null)

const smartDiskId = ref<string | null>(null)
const smartVisible = ref(false)

const poolName = ref('')
const poolVisible = ref(false)

watch(visible, async (val) => {
  if (val) {
    loading.value = true
    error.value = null
    try {
      const res = await $fetch<{ data: Disk[] }>('/api/disks')
      disks.value = res.data
    }
    catch (e: any) {
      error.value = e.message ?? 'Failed to load disks'
    }
    finally {
      loading.value = false
    }
  }
})

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
  <FloatingPanel v-model:visible="visible" panel-id="disk-list" title="Disks">
    <Message v-if="error" severity="error" :closable="false">
      {{ error }}
    </Message>

    <div v-else-if="loading" style="text-align: center; padding: 2rem;">
      <ProgressSpinner />
    </div>

    <StorageDiskList v-else :disks="disks" @show-smart="showSmart" @show-pool="showPool" />
  </FloatingPanel>

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
</template>
