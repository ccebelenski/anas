<script setup lang="ts">
import type { PoolDetail, VdevGroup, Vdev, PoolDisk, ScanStatus } from '@anas/shared'
import { formatBytes } from '~/utils/format'

defineProps<{
  pool: PoolDetail
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

function roleLabel(role: string): string {
  return role.charAt(0).toUpperCase() + role.slice(1)
}

function hasErrors(disk: PoolDisk): boolean {
  return disk.readErrors > 0 || disk.writeErrors > 0 || disk.checksumErrors > 0
}

function scanFunctionLabel(fn: string): string {
  return fn === 'SCRUB' ? 'Scrub' : 'Resilver'
}

function scanStateLabel(state: string): string {
  switch (state) {
    case 'SCANNING': return 'In Progress'
    case 'FINISHED': return 'Completed'
    case 'CANCELED': return 'Canceled'
    default: return state
  }
}

function formatDate(iso: string | null): string {
  if (!iso) return '-'
  return new Date(iso).toLocaleString()
}
</script>

<template>
  <div class="pool-detail">
    <!-- Header -->
    <div class="pool-detail-header">
      <span class="pool-detail-name">{{ pool.name }}</span>
      <Tag :value="pool.state" :severity="stateSeverity(pool.state)" />
      <span v-if="pool.health" class="pool-detail-health">
        {{ pool.health.status }}
      </span>
    </div>

    <!-- Summary row -->
    <div class="pool-detail-summary">
      <div class="summary-item">
        <span class="summary-label">Size</span>
        <span class="summary-value">{{ formatBytes(pool.size) }}</span>
      </div>
      <div class="summary-item">
        <span class="summary-label">Used</span>
        <span class="summary-value">
          {{ formatBytes(pool.allocated) }}
          <span class="summary-pct">({{ pool.capacity }}%)</span>
        </span>
      </div>
      <div class="summary-item">
        <span class="summary-label">Free</span>
        <span class="summary-value">{{ formatBytes(pool.free) }}</span>
      </div>
      <div class="summary-item">
        <span class="summary-label">Fragmentation</span>
        <span class="summary-value">{{ pool.fragmentation }}%</span>
      </div>
      <div class="summary-item">
        <span class="summary-label">Dedup Ratio</span>
        <span class="summary-value">{{ pool.dedupRatio.toFixed(2) }}x</span>
      </div>
    </div>

    <!-- Scan section -->
    <div class="pool-detail-section">
      <h3>Scan</h3>
      <div v-if="pool.scan" class="scan-info">
        <div class="scan-row">
          <span class="scan-label">Type:</span>
          <span>{{ scanFunctionLabel(pool.scan.function) }}</span>
        </div>
        <div class="scan-row">
          <span class="scan-label">State:</span>
          <span>{{ scanStateLabel(pool.scan.state) }}</span>
        </div>
        <div v-if="pool.scan.state === 'SCANNING'" class="scan-row scan-progress-row">
          <span class="scan-label">Progress:</span>
          <ProgressBar
            :value="pool.scan.percentComplete"
            :show-value="true"
            style="flex: 1; height: 1.25rem;"
          />
        </div>
        <div class="scan-row">
          <span class="scan-label">Started:</span>
          <span>{{ formatDate(pool.scan.startedAt) }}</span>
        </div>
        <div class="scan-row">
          <span class="scan-label">Finished:</span>
          <span>{{ formatDate(pool.scan.finishedAt) }}</span>
        </div>
        <div class="scan-row">
          <span class="scan-label">Errors:</span>
          <span :class="{ 'error-count': pool.scan.errors > 0 }">
            {{ pool.scan.errors }}
          </span>
        </div>
      </div>
      <div v-else class="no-data">No scan history</div>
    </div>

    <!-- Vdev Topology section -->
    <div class="pool-detail-section">
      <h3>Topology</h3>
      <div v-for="group in pool.vdevGroups" :key="group.role" class="vdev-group">
        <h4 class="vdev-group-role">{{ roleLabel(group.role) }}</h4>
        <div v-for="vdev in group.vdevs" :key="vdev.name" class="vdev-item">
          <div class="vdev-header">
            <span class="vdev-name">{{ vdev.name }}</span>
            <Tag :value="vdev.type" severity="secondary" class="vdev-type-tag" />
            <Tag :value="vdev.state" :severity="stateSeverity(vdev.state)" />
          </div>
          <div v-if="vdev.disks.length > 0" class="vdev-disks">
            <div
              v-for="disk in vdev.disks"
              :key="disk.id"
              class="disk-row"
            >
              <span class="disk-id">{{ disk.id }}</span>
              <Tag :value="disk.state" :severity="stateSeverity(disk.state)" />
              <span class="disk-errors" :class="{ 'has-errors': hasErrors(disk) }">
                R:{{ disk.readErrors }} W:{{ disk.writeErrors }} C:{{ disk.checksumErrors }}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Properties section -->
    <div class="pool-detail-section">
      <h3>Properties</h3>
      <div class="properties-grid">
        <div class="prop-row">
          <span class="prop-name">ashift</span>
          <span class="prop-value">{{ pool.properties.ashift }}</span>
        </div>
        <div class="prop-row">
          <span class="prop-name">autoexpand</span>
          <span class="prop-value">{{ pool.properties.autoexpand ? 'on' : 'off' }}</span>
        </div>
        <div class="prop-row">
          <span class="prop-name">autoreplace</span>
          <span class="prop-value">{{ pool.properties.autoreplace ? 'on' : 'off' }}</span>
        </div>
        <div class="prop-row">
          <span class="prop-name">autotrim</span>
          <span class="prop-value">{{ pool.properties.autotrim ? 'on' : 'off' }}</span>
        </div>
        <div class="prop-row">
          <span class="prop-name">failmode</span>
          <span class="prop-value">{{ pool.properties.failmode }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pool-detail {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}

.pool-detail-header {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.pool-detail-name {
  font-size: 1.25rem;
  font-weight: 700;
  color: var(--p-text-color);
}

.pool-detail-health {
  color: var(--p-yellow-400);
  font-size: 0.85rem;
}

.pool-detail-summary {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 1rem;
  background: var(--p-surface-700);
  border-radius: 6px;
  padding: 0.75rem 1rem;
}

.summary-item {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}

.summary-label {
  font-size: 0.75rem;
  color: var(--p-text-muted-color);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.summary-value {
  font-size: 0.95rem;
  font-weight: 600;
  color: var(--p-text-color);
}

.summary-pct {
  color: var(--p-text-muted-color);
  font-weight: 400;
  margin-left: 0.25rem;
}

.pool-detail-section h3 {
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--p-text-color);
  margin: 0 0 0.5rem;
  border-bottom: 1px solid var(--p-surface-600);
  padding-bottom: 0.25rem;
}

.scan-info {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.scan-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.85rem;
}

.scan-progress-row {
  gap: 0.75rem;
}

.scan-label {
  color: var(--p-text-muted-color);
  min-width: 5rem;
}

.no-data {
  color: var(--p-text-muted-color);
  font-size: 0.85rem;
  font-style: italic;
}

.vdev-group {
  margin-bottom: 0.75rem;
}

.vdev-group-role {
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--p-text-color);
  margin: 0 0 0.35rem;
}

.vdev-item {
  margin-left: 0.75rem;
  margin-bottom: 0.5rem;
}

.vdev-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.85rem;
  padding: 0.2rem 0;
}

.vdev-name {
  font-weight: 500;
  color: var(--p-text-color);
}

.vdev-type-tag {
  font-size: 0.7rem;
}

.vdev-disks {
  margin-left: 1.25rem;
}

.disk-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.8rem;
  padding: 0.15rem 0;
}

.disk-id {
  color: var(--p-text-color);
  font-family: monospace;
  font-size: 0.8rem;
}

.disk-errors {
  color: var(--p-text-muted-color);
  font-family: monospace;
  font-size: 0.75rem;
}

.disk-errors.has-errors {
  color: var(--p-red-400);
  font-weight: 600;
}

.error-count {
  color: var(--p-red-400);
  font-weight: 600;
}

.properties-grid {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 0.25rem 1.5rem;
  font-size: 0.85rem;
}

.prop-row {
  display: contents;
}

.prop-name {
  color: var(--p-text-muted-color);
  font-family: monospace;
}

.prop-value {
  color: var(--p-text-color);
}
</style>
