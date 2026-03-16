<script setup lang="ts">
import type { Disk, PoolDetail, PoolDisk, Vdev, VdevGroup } from '@anas/shared'
import { formatBytes } from '~/utils/format'

const props = defineProps<{
  pool: PoolDetail
}>()

// Fetch disk info for cross-referencing (fire-and-forget, non-blocking)
const diskMap = ref<Map<string, Disk>>(new Map())
onMounted(async () => {
  try {
    const res = await $fetch<{ data: Disk[] }>('/api/disks')
    const map = new Map<string, Disk>()
    for (const d of res.data) {
      map.set(d.id, d)
    }
    diskMap.value = map
  }
  catch { /* disk info is optional enhancement */ }
})

function getDiskInfo(poolDisk: PoolDisk): Disk | undefined {
  return diskMap.value.get(poolDisk.id)
}

function stateSeverity(state: string): 'success' | 'warn' | 'danger' | 'info' | 'secondary' {
  switch (state) {
    case 'ONLINE': return 'success'
    case 'DEGRADED': return 'warn'
    case 'FAULTED':
    case 'SUSPENDED': return 'danger'
    case 'AVAIL': return 'info'
    case 'INUSE': return 'info'
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

function usageColor(pct: number): string {
  if (pct < 60) return '#a6e3a1'
  if (pct < 80) return '#f9e2af'
  if (pct < 90) return '#fab387'
  return '#f38ba8'
}

/** Describe redundancy for a vdev group */
function redundancyDescription(group: VdevGroup): string {
  if (group.role === 'spare') {
    const avail = group.vdevs[0]?.disks.filter(d => d.state === 'AVAIL').length ?? 0
    const inuse = group.vdevs[0]?.disks.filter(d => d.state === 'INUSE').length ?? 0
    if (inuse > 0) return `${inuse} spare active, ${avail} standing by`
    return `${avail} spare${avail !== 1 ? 's' : ''} standing by`
  }
  if (group.role === 'cache') return 'L2ARC read cache'
  if (group.role === 'log') return 'ZIL write log'
  if (group.role === 'special') return 'Metadata / small blocks'
  if (group.role === 'dedup') return 'Dedup table'

  // Data vdevs — describe redundancy per vdev type
  const vdev = group.vdevs[0]
  if (!vdev) return 'Data'
  const type = vdev.type
  const diskCount = vdev.disks.length
  if (type === 'mirror') return `Mirror — can survive ${diskCount - 1} disk failure${diskCount > 2 ? 's' : ''}`
  if (type === 'raidz') return 'RAIDZ1 — can survive 1 disk failure'
  if (type === 'raidz2') return 'RAIDZ2 — can survive 2 disk failures'
  if (type === 'raidz3') return 'RAIDZ3 — can survive 3 disk failures'
  if (type === 'disk') return 'Stripe — no redundancy'
  return `${type}`
}

const propertyHelp: Record<string, string> = {
  ashift: 'Sector size exponent (2^N bytes). 9=512B, 12=4K, 13=8K. Set at creation, cannot be changed.',
  autoexpand: 'Automatically expand pool when larger disks replace smaller ones.',
  autoreplace: 'Automatically replace a failed disk with a hot spare if available.',
  autotrim: 'Automatically issue TRIM/UNMAP commands to SSDs for freed blocks.',
  failmode: 'Behavior on write failure: wait (block), continue (return errors), panic (halt).',
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

    <!-- Summary stats -->
    <div class="detail-summary">
      <div class="stat" v-tooltip.bottom="'Total raw pool capacity'">
        <div class="stat-value">{{ formatBytes(pool.size) }}</div>
        <div class="stat-label">Size</div>
      </div>
      <div class="stat" v-tooltip.bottom="'Space allocated to data and metadata'">
        <div class="stat-value">{{ formatBytes(pool.allocated) }} <small>({{ pool.capacity }}%)</small></div>
        <div class="stat-label">Used</div>
      </div>
      <div class="stat" v-tooltip.bottom="'Remaining available space'">
        <div class="stat-value">{{ formatBytes(pool.free) }}</div>
        <div class="stat-label">Free</div>
      </div>
      <div class="stat" v-tooltip.bottom="'Free space fragmentation. High values impact write performance.'">
        <div class="stat-value">{{ pool.fragmentation }}%</div>
        <div class="stat-label">Frag</div>
      </div>
      <div class="stat" v-tooltip.bottom="'Deduplication ratio. 1.00x = no dedup savings.'">
        <div class="stat-value">{{ pool.dedupRatio.toFixed(2) }}x</div>
        <div class="stat-label">Dedup</div>
      </div>
    </div>

    <!-- Usage bar -->
    <div class="usage-bar-wrap" v-tooltip.bottom="`${pool.capacity}% used — ${formatBytes(pool.allocated)} of ${formatBytes(pool.size)}`">
      <div class="usage-bar">
        <div class="usage-fill" :style="{ width: Math.max(pool.capacity, 1) + '%', background: usageColor(pool.capacity) }" />
      </div>
      <div class="usage-markers">
        <span>0%</span><span>25%</span><span>50%</span><span>75%</span><span>100%</span>
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
          <span class="kv-key">Examined</span>
          <span>{{ formatBytes(pool.scan.examinedBytes) }} / {{ formatBytes(pool.scan.totalBytes) }}</span>
        </div>
        <div class="kv-row">
          <span class="kv-key">Repaired</span>
          <span>{{ formatBytes(pool.scan.processedBytes) }}</span>
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
        <div v-if="pool.errorDetail" class="error-detail">
          <i class="pi pi-exclamation-circle" />
          {{ pool.errorDetail }}
        </div>
      </div>
      <p v-else class="text-muted">No scan history</p>
    </section>

    <!-- Topology -->
    <section class="detail-section">
      <h3>Topology</h3>
      <div v-for="group in pool.vdevGroups" :key="group.role" class="topo-group">
        <div class="topo-group-header">
          <span class="topo-redundancy">{{ redundancyDescription(group) }}</span>
          <Tag v-if="group.role !== 'data'" :value="group.role" severity="secondary" />
        </div>
        <div v-for="vdev in group.vdevs" :key="vdev.name" class="topo-vdev">
          <div class="topo-vdev-header">
            <span class="topo-vdev-name">{{ vdev.name }}</span>
            <Tag :value="vdev.type" severity="secondary" />
            <Tag :value="vdev.state" :severity="stateSeverity(vdev.state)" />
          </div>
          <div class="topo-disks">
            <div
              v-for="disk in vdev.disks"
              :key="disk.id"
              class="topo-disk"
              :class="{ 'has-errors': hasErrors(disk) }"
            >
              <div class="topo-disk-main">
                <Tag :value="disk.state" :severity="stateSeverity(disk.state)" />
                <span class="topo-disk-id">{{ disk.id }}</span>
                <span class="topo-disk-errors" v-tooltip.right="'Read / Write / Checksum errors'">
                  R:{{ disk.readErrors }} W:{{ disk.writeErrors }} C:{{ disk.checksumErrors }}
                </span>
              </div>
              <div v-if="getDiskInfo(disk)" class="topo-disk-info">
                <span>/dev/{{ getDiskInfo(disk)!.name }}</span>
                <span>{{ getDiskInfo(disk)!.model ?? '' }}</span>
                <span>{{ formatBytes(getDiskInfo(disk)!.size) }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- Properties (compact inline) -->
    <section class="detail-section">
      <h3>Properties</h3>
      <div class="props-inline">
        <span v-for="(value, key) in {
          ashift: pool.properties.ashift,
          autoexpand: pool.properties.autoexpand ? 'on' : 'off',
          autoreplace: pool.properties.autoreplace ? 'on' : 'off',
          autotrim: pool.properties.autotrim ? 'on' : 'off',
          failmode: pool.properties.failmode,
        }" :key="key" class="prop-chip" v-tooltip.top="propertyHelp[key]">
          <span class="prop-name">{{ key }}</span>
          <span class="prop-val">{{ value }}</span>
        </span>
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
  color: #f9e2af;
  font-size: 0.85rem;
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.detail-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 1.5rem;
  padding: 0.75rem 1rem;
  background: #181825;
  border-radius: 6px 6px 0 0;
  border: 1px solid #313244;
  border-bottom: none;
}

.stat { min-width: 5rem; cursor: help; }
.stat-value { font-size: 1rem; font-weight: 600; }
.stat-value small { font-weight: 400; color: #bac2de; }
.stat-label { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.05em; color: #bac2de; margin-top: 0.1rem; }

.usage-bar-wrap { cursor: help; }
.usage-bar {
  height: 12px;
  background: #313244;
  border-radius: 0 0 6px 6px;
  overflow: hidden;
  border: 1px solid #313244;
  border-top: none;
}
.usage-fill { height: 100%; border-radius: 0 0 0 6px; transition: width 0.3s ease; }
.usage-markers { display: flex; justify-content: space-between; font-size: 0.6rem; color: #6c7086; padding: 0.15rem 0.1rem 0; }

/* Sections */
.detail-section h3 {
  font-size: 0.85rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #bac2de;
  margin: 0 0 0.5rem;
  padding-bottom: 0.25rem;
  border-bottom: 1px solid #313244;
}

.kv-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.2rem 0;
  font-size: 0.85rem;
}

.kv-key {
  color: #bac2de;
  min-width: 5.5rem;
  cursor: help;
}

/* Topology */
.topo-group {
  margin-bottom: 1rem;
}

.topo-group-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
}

.topo-redundancy {
  font-size: 0.85rem;
  font-weight: 600;
  color: #cdd6f4;
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
  padding: 0.2rem 0;
}

.topo-vdev-name {
  font-weight: 500;
}

.topo-disks {
  margin-left: 1rem;
}

.topo-disk {
  padding: 0.25rem 0;
  border-bottom: 1px solid rgba(49, 50, 68, 0.5);
}

.topo-disk:last-child {
  border-bottom: none;
}

.topo-disk-main {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.8rem;
}

.topo-disk-id {
  font-size: 0.8rem;
}

.topo-disk-errors {
  color: #bac2de;
  font-size: 0.75rem;
  cursor: help;
  margin-left: auto;
}

.topo-disk.has-errors .topo-disk-errors {
  color: #f38ba8;
  font-weight: 600;
}

.topo-disk-info {
  display: flex;
  gap: 1rem;
  margin-left: 2rem;
  margin-top: 0.1rem;
  font-size: 0.75rem;
  color: #6c7086;
}

/* Properties — compact inline chips */
.props-inline {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
}

.prop-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.2rem 0.5rem;
  background: #181825;
  border: 1px solid #313244;
  border-radius: 4px;
  font-size: 0.78rem;
  cursor: help;
}

.prop-name {
  color: #bac2de;
}

.prop-val {
  color: #cdd6f4;
  font-weight: 600;
}

.error-detail {
  margin-top: 0.35rem;
  padding: 0.5rem 0.75rem;
  background: rgba(243, 139, 168, 0.1);
  border: 1px solid rgba(243, 139, 168, 0.3);
  border-radius: 4px;
  color: #f38ba8;
  font-size: 0.8rem;
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  white-space: pre-wrap;
}

.text-muted { color: #bac2de; font-style: italic; font-size: 0.85rem; }
.text-error { color: #f38ba8; font-weight: 600; }
</style>
