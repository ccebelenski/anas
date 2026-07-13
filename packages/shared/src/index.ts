// @anas/shared — shared types, schemas, and validators

export const VERSION = '0.1.0'

// API envelope schemas
export {
  ApiError,
  ConfirmHeader,
  dataResponse,
  ErrorCode,
  RequestHeaders,
} from './schemas/api.js'

// Common validators
export {
  AbsolutePath,
  DatasetPath,
  DevicePath,
  DiskId,
  ISODateTime,
  PoolName,
  ShareName,
  SnapshotName,
  UUID,
} from './schemas/common.js'

// Dataset schemas
export {
  CreateDatasetRequest,
  Dataset,
  DatasetDetail,
  DatasetProperties,
  DatasetType,
  MountpointPermissions,
  SetPermissionsRequest,
  SystemGroup,
  SystemUser,
  UpdateDatasetPropertiesRequest,
} from './schemas/datasets.js'

// Disk schemas
export {
  Disk,
  DiskHealthStatus,
  DiskPartition,
  DiskUsageStatus,
  SmartAttribute,
  SmartData,
  SmartHealth,
} from './schemas/disks.js'

// Job schemas
export {
  Job,
  JobAccepted,
  JobDetail,
  JobList,
  JobRef,
  JobStatus,
} from './schemas/jobs.js'

// ZFS schemas
export {
  AddVdevRequest,
  AttachDiskRequest,
  CreatePoolRequest,
  ExportPoolRequest,
  ImportPoolRequest,
  PoolDetail,
  PoolDisk,
  PoolHealthMessage,
  PoolProperties,
  PoolState,
  PoolSummary,
  ScanFunction,
  ScanState,
  ScanStatus,
  ScrubRequest,
  UpdatePoolPropertiesRequest,
  Vdev,
  VdevGroup,
  VdevRole,
  VdevSpec,
  VdevState,
  VdevType,
} from './schemas/zfs.js'
