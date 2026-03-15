<template>
  <div class="p-dark">
    <NuxtRouteAnnouncer />
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
  </div>
</template>

<style>
/* Reset and base styles */
*,
*::before,
*::after {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

html {
  font-family: var(--p-font-family);
  color: var(--p-text-color);
  background: var(--p-surface-950);
}

body {
  min-height: 100vh;
}
</style>
