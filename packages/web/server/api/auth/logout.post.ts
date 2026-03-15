export default defineEventHandler(async (event) => {
  deleteCookie(event, 'anas-token', {
    httpOnly: true,
    secure: !import.meta.dev,
    sameSite: 'strict',
    path: '/',
  })

  return { ok: true }
})
