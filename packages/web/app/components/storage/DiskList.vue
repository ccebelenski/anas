<script setup lang="ts">
import type { Disk } from '@anas/shared'
import { formatBytes } from '~/utils/format'

defineProps<{
  disks: Disk[]
}>()

const emit = defineEmits<{
  (e: 'showSmart', diskId: string): void
  (e: 'showPool', poolName: string): void
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
  if (disk.transport === 'nvme')
    return 'NVMe'
  if (disk.transport === 'usb')
    return 'USB'
  return disk.rotational ? 'HDD' : 'SSD'
}

function sectorInfo(disk: Disk): string {
  const phys = disk.physicalSectorSize
  const log = disk.logicalSectorSize
  if (!phys && !log)
    return ''
  if (phys === log)
    return `${phys}B sectors`
  return `${log}B logical / ${phys}B physical`
}

function smartSeverity(healthy: boolean | null): 'success' | 'danger' | 'secondary' {
  if (healthy === true)
    return 'success'
  if (healthy === false)
    return 'danger'
  return 'secondary'
}

function smartLabel(healthy: boolean | null): string {
  if (healthy === true)
    return 'OK'
  if (healthy === false)
    return 'FAIL'
  return '—'
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
        <strong :data-disk-name="disk.name">/dev/{{ disk.name }}</strong>
      </template>
    </Column>

    <Column field="model" header="Model" sortable>
      <template #body="{ data: disk }">
        <span v-tooltip.bottom="[disk.model, disk.vendor, disk.revision ? `FW: ${disk.revision}` : null, disk.formFactor, sectorInfo(disk)].filter(Boolean).join(' · ') || undefined">
          {{ disk.modelFamily ?? disk.model ?? '-' }}
        </span>
      </template>
    </Column>

    <Column field="serial" header="Serial" sortable />

    <Column field="size" header="Size" sortable style="width: 6rem;">
      <template #body="{ data: disk }">
        {{ formatBytes(disk.size) }}
      </template>
    </Column>

    <Column header="Type" sortable sort-field="rotational" style="width: 4.5rem;">
      <template #body="{ data: disk }">
        {{ diskType(disk) }}
      </template>
    </Column>

    <Column header="Health" sortable sort-field="smartHealthy" style="width: 4.5rem;">
      <template #body="{ data: disk }">
        <Tag
          v-tooltip.top="disk.smartHealthy === true ? 'SMART self-assessment: PASSED' : disk.smartHealthy === false ? 'SMART self-assessment: FAILED' : 'SMART not available'"
          :value="smartLabel(disk.smartHealthy)"
          :severity="smartSeverity(disk.smartHealthy)"
        />
      </template>
    </Column>

    <Column field="status" header="Status" sortable style="width: 7rem;">
      <template #body="{ data: disk }">
        <Tag :value="statusLabel(disk.status)" :severity="statusSeverity(disk.status)" />
      </template>
    </Column>

    <Column field="poolName" header="Pool" sortable style="width: 6rem;">
      <template #body="{ data: disk }">
        <span
          v-if="disk.poolName"
          class="pool-link"
          :data-pool-link="disk.poolName"
          @click="emit('showPool', disk.poolName!)"
        >{{ disk.poolName }}</span>
        <span v-else>-</span>
      </template>
    </Column>

    <Column header="" style="width: 3rem;">
      <template #body="{ data: disk }">
        <Button
          v-tooltip.top="'SMART details'"
          icon="pi pi-chart-bar"
          text
          rounded
          size="small"
          :data-smart-btn="disk.id"
          @click="emit('showSmart', disk.id)"
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

<style scoped>
.pool-link {
  color: #89b4fa;
  cursor: pointer;
}
.pool-link:hover {
  text-decoration: underline;
}
</style>
