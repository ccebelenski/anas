import { UUID } from '@anas/shared'
import { anasdGet } from '../../utils/anasd'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  const parsed = UUID.safeParse(id)
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid job id' })
  }
  return anasdGet(event, `/v1/jobs/${parsed.data}`)
})
