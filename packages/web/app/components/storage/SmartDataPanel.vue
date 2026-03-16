<script setup lang="ts">
import type { SmartData } from '@anas/shared'

const props = defineProps<{
  diskId: string
}>()

const visible = defineModel<boolean>('visible', { required: true })

const smartData = ref<SmartData | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)

watch(visible, async (val) => {
  if (val) {
    loading.value = true
    error.value = null
    smartData.value = null
    try {
      const res = await $fetch<{ data: SmartData }>(`/api/disks/${props.diskId}/smart`)
      smartData.value = res.data
    }
    catch (e: any) {
      error.value = e.message ?? 'Failed to load SMART data'
    }
    finally {
      loading.value = false
    }
  }
}, { immediate: true })

function healthSeverity(health: string): 'success' | 'danger' | 'secondary' {
  switch (health) {
    case 'PASSED': return 'success'
    case 'FAILED': return 'danger'
    default: return 'secondary'
  }
}

function formatHours(hours: number | null): string {
  if (hours === null) return '-'
  const days = Math.floor(hours / 24)
  if (days > 0) return `${hours.toLocaleString()}h (${days.toLocaleString()}d)`
  return `${hours}h`
}
</script>

<template>
  <FloatingPanel v-model:visible="visible" :title="`SMART \u2014 ${diskId}`">
    <Message v-if="error" severity="error" :closable="false">
      {{ error }}
    </Message>

    <div v-else-if="loading" style="text-align: center; padding: 2rem;">
      <ProgressSpinner />
    </div>

    <div v-else-if="smartData && !smartData.supported" style="text-align: center; padding: 2rem; color: var(--p-text-muted-color);">
      SMART is not supported on this disk.
    </div>

    <div v-else-if="smartData">
      <!-- Overview -->
      <div style="display: flex; gap: 2rem; flex-wrap: wrap; margin-bottom: 1.5rem;">
        <div>
          <span style="color: var(--p-text-muted-color); font-size: 0.85em;">Health</span>
          <div style="margin-top: 0.25rem;">
            <Tag :value="smartData.overallHealth" :severity="healthSeverity(smartData.overallHealth)" />
          </div>
        </div>

        <div>
          <span style="color: var(--p-text-muted-color); font-size: 0.85em;">Temperature</span>
          <div style="margin-top: 0.25rem; font-size: 1.1em; font-weight: 600;">
            {{ smartData.temperature !== null ? `${smartData.temperature}\u00B0C` : '-' }}
          </div>
        </div>

        <div>
          <span style="color: var(--p-text-muted-color); font-size: 0.85em;">Power-On Hours</span>
          <div style="margin-top: 0.25rem; font-size: 1.1em; font-weight: 600;">
            {{ formatHours(smartData.powerOnHours) }}
          </div>
        </div>

        <div v-if="smartData.nvmePercentageUsed !== null">
          <span style="color: var(--p-text-muted-color); font-size: 0.85em;">NVMe Life Used</span>
          <div style="margin-top: 0.25rem; font-size: 1.1em; font-weight: 600;">
            {{ smartData.nvmePercentageUsed }}%
          </div>
        </div>

        <div v-if="smartData.nvmeAvailableSpare !== null">
          <span style="color: var(--p-text-muted-color); font-size: 0.85em;">NVMe Available Spare</span>
          <div style="margin-top: 0.25rem; font-size: 1.1em; font-weight: 600;">
            {{ smartData.nvmeAvailableSpare }}%
          </div>
        </div>
      </div>

      <!-- SATA Attributes Table -->
      <div v-if="smartData.attributes.length > 0">
        <h4 style="margin: 0 0 0.5rem 0; font-size: 0.9em; color: var(--p-text-muted-color);">
          SMART Attributes
        </h4>
        <DataTable
          :value="smartData.attributes"
          striped-rows
          size="small"
          :rows="30"
        >
          <Column field="id" header="ID" sortable style="width: 4rem;" />

          <Column field="name" header="Attribute" sortable />

          <Column field="value" header="Value" sortable style="width: 5rem; text-align: right;">
            <template #body="{ data: attr }">
              {{ attr.value }}
            </template>
          </Column>

          <Column field="worst" header="Worst" sortable style="width: 5rem; text-align: right;">
            <template #body="{ data: attr }">
              {{ attr.worst }}
            </template>
          </Column>

          <Column field="threshold" header="Thresh" sortable style="width: 5rem; text-align: right;">
            <template #body="{ data: attr }">
              {{ attr.threshold }}
            </template>
          </Column>

          <Column field="rawValue" header="Raw" sortable style="width: 7rem; text-align: right;">
            <template #body="{ data: attr }">
              {{ attr.rawValue.toLocaleString() }}
            </template>
          </Column>

          <Column header="Status" style="width: 5rem;">
            <template #body="{ data: attr }">
              <Tag v-if="attr.failing" value="FAILING" severity="danger" />
              <Tag v-else value="OK" severity="success" />
            </template>
          </Column>
        </DataTable>
      </div>
    </div>
  </FloatingPanel>
</template>
