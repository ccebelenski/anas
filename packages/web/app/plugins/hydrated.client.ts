/**
 * Stamp the root element once Vue has hydrated and attached listeners.
 * Tests wait for `html[data-hydrated]` before interacting — clicking
 * server-rendered DOM before hydration hits dead event handlers.
 */
export default defineNuxtPlugin((nuxtApp) => {
  nuxtApp.hook('app:mounted', () => {
    document.documentElement.setAttribute('data-hydrated', '')
  })
})
