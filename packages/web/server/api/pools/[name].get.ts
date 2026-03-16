import { anasdGet } from '../../utils/anasd'

export default defineEventHandler(async (event) => {
  const name = getRouterParam(event, 'name')
  return anasdGet(event, `/v1/pools/${name}`)
})
