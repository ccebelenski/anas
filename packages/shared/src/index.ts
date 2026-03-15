// @anas/shared — shared types, schemas, and validators

export const VERSION = '0.1.0'

// API envelope schemas
export {
  ApiError,
  ConfirmHeader,
  dataResponse,
  ErrorCode,
  RequestHeaders,
} from './schemas/api'

// Common validators
export {
  AbsolutePath,
  DatasetPath,
  DevicePath,
  ISODateTime,
  PoolName,
  ShareName,
  SnapshotName,
  UUID,
} from './schemas/common'

// Job schemas
export {
  Job,
  JobAccepted,
  JobDetail,
  JobList,
  JobRef,
  JobStatus,
} from './schemas/jobs'
