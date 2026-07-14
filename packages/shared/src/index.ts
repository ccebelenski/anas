// @anas/shared — shared types, schemas, and validators

export const VERSION = '0.1.0'

// Access / permissions schemas (layered editor — Epic 4.7.2)
export {
  AccessEntry,
  AccessLevel,
  DatasetAccess,
  SetAccessRequest,
} from './schemas/access.js'

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

// Identity schemas (share users & groups — Epic 8)
export {
  CreateGroupRequest,
  CreateShareUserRequest,
  IdentityName,
  LookupName,
  SetSmbPasswordRequest,
  SetUserEnabledRequest,
  ShareGroup,
  ShareUser,
  SystemGroup,
  SystemUser,
  UpdateGroupMembersRequest,
} from './schemas/identity.js'

// Job schemas
export {
  Job,
  JobAccepted,
  JobDetail,
  JobList,
  JobRef,
  JobStatus,
} from './schemas/jobs.js'

// Share schemas (SMB + NFS)
export {
  CreateNfsExportRequest,
  CreateSmbShareRequest,
  NfsClient,
  NfsExport,
  ShareEntry,
  SmbConnection,
  SmbGlobalConfig,
  SmbShare,
  SmbShareDetail,
  UpdateNfsExportRequest,
  UpdateSmbGlobalConfigRequest,
  UpdateSmbShareRequest,
} from './schemas/shares.js'

// Snapshot schemas
export {
  CreateSnapshotRequest,
  RenameSnapshotRequest,
  Snapshot,
} from './schemas/snapshots.js'

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
