export default defineEventHandler(async (event) => {
  const user = event.context.user as { name: string; uid: number } | undefined

  if (!user) {
    throw createError({
      statusCode: 401,
      message: 'Not authenticated',
    })
  }

  return { user }
})
