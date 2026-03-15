import { getAuthProvider, signToken } from '../../auth'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ username?: string; password?: string }>(event)

  if (!body?.username || !body?.password) {
    throw createError({
      statusCode: 400,
      message: 'Username and password are required',
    })
  }

  const provider = await getAuthProvider()
  const user = await provider.authenticate({
    username: body.username,
    password: body.password,
  })

  if (!user) {
    throw createError({
      statusCode: 401,
      message: 'Invalid credentials',
    })
  }

  // Issue JWT as httpOnly secure cookie
  const token = await signToken(user)
  setCookie(event, 'anas-token', token, {
    httpOnly: true,
    secure: !import.meta.dev,
    sameSite: 'strict',
    path: '/',
  })

  return { user: { name: user.name, uid: user.uid } }
})
