<script setup lang="ts">
import type { Disk } from '@anas/shared'
import { formatBytes } from '~/utils/format'

defineProps<{
  disks: Disk[]
}>()

const emit = defineEmits<{
  (e: 'show-smart', diskId: string): void
}>()

function statusSeverity(status: string): 'success' | 'info' | 'secondary' | 'warn' {
  switch (status) {
    case 'available': return 'success'
    case 'pool_member': return 'info'
    case 'system': return 'secondary'
    default: return 'warn'
  }
}

function statusLabel(status: string): string {
  switch (status) {
    case 'available': return 'Available'
    case 'pool_member': return 'Pool Member'
    case 'system': return 'System'
    case 'other': return 'In Use'
    default: return status
  }
}

function diskType(rotational: boolean): string {
  return rotational ? 'HDD' : 'SSD'
}
</script>

<template>
  <DataTable
    :value="disks"
    striped-rows
    size="small"
    :rows="20"
  >
    <Column field="name" header="Name" sortable>
      <template #body="{ data: disk }">
        <strong>{{ disk.name }}</strong>
      </template>
    </Column>

    <Column field="id" header="ID" sortable />

    <Column field="size" header="Size" sortable>
      <template #body="{ data: disk }">
        {{ formatBytes(disk.size) }}
      </template>
    </Column>

    <Column field="model" header="Model" sortable>
      <template #body="{ data: disk }">
        {{ disk.model ?? '-' }}
      </template>
    </Column>

    <Column field="serial" header="Serial" sortable>
      <template #body="{ data: disk }">
        {{ disk.serial ?? '-' }}
      </template>
    </Column>

    <Column field="transport" header="Transport" sortable>
      <template #body="{ data: disk }">
        {{ disk.transport ?? '-' }}
      </template>
    </Column>

    <Column header="Type" sortable :sort-field="'rotational'">
      <template #body="{ data: disk }">
        {{ diskType(disk.rotational) }}
      </template>
    </Column>

    <Column field="status" header="Status" sortable>
      <template #body="{ data: disk }">
        <Tag :value="statusLabel(disk.status)" :severity="statusSeverity(disk.status)" />
      </template>
    </Column>

    <Column field="poolName" header="Pool" sortable>
      <template #body="{ data: disk }">
        {{ disk.poolName ?? '-' }}
      </template>
    </Column>

    <Column header="SMART">
      <template #body="{ data: disk }">
        <Button
          icon="pi pi-chart-bar"
          text
          rounded
          size="small"
          v-tooltip.top="'View SMART data'"
          @click="emit('show-smart', disk.id)"
        />
      </template>
    </Column>

    <template #empty>
      <div style="text-align: center; padding: 2rem; color: var(--p-text-muted-color);">
        No disks found.
      </div>
    </template>
  </DataTable>
</template>
