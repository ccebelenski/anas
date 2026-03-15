// @anas/shared — shared types, schemas, and validators

export const VERSION = '0.1.0'

// API envelope schemas
export {
  dataResponse,
  ErrorCode,
  ApiError,
  RequestHeaders,
  ConfirmHeader,
} from './schemas/api'

// Job schemas
export {
  JobStatus,
  JobRef,
  JobAccepted,
  Job,
  JobList,
  JobDetail,
} from './schemas/jobs'

// Common validators
export {
  PoolName,
  DatasetPath,
  SnapshotName,
  ShareName,
  AbsolutePath,
  DevicePath,
  ISODateTime,
  UUID,
} from './schemas/common'
