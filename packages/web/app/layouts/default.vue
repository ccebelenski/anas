<script setup lang="ts">
const sidebarItems = [
  {
    label: 'Dashboard',
    icon: 'pi pi-home',
    to: '/',
  },
  {
    label: 'Storage',
    icon: 'pi pi-database',
    items: [
      { label: 'Pools', icon: 'pi pi-server', to: '/storage/pools' },
      { label: 'Disks', icon: 'pi pi-circle', to: '/storage/disks' },
    ],
  },
  {
    label: 'Shares',
    icon: 'pi pi-share-alt',
    items: [
      { label: 'SMB', icon: 'pi pi-folder', to: '/shares/smb' },
      { label: 'NFS', icon: 'pi pi-folder-open', to: '/shares/nfs' },
    ],
  },
  {
    label: 'Users & Groups',
    icon: 'pi pi-users',
    to: '/users',
  },
  {
    label: 'Jobs',
    icon: 'pi pi-list-check',
    to: '/jobs',
  },
]
</script>

<template>
  <div class="app-layout">
    <aside class="app-sidebar">
      <div class="app-sidebar-header">
        <h2>ANAS</h2>
      </div>
      <Menu :model="sidebarItems" class="app-sidebar-menu" />
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

.app-sidebar-menu {
  flex: 1;
  border: none;
  border-radius: 0;
  background: transparent;
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
