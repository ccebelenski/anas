import { anasdGet } from '../utils/anasd'

export default defineEventHandler(async (event) => {
  return anasdGet(event, '/v1/pools')
})
