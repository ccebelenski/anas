import { anasdGet } from '../../utils/anasd'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  return anasdGet(event, `/v1/disks/${id}`)
})
