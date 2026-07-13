<script setup lang="ts">
const showPools = ref(false)
const showDisks = ref(false)
const showSmb = ref(false)
const showNfs = ref(false)
const showUsers = ref(false)
const showJobs = ref(false)
</script>

<template>
  <div class="app-layout">
    <ClientOnly>
      <aside class="app-sidebar" data-region="sidebar">
        <div class="app-sidebar-header">
          <h2>ANAS</h2>
        </div>
        <nav class="app-nav">
          <button data-nav="dashboard" class="nav-item" @click="navigateTo('/')">
            <i class="pi pi-home" /><span>Dashboard</span>
          </button>

          <div class="nav-group">
            <div class="nav-group-label">
              <i class="pi pi-database" /><span>Storage</span>
            </div>
            <button data-nav="pools" class="nav-item nav-child" @click="showPools = true">
              <i class="pi pi-server" /><span>Pools</span>
            </button>
            <button data-nav="disks" class="nav-item nav-child" @click="showDisks = true">
              <i class="pi pi-circle" /><span>Disks</span>
            </button>
          </div>

          <div class="nav-group">
            <div class="nav-group-label">
              <i class="pi pi-share-alt" /><span>Shares</span>
            </div>
            <button data-nav="smb" class="nav-item nav-child" @click="showSmb = true">
              <i class="pi pi-folder" /><span>SMB</span>
            </button>
            <button data-nav="nfs" class="nav-item nav-child" @click="showNfs = true">
              <i class="pi pi-folder-open" /><span>NFS</span>
            </button>
          </div>

          <button data-nav="users" class="nav-item" @click="showUsers = true">
            <i class="pi pi-users" /><span>Users & Groups</span>
          </button>
          <button data-nav="jobs" class="nav-item" @click="showJobs = true">
            <i class="pi pi-list-check" /><span>Jobs</span>
          </button>
        </nav>
      </aside>
    </ClientOnly>

    <div class="app-main">
      <header class="app-header">
        <div class="app-header-title">
          <slot name="header" />
        </div>
      </header>

      <main class="app-content" data-region="content">
        <slot />
      </main>
    </div>

    <!-- Floating panels — self-contained, fetch their own data -->
    <StoragePoolListPanel v-model:visible="showPools" />
    <StorageDiskListPanel v-model:visible="showDisks" />

    <!-- Placeholders for future panels -->
    <FloatingPanel v-model:visible="showSmb" panel-id="smb" title="SMB Shares">
      <p style="opacity: 0.5;">
        SMB shares coming soon.
      </p>
    </FloatingPanel>
    <FloatingPanel v-model:visible="showNfs" panel-id="nfs" title="NFS Exports">
      <p style="opacity: 0.5;">
        NFS exports coming soon.
      </p>
    </FloatingPanel>
    <FloatingPanel v-model:visible="showUsers" panel-id="users" title="Users & Groups">
      <p style="opacity: 0.5;">
        User management coming soon.
      </p>
    </FloatingPanel>
    <FloatingPanel v-model:visible="showJobs" panel-id="jobs" title="Jobs">
      <p style="opacity: 0.5;">
        Job history coming soon.
      </p>
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
