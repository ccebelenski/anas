<script setup lang="ts">
import type { PoolSummary } from '@anas/shared'
import { formatBytes } from '~/utils/format'

defineProps<{
  pools: PoolSummary[]
}>()

function stateSeverity(state: string): 'success' | 'warn' | 'danger' | 'secondary' {
  switch (state) {
    case 'ONLINE': return 'success'
    case 'DEGRADED': return 'warn'
    case 'FAULTED':
    case 'SUSPENDED': return 'danger'
    default: return 'secondary'
  }
}
</script>

<template>
  <DataTable
    :value="pools"
    striped-rows
    size="small"
    :rows="20"
  >
    <Column field="name" header="Name" sortable>
      <template #body="{ data: pool }">
        <strong>{{ pool.name }}</strong>
      </template>
    </Column>

    <Column field="state" header="State" sortable>
      <template #body="{ data: pool }">
        <Tag :value="pool.state" :severity="stateSeverity(pool.state)" />
      </template>
    </Column>

    <Column field="size" header="Size" sortable>
      <template #body="{ data: pool }">
        {{ formatBytes(pool.size) }}
      </template>
    </Column>

    <Column field="allocated" header="Used" sortable>
      <template #body="{ data: pool }">
        {{ formatBytes(pool.allocated) }}
        <span style="color: var(--p-text-muted-color); margin-left: 0.25rem;">
          ({{ pool.capacity }}%)
        </span>
      </template>
    </Column>

    <Column field="free" header="Free" sortable>
      <template #body="{ data: pool }">
        {{ formatBytes(pool.free) }}
      </template>
    </Column>

    <Column field="fragmentation" header="Frag" sortable>
      <template #body="{ data: pool }">
        {{ pool.fragmentation }}%
      </template>
    </Column>

    <Column field="dedupRatio" header="Dedup" sortable>
      <template #body="{ data: pool }">
        {{ pool.dedupRatio.toFixed(2) }}x
      </template>
    </Column>

    <Column header="Scan">
      <template #body="{ data: pool }">
        <Tag v-if="pool.scanRunning" value="Scrubbing" severity="info" />
        <span v-else style="color: var(--p-text-muted-color);">-</span>
      </template>
    </Column>

    <Column header="Health">
      <template #body="{ data: pool }">
        <span v-if="pool.health" v-tooltip.top="pool.health.status" style="cursor: help;">
          <i class="pi pi-exclamation-triangle" style="color: var(--p-yellow-400);" />
        </span>
        <i v-else class="pi pi-check-circle" style="color: var(--p-green-400);" />
      </template>
    </Column>

    <template #empty>
      <div style="text-align: center; padding: 2rem; color: var(--p-text-muted-color);">
        No pools found.
      </div>
    </template>
  </DataTable>
</template>
