<script setup lang="ts">
const showPools = ref(false)
const showDisks = ref(false)
const showSmb = ref(false)
const showNfs = ref(false)
const showUsers = ref(false)
const showJobs = ref(false)

interface SidebarItem {
  label: string
  icon: string
  action?: () => void
  children?: SidebarItem[]
}

const sidebarItems: SidebarItem[] = [
  {
    label: 'Dashboard',
    icon: 'pi pi-home',
    action: () => navigateTo('/'),
  },
  {
    label: 'Storage',
    icon: 'pi pi-database',
    children: [
      { label: 'Pools', icon: 'pi pi-server', action: () => { showPools.value = true } },
      { label: 'Disks', icon: 'pi pi-circle', action: () => { showDisks.value = true } },
    ],
  },
  {
    label: 'Shares',
    icon: 'pi pi-share-alt',
    children: [
      { label: 'SMB', icon: 'pi pi-folder', action: () => { showSmb.value = true } },
      { label: 'NFS', icon: 'pi pi-folder-open', action: () => { showNfs.value = true } },
    ],
  },
  {
    label: 'Users & Groups',
    icon: 'pi pi-users',
    action: () => { showUsers.value = true },
  },
  {
    label: 'Jobs',
    icon: 'pi pi-list-check',
    action: () => { showJobs.value = true },
  },
]
</script>

<template>
  <div class="app-layout">
    <aside class="app-sidebar">
      <div class="app-sidebar-header">
        <h2>ANAS</h2>
      </div>
      <nav class="app-nav">
        <template v-for="item in sidebarItems" :key="item.label">
          <button v-if="!item.children" class="nav-item" @click="item.action?.()">
            <i :class="item.icon" />
            <span>{{ item.label }}</span>
          </button>
          <div v-else class="nav-group">
            <div class="nav-group-label">
              <i :class="item.icon" />
              <span>{{ item.label }}</span>
            </div>
            <button
              v-for="child in item.children"
              :key="child.label"
              class="nav-item nav-child"
              @click="child.action?.()"
            >
              <i :class="child.icon" />
              <span>{{ child.label }}</span>
            </button>
          </div>
        </template>
      </nav>
    </aside>

    <div class="app-main">
      <header class="app-header">
        <div class="app-header-title">
          <slot name="header" />
        </div>
      </header>

      <main class="app-content">
        <slot />
      </main>
    </div>

    <!-- Floating panels — self-contained, fetch their own data -->
    <StoragePoolListPanel v-model:visible="showPools" />
    <StorageDiskListPanel v-model:visible="showDisks" />

    <!-- Placeholders for future panels -->
    <FloatingPanel v-model:visible="showSmb" title="SMB Shares">
      <p style="color: var(--p-text-muted-color);">SMB shares coming soon.</p>
    </FloatingPanel>
    <FloatingPanel v-model:visible="showNfs" title="NFS Exports">
      <p style="color: var(--p-text-muted-color);">NFS exports coming soon.</p>
    </FloatingPanel>
    <FloatingPanel v-model:visible="showUsers" title="Users & Groups">
      <p style="color: var(--p-text-muted-color);">User management coming soon.</p>
    </FloatingPanel>
    <FloatingPanel v-model:visible="showJobs" title="Jobs">
      <p style="color: var(--p-text-muted-color);">Job history coming soon.</p>
    </FloatingPanel>
  </div>
</template>

<style scoped>
.app-layout {
  display: flex;
  min-height: 100vh;
}

.app-sidebar {
  width: 240px;
  flex-shrink: 0;
  background: var(--p-surface-800);
  border-right: 1px solid var(--p-surface-700);
  display: flex;
  flex-direction: column;
}

.app-sidebar-header {
  padding: 1rem 1.25rem;
  border-bottom: 1px solid var(--p-surface-700);
}

.app-sidebar-header h2 {
  margin: 0;
  font-size: 1.25rem;
  font-weight: 600;
  color: var(--p-text-color);
  letter-spacing: 0.05em;
}

.app-nav {
  flex: 1;
  padding: 0.5rem 0;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  width: 100%;
  padding: 0.6rem 1.25rem;
  background: none;
  border: none;
  color: var(--p-text-color);
  font-size: 0.9rem;
  cursor: pointer;
  text-align: left;
  font-family: inherit;
}

.nav-item:hover {
  background: var(--p-surface-700);
}

.nav-child {
  padding-left: 2.5rem;
  font-size: 0.85rem;
}

.nav-group-label {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.6rem 1.25rem;
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--p-text-muted-color);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin-top: 0.5rem;
}

.app-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.app-header {
  padding: 0.75rem 1.5rem;
  border-bottom: 1px solid var(--p-surface-700);
  background: var(--p-surface-900);
}

.app-header-title {
  font-size: 1.125rem;
  font-weight: 500;
  color: var(--p-text-color);
}

.app-content {
  flex: 1;
  padding: 1.5rem;
  background: var(--p-surface-950);
}
</style>
