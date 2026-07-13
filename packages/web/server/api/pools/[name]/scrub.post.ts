import { PoolName, ScrubRequest } from '@anas/shared'
import { anasdPost } from '../../../utils/anasd'

export default defineEventHandler(async (event) => {
  const name = getRouterParam(event, 'name')
  const nameParsed = PoolName.safeParse(name)
  if (!nameParsed.success) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid pool name' })
  }

  const body = await readBody(event).catch(() => undefined)
  const bodyParsed = ScrubRequest.safeParse(body ?? {})
  if (!bodyParsed.success) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid scrub request' })
  }

  const res = await anasdPost(event, `/v1/pools/${nameParsed.data}/scrub`, bodyParsed.data)
  setResponseStatus(event, res.status)
  return res.data
})
