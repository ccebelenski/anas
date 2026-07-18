// @anas/shared — shared types, schemas, and validators

export const VERSION = '0.1.2'

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

// Dashboard schemas (Epic 2)
export {
  ArcTelemetry,
  DashboardWarning,
  DiskHealthCounts,
  DiskTelemetry,
  IoStats,
  JobBrief,
  NetInterface,
  NetTelemetry,
  PoolStatusBrief,
  PoolTelemetry,
  ShareStatusBrief,
  StatusSummary,
  Telemetry,
  VdevTelemetry,
} from './schemas/dashboard.js'

// Dataset schemas
export {
  AssociatedShare,
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

// Mount schemas (Epic 18 — external & local storage)
export {
  CreateMountRequest,
  MountCapacity,
  MountCifsOptions,
  MountCommonOptions,
  MountCredentials,
  MountCredentialsInfo,
  MountDetail,
  MountEntry,
  MountHealth,
  MountKind,
  MountNfsOptions,
  MountOptions,
  MountRequestOptions,
  MountState,
  MountStateRequest,
  MountSummary,
  MountTestRequest,
  MountTestResult,
  MountTestVerdict,
  MountType,
  MountUnit,
  UpdateMountRequest,
} from './schemas/mounts.js'

// Replication schemas (Epic 5.5)
export {
  ReplicatePlan,
  ReplicatePlanRequest,
  ReplicateRequest,
  ReplicationLocation,
  ReplicationRemote,
  ReplicationTarget,
  ReplicationTask,
  ReplicationTaskName,
  ReplicationTaskStatus,
  RemotesFile,
  RemoteTestResult,
  UpsertRemoteRequest,
} from './schemas/replication.js'

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
  CloneSnapshotRequest,
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
  PveStorageRef,
  ScanFunction,
  ScanState,
  ScanStatus,
  ScrubRequest,
  TrimPoolRequest,
  UpdatePoolPropertiesRequest,
  Vdev,
  VdevGroup,
  VdevRole,
  VdevSpec,
  VdevState,
  VdevType,
} from './schemas/zfs.js'
