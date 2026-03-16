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

function diskType(disk: Disk): string {
  if (disk.transport === 'nvme') return 'NVMe'
  if (disk.transport === 'usb') return 'USB'
  return disk.rotational ? 'HDD' : 'SSD'
}

function sectorInfo(disk: Disk): string {
  const phys = disk.physicalSectorSize
  const log = disk.logicalSectorSize
  if (!phys && !log) return ''
  if (phys === log) return `${phys}B sectors`
  return `${log}B logical / ${phys}B physical`
}
</script>

<template>
  <DataTable
    :value="disks"
    striped-rows
    size="small"
    :rows="20"
    data-table-id="disk-list"
  >
    <Column field="name" header="Device" sortable style="width: 5rem;">
      <template #body="{ data: disk }">
        <strong>/dev/{{ disk.name }}</strong>
      </template>
    </Column>

    <Column field="model" header="Model" sortable>
      <template #body="{ data: disk }">
        <span v-tooltip.bottom="[disk.vendor, disk.revision ? `FW: ${disk.revision}` : null, sectorInfo(disk)].filter(Boolean).join(' · ') || undefined">
          {{ disk.model ?? '-' }}
        </span>
      </template>
    </Column>

    <Column field="serial" header="Serial" sortable />

    <Column field="size" header="Size" sortable style="width: 6rem;">
      <template #body="{ data: disk }">
        {{ formatBytes(disk.size) }}
      </template>
    </Column>

    <Column header="Type" sortable :sort-field="'rotational'" style="width: 4.5rem;">
      <template #body="{ data: disk }">
        {{ diskType(disk) }}
      </template>
    </Column>

    <Column field="status" header="Status" sortable style="width: 7rem;">
      <template #body="{ data: disk }">
        <Tag :value="statusLabel(disk.status)" :severity="statusSeverity(disk.status)" />
      </template>
    </Column>

    <Column field="poolName" header="Pool" sortable style="width: 6rem;">
      <template #body="{ data: disk }">
        {{ disk.poolName ?? '-' }}
      </template>
    </Column>

    <Column header="" style="width: 3rem;">
      <template #body="{ data: disk }">
        <Button
          icon="pi pi-chart-bar"
          text
          rounded
          size="small"
          v-tooltip.top="'SMART health'"
          @click="emit('show-smart', disk.id)"
        />
      </template>
    </Column>

    <template #empty>
      <div style="text-align: center; padding: 2rem; color: #bac2de;">
        No disks found.
      </div>
    </template>
  </DataTable>
</template>
