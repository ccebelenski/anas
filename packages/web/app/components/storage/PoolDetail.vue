<script setup lang="ts">
import type { PoolDetail, PoolDisk } from '@anas/shared'
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

function hasErrors(disk: PoolDisk): boolean {
  return disk.readErrors > 0 || disk.writeErrors > 0 || disk.checksumErrors > 0
}

function formatDate(iso: string | null): string {
  if (!iso) return '-'
  return new Date(iso).toLocaleString()
}
</script>

<template>
  <div class="pool-detail">
    <!-- Header -->
    <div class="detail-header">
      <span class="detail-name">{{ pool.name }}</span>
      <Tag :value="pool.state" :severity="stateSeverity(pool.state)" />
    </div>

    <div v-if="pool.health" class="detail-health">
      <i class="pi pi-exclamation-triangle" />
      {{ pool.health.status }}
    </div>

    <!-- Summary -->
    <div class="detail-summary">
      <div class="stat">
        <div class="stat-value">{{ formatBytes(pool.size) }}</div>
        <div class="stat-label">Size</div>
      </div>
      <div class="stat">
        <div class="stat-value">{{ formatBytes(pool.allocated) }} <small>({{ pool.capacity }}%)</small></div>
        <div class="stat-label">Used</div>
      </div>
      <div class="stat">
        <div class="stat-value">{{ formatBytes(pool.free) }}</div>
        <div class="stat-label">Free</div>
      </div>
      <div class="stat">
        <div class="stat-value">{{ pool.fragmentation }}%</div>
        <div class="stat-label">Frag</div>
      </div>
      <div class="stat">
        <div class="stat-value">{{ pool.dedupRatio.toFixed(2) }}x</div>
        <div class="stat-label">Dedup</div>
      </div>
    </div>

    <!-- Scan -->
    <section class="detail-section">
      <h3>Scan</h3>
      <div v-if="pool.scan">
        <div class="kv-row">
          <span class="kv-key">Type</span>
          <span>{{ pool.scan.function === 'SCRUB' ? 'Scrub' : 'Resilver' }}</span>
        </div>
        <div class="kv-row">
          <span class="kv-key">State</span>
          <Tag
            :value="pool.scan.state === 'SCANNING' ? 'In Progress' : pool.scan.state === 'FINISHED' ? 'Completed' : pool.scan.state"
            :severity="pool.scan.state === 'SCANNING' ? 'info' : pool.scan.state === 'FINISHED' ? 'success' : 'secondary'"
          />
        </div>
        <div v-if="pool.scan.state === 'SCANNING'" class="kv-row">
          <span class="kv-key">Progress</span>
          <ProgressBar :value="pool.scan.percentComplete" :show-value="true" style="flex: 1; height: 1.25rem;" />
        </div>
        <div class="kv-row">
          <span class="kv-key">Started</span>
          <span>{{ formatDate(pool.scan.startedAt) }}</span>
        </div>
        <div v-if="pool.scan.finishedAt" class="kv-row">
          <span class="kv-key">Finished</span>
          <span>{{ formatDate(pool.scan.finishedAt) }}</span>
        </div>
        <div class="kv-row">
          <span class="kv-key">Errors</span>
          <span :class="pool.scan.errors > 0 ? 'text-error' : ''">{{ pool.scan.errors }}</span>
        </div>
      </div>
      <p v-else class="text-muted">No scan history</p>
    </section>

    <!-- Topology -->
    <section class="detail-section">
      <h3>Topology</h3>
      <div v-for="group in pool.vdevGroups" :key="group.role" class="topo-group">
        <div class="topo-role">{{ group.role }}</div>
        <div v-for="vdev in group.vdevs" :key="vdev.name" class="topo-vdev">
          <div class="topo-vdev-header">
            <span>{{ vdev.name }}</span>
            <Tag :value="vdev.type" severity="secondary" />
            <Tag :value="vdev.state" :severity="stateSeverity(vdev.state)" />
          </div>
          <div v-for="disk in vdev.disks" :key="disk.id" class="topo-disk" :class="{ 'has-errors': hasErrors(disk) }">
            <span class="topo-disk-id">{{ disk.id }}</span>
            <Tag :value="disk.state" :severity="stateSeverity(disk.state)" />
            <span class="topo-disk-errors">
              R:{{ disk.readErrors }} W:{{ disk.writeErrors }} C:{{ disk.checksumErrors }}
            </span>
          </div>
        </div>
      </div>
    </section>

    <!-- Properties -->
    <section class="detail-section">
      <h3>Properties</h3>
      <div class="props-grid">
        <span class="kv-key">ashift</span><span>{{ pool.properties.ashift }}</span>
        <span class="kv-key">autoexpand</span><span>{{ pool.properties.autoexpand ? 'on' : 'off' }}</span>
        <span class="kv-key">autoreplace</span><span>{{ pool.properties.autoreplace ? 'on' : 'off' }}</span>
        <span class="kv-key">autotrim</span><span>{{ pool.properties.autotrim ? 'on' : 'off' }}</span>
        <span class="kv-key">failmode</span><span>{{ pool.properties.failmode }}</span>
      </div>
    </section>
  </div>
</template>

<style scoped>
.pool-detail {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.detail-header {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.detail-name {
  font-size: 1.3rem;
  font-weight: 700;
}

.detail-health {
  color: var(--p-yellow-400);
  font-size: 0.85rem;
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

/* Summary stats row */
.detail-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 1.5rem;
  padding: 0.75rem 1rem;
  background: #181825;
  border-radius: 6px;
  border: 1px solid #313244;
}

.stat {
  min-width: 5rem;
}

.stat-value {
  font-size: 1rem;
  font-weight: 600;
}

.stat-value small {
  font-weight: 400;
  color: #a6adc8;
}

.stat-label {
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #a6adc8;
  margin-top: 0.1rem;
}

/* Sections */
.detail-section h3 {
  font-size: 0.85rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #a6adc8;
  margin: 0 0 0.5rem;
  padding-bottom: 0.25rem;
  border-bottom: 1px solid #313244;
}

/* Key-value rows */
.kv-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.2rem 0;
  font-size: 0.85rem;
}

.kv-key {
  color: #a6adc8;
  min-width: 5rem;
}

/* Topology */
.topo-group {
  margin-bottom: 0.75rem;
}

.topo-role {
  font-size: 0.8rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: #a6adc8;
  margin-bottom: 0.35rem;
}

.topo-vdev {
  margin-left: 0.5rem;
  margin-bottom: 0.5rem;
}

.topo-vdev-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.85rem;
  font-weight: 500;
  padding: 0.2rem 0;
}

.topo-disk {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-left: 1.25rem;
  padding: 0.15rem 0;
  font-size: 0.8rem;
}

.topo-disk-id {
  font-family: var(--p-font-family);
  font-size: 0.8rem;
}

.topo-disk-errors {
  color: #a6adc8;
  font-size: 0.75rem;
}

.topo-disk.has-errors .topo-disk-errors {
  color: var(--p-red-400);
  opacity: 1;
  font-weight: 600;
}

/* Properties grid */
.props-grid {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 0.2rem 1.5rem;
  font-size: 0.85rem;
}

.text-muted { color: #a6adc8; font-style: italic; font-size: 0.85rem; }
.text-error { color: var(--p-red-400); font-weight: 600; }
</style>
