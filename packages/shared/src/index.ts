// @anas/shared — shared types, schemas, and validators

export const VERSION = '0.1.3'

// Access / permissions schemas (layered editor — Epic 4.7.2)
export {
  AccessEntry,
  AccessLevel,
  DatasetAccess,
  SetAccessRequest,
} from './schemas/access.js'

// AHR schemas (Epic 11 + AHR — ANAS Hybrid RAID)
export {
  AhrArray,
  AhrArrayMember,
  AhrArraySync,
  AhrCapacity,
  AhrCreateRequest,
  AhrDisk,
  AhrDiskPartition,
  AhrDiskRole,
  AhrExpansionIntent,
  AhrExpansionState,
  AhrExpansionStep,
  AhrExpansionStepKind,
  AhrExpansionTrigger,
  AhrLayoutPreview,
  AhrLayoutPreviewRequest,
  AhrMemberState,
  AhrPool,
  AhrPoolState,
  AhrPreviewBand,
  AhrStepStatus,
  AhrSyncAction,
  AhrType,
  ArrayLevel,
  ArrayState,
} from './schemas/ahr.js'

// API envelope schemas
export {
  ApiError,
  ConfirmHeader,
  dataResponse,
  ErrorCode,
  RequestHeaders,
} from './schemas/api.js'

// Backup schemas (Epic 16 — PBS file backup)
export {
  BackupArchive,
  BackupAuthType,
  BackupName,
  BackupRecentRun,
  BackupRepo,
  BackupRepoRef,
  BackupRepoRegistry,
  BackupRepoResponse,
  BackupRepoSource,
  BackupRepoTestRequest,
  BackupRepoTestResult,
  BackupRepoWrite,
  BackupRunRequest,
  BackupRunResult,
  BackupTask,
  BackupTaskDetail,
  BackupTaskEntry,
  BackupTaskRequest,
  BackupTaskView,
  ChangeDetectionMode,
  PVE_REPO_PREFIX,
  UpsertBackupRepoRequest,
} from './schemas/backup.js'

// Common validators
export {
  AbsolutePath,
  DatasetPath,
  DevicePath,
  DiskId,
  hasControlChars,
  ISODateTime,
  PoolName,
  ShareName,
  SingleLine,
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

// Filesystem browse (read-only UI support — Epic 16.9)
export {
  FsBrowseQuery,
  FsBrowseResult,
  FsEntryType,
} from './schemas/fs.js'

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
  MountMode,
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
  MountVers,
  UpdateMountRequest,
} from './schemas/mounts.js'

// Replication schemas (Epic 5.5)
export {
  RemotesFile,
  RemoteTestResult,
  ReplicatePlan,
  ReplicatePlanRequest,
  ReplicateRequest,
  ReplicationLocation,
  ReplicationRemote,
  ReplicationTarget,
  ReplicationTask,
  ReplicationTaskName,
  ReplicationTaskStatus,
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
