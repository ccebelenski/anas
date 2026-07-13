/**
 * Initialise embedded display mode once at app start (story 13.2).
 *
 * Reads `embedded=1` from the initial route query and latches it into shared
 * state. Because the value lives in `useState` rather than being re-derived per
 * route, it persists across all subsequent in-app navigation.
 */
export default defineNuxtPlugin(() => {
  const route = useRoute()
  const embedded = useEmbedded()
  if (route.query.embedded === '1') {
    embedded.value = true
  }
})
