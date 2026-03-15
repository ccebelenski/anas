// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: true },

  modules: [
    '@primevue/nuxt-module',
    '@pinia/nuxt',
  ],

  primevue: {
    options: {
      theme: 'none', // We'll configure the Lara Dark theme via CSS
    },
  },
})
