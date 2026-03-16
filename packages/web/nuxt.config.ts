import Lara from '@primeuix/themes/lara'

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
      theme: {
        preset: Lara,
        options: {
          darkModeSelector: '.p-dark',
          cssLayer: false,
        },
      },
    },
  },
})
